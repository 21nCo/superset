import { describe, expect, it } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import {
  DATAFN_PROTOCOL_ENVELOPE_VERSION,
  DatafnResourceSelectorError,
  extractDatafnResourceSelectors,
  parseDatafnResourceSelectorEnvelope,
  type DatafnSelectorAction,
} from "../src/index.js";

const schema: DatafnSchema = {
  version: 1,
  resources: ["skills", "contexts", "memberships"].map((name) => ({
    name,
    version: 1,
    fields: [],
  })),
  relations: [],
};

const extract = (action: DatafnSelectorAction, payload: unknown) =>
  extractDatafnResourceSelectors(
    { version: DATAFN_PROTOCOL_ENVELOPE_VERSION, action, payload },
    schema,
  );

describe("DataFn protocol resource selectors", () => {
  it.each([
    ["single query", "query", { resource: "skills" }, ["skills"]],
    [
      "batch query",
      "query",
      [
        { resource: "skills" },
        { resource: "contexts" },
        { resource: "skills" },
      ],
      ["skills", "contexts"],
    ],
    [
      "single mutation",
      "mutation",
      { resource: "contexts", operation: "insert" },
      ["contexts"],
    ],
    [
      "batch mutation",
      "mutation",
      [{ resource: "contexts" }, { resource: "memberships" }],
      ["contexts", "memberships"],
    ],
    [
      "wrapped and bare transaction steps",
      "transact",
      {
        steps: [
          { query: { resource: "skills" } },
          { mutation: { resource: "contexts", operation: "insert" } },
          { resource: "memberships", operation: "delete" },
        ],
      },
      ["skills", "contexts", "memberships"],
    ],
    [
      "push mutations",
      "push",
      {
        clientId: "client",
        mutations: [{ resource: "skills" }, { resource: "contexts" }],
      },
      ["skills", "contexts"],
    ],
    [
      "search subset",
      "search",
      { query: "term", resources: ["contexts", "contexts"] },
      ["contexts"],
    ],
    [
      "search default",
      "search",
      { query: "term" },
      ["skills", "contexts", "memberships"],
    ],
    [
      "reconcile",
      "reconcile",
      { clientId: "client", resources: ["memberships"] },
      ["memberships"],
    ],
    [
      "clone subset",
      "clone",
      { clientId: "client", tables: ["skills"] },
      ["skills"],
    ],
    [
      "clone default",
      "clone",
      { clientId: "client" },
      ["skills", "contexts", "memberships"],
    ],
    [
      "pull",
      "pull",
      { clientId: "client" },
      ["skills", "contexts", "memberships"],
    ],
    ["seed", "seed", { clientId: "client" }, []],
    ["status", "status", {}, []],
  ] as const)(
    "extracts selectors for %s",
    (_name, action, payload, expected) => {
      expect(extract(action, payload)).toEqual(expected);
    },
  );

  it("ignores selector-shaped keys in application-owned data", () => {
    expect(
      extract("mutation", {
        resource: "skills",
        operation: "insert",
        record: {
          resource: "contexts",
          resources: ["memberships"],
          nested: { resource: "memberships" },
        },
        context: { resources: ["contexts"] },
      }),
    ).toEqual(["skills"]);

    expect(
      extract("query", {
        resource: "contexts",
        filters: {
          resource: { eq: "skills" },
          payload: { resources: { contains: "memberships" } },
        },
        metadata: { resource: "memberships" },
      }),
    ).toEqual(["contexts"]);
  });

  it("ignores selector-shaped keys beside nested transaction operations", () => {
    expect(
      extract("transact", {
        resource: "memberships",
        steps: [
          {
            mutation: {
              resource: "skills",
              record: { resource: "contexts", resources: ["memberships"] },
            },
            metadata: { resource: "contexts" },
          },
        ],
      }),
    ).toEqual(["skills"]);
  });

  it.each([
    ["missing query selector", "query", {}, "DFQL_INVALID", "payload.resource"],
    [
      "malformed push",
      "push",
      { mutations: {} },
      "DFQL_INVALID",
      "payload.mutations",
    ],
    [
      "malformed resource list",
      "search",
      { resources: ["skills", 42] },
      "DFQL_INVALID",
      "payload.resources[1]",
    ],
    [
      "empty selector",
      "mutation",
      { resource: "  " },
      "DFQL_INVALID",
      "payload.resource",
    ],
    [
      "unknown selector",
      "query",
      { resource: "unknown" },
      "DFQL_UNKNOWN_RESOURCE",
      "payload.resource",
    ],
    [
      "ambiguous transaction step",
      "transact",
      {
        steps: [
          { query: { resource: "skills" }, mutation: { resource: "contexts" } },
        ],
      },
      "DFQL_INVALID",
      "payload.steps[0]",
    ],
  ] as const)(
    "fails explicitly for %s",
    (_name, action, payload, code, path) => {
      try {
        extract(action, payload);
        throw new Error("expected selector extraction to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(DatafnResourceSelectorError);
        expect(error).toMatchObject({ code, path });
      }
    },
  );

  it("rejects unsupported envelope versions", () => {
    expect(() =>
      parseDatafnResourceSelectorEnvelope(
        { version: 2, action: "query", payload: { resource: "skills" } },
        schema,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "DATAFN_UNSUPPORTED_ENVELOPE_VERSION",
        path: "version",
      }),
    );
  });

  it("returns a frozen parsed contract", () => {
    const parsed = parseDatafnResourceSelectorEnvelope(
      { version: 1, action: "query", payload: { resource: "skills" } },
      schema,
    );
    expect(parsed).toEqual({
      version: 1,
      action: "query",
      selectors: ["skills"],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.selectors)).toBe(true);
  });
});
