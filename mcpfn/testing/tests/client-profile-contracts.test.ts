import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { customTarget } from "@mcpfn/client";
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnClientProfile,
} from "@mcpfn/core";

import {
  createMcpFnClientProfileSnapshot,
  diffMcpFnClientProfileSnapshots,
  runMcpFnClientProfileContracts,
  validateMcpFnSchemaPortability,
} from "../src/index.js";

interface Context {
  subject?: string;
  tenantId?: string;
}

function projectedTool(): Tool {
  return {
    name: "lookup",
    description: "Look up a value.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function profile(): McpFnClientProfile<Context> {
  return {
    id: "consumer/trusted",
    version: "1",
    matches: ({ subject }) => subject === "trusted-client",
    serverOwnedArguments: { lookup: ["tenantId"] },
    projectCatalog: ({ tools }) =>
      tools.map((tool) => (tool.name === "lookup" ? projectedTool() : tool)),
    enrichArguments: ({ arguments: args, context }) =>
      context.tenantId ? { ...args, tenantId: context.tenantId } : args,
  };
}

function targetFor(
  context: Context,
  handler = vi.fn(async (args: Record<string, unknown>) =>
    structuredResult(args),
  ),
) {
  return {
    handler,
    target: customTarget({
      kind: "profile-fixture",
      descriptor: { url: "https://server.test/mcp?api_key=target-secret" },
      open: async () => {
        const registry = new McpFnRegistry<Context>().register({
          name: "lookup",
          description: "Look up a value.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              tenantId: { type: "string" },
            },
            required: ["query", "tenantId"],
            additionalProperties: false,
          },
          handler,
        });
        const server = createMcpFnServer({
          info: { name: "profile-target", version: "1.0.0" },
          registry,
          context: () => context,
          clientProfiles: {
            profiles: [profile()],
            resolveVerifiedIdentity: ({ context: trusted }) =>
              trusted.subject ? { subject: trusted.subject } : undefined,
          },
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { transport: clientTransport, close: () => server.close() };
      },
    }),
  };
}

describe("client profile compatibility contracts", () => {
  it("enumerates generic and configured catalogs and replays redacted fixtures", async () => {
    const generic = targetFor({ subject: "generic-client" });
    const trusted = targetFor({
      subject: "trusted-client",
      tenantId: "trusted-secret-tenant",
    });
    const report = await runMcpFnClientProfileContracts({
      profiles: [
        {
          id: "generic",
          version: "canonical",
          target: generic.target,
          fixtures: [
            {
              name: "canonical minimal call",
              tool: "lookup",
              arguments: {
                query: "generic-secret-query",
                tenantId: "model-tenant",
              },
              sideEffect: "read-only",
            },
          ],
        },
        {
          id: "consumer/trusted",
          version: "1",
          target: trusted.target,
          clientInfo: { name: "configured-client", version: "2.0.0" },
          capabilities: { roots: { listChanged: true } },
          expectedSnapshot: createMcpFnClientProfileSnapshot(
            { id: "consumer/trusted", version: "1" },
            [projectedTool()],
          ),
          fixtures: [
            {
              name: "minimal projected call",
              tool: "lookup",
              arguments: { query: "valid-secret-query" },
              sideEffect: "read-only",
            },
            {
              name: "captured unknown root property",
              tool: "lookup",
              arguments: {
                query: "captured-secret-query",
                unexpectedField: "secret-value",
              },
              sideEffect: "read-only",
              source: "captured-failure",
              expect: {
                isError: true,
                errorCode: "MCPFN_INVALID_ARGUMENTS",
                lifecycleStage: "input-validation",
                validationIssue: {
                  instancePath: "/",
                  schemaPath: "#/additionalProperties",
                  keyword: "additionalProperties",
                  rejectedProperty: "unexpectedField",
                },
              },
            },
          ],
        },
      ],
    });

    expect(report).toMatchObject({
      ok: true,
      status: "complete",
      profiles: [
        {
          profile: { id: "consumer/trusted" },
          snapshotMatches: true,
          ok: true,
        },
        { profile: { id: "generic" }, ok: true },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(generic.handler).toHaveBeenCalledTimes(1);
    expect(trusted.handler).toHaveBeenCalledTimes(1);
    expect(trusted.handler).toHaveBeenCalledWith(
      { query: "valid-secret-query", tenantId: "trusted-secret-tenant" },
      expect.objectContaining({ subject: "trusted-client" }),
      expect.anything(),
    );
  });

  it("fails stale snapshots and never runs unauthorized mutating fixtures", async () => {
    const fixture = targetFor({
      subject: "trusted-client",
      tenantId: "tenant",
    });
    const stale = {
      ...createMcpFnClientProfileSnapshot(
        { id: "consumer/trusted", version: "1" },
        [projectedTool()],
      ),
      catalogHash: "0".repeat(64),
    };
    const report = await runMcpFnClientProfileContracts({
      profiles: [
        {
          id: "consumer/trusted",
          version: "1",
          target: fixture.target,
          expectedSnapshot: stale,
          fixtures: [
            {
              name: "unsafe mutation",
              tool: "lookup",
              arguments: { query: "do not run" },
              sideEffect: "non-idempotent",
            },
          ],
        },
      ],
    });
    expect(report).toMatchObject({
      ok: false,
      status: "incomplete",
      profiles: [
        {
          snapshotMatches: false,
          fixtures: [
            { status: "incomplete", code: "side-effect-not-authorized" },
          ],
        },
      ],
    });
    expect(fixture.handler).not.toHaveBeenCalled();
  });

  it("validates recursive schemas with their declared dialect", () => {
    const valid2020 = validateMcpFnSchemaPortability(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        $defs: { value: { type: "string" } },
        properties: { value: { $ref: "#/$defs/value" } },
        unevaluatedProperties: false,
      },
      "tools/modern/inputSchema",
    );
    expect(valid2020).toEqual([
      expect.objectContaining({
        severity: "warning",
        keyword: "unevaluatedProperties",
      }),
    ]);
    expect(
      validateMcpFnSchemaPortability(
        {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          definitions: { value: { type: "string" } },
          properties: { value: { $ref: "#/definitions/value" } },
        },
        "tools/legacy/inputSchema",
      ),
    ).toEqual([]);
    expect(
      validateMcpFnSchemaPortability(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { value: { $ref: "#/$defs/missing" } },
        },
        "tools/broken/inputSchema",
      ),
    ).toEqual([
      expect.objectContaining({ severity: "error", code: "schema-invalid" }),
    ]);
  });

  it("diffs reviewed effective catalog snapshots", () => {
    const before = createMcpFnClientProfileSnapshot(
      { id: "consumer/trusted", version: "1" },
      [projectedTool()],
    );
    const after = createMcpFnClientProfileSnapshot(
      { id: "consumer/trusted", version: "2" },
      [
        { ...projectedTool(), description: "Changed." },
        {
          name: "new-tool",
          description: "New.",
          inputSchema: { type: "object" },
        },
      ],
    );
    expect(diffMcpFnClientProfileSnapshots(before, after)).toMatchObject({
      compatible: true,
      summary: { added: 1, removed: 0, modified: 1 },
    });
    expect(diffMcpFnClientProfileSnapshots(after, before)).toMatchObject({
      compatible: false,
      summary: { added: 0, removed: 1, modified: 1 },
    });
  });

  it("validates report limits before opening targets and isolates connect failures", async () => {
    const open = vi.fn();
    await expect(
      runMcpFnClientProfileContracts({
        maxReportBytes: 100,
        profiles: [
          {
            id: "never-opened",
            version: "1",
            target: customTarget({ kind: "never-opened", open }),
          },
        ],
      }),
    ).rejects.toThrow(/at least 2048/);
    expect(open).not.toHaveBeenCalled();

    const valid = targetFor({ subject: "generic-client" });
    const report = await runMcpFnClientProfileContracts({
      profiles: [
        {
          id: "broken",
          version: "1",
          target: customTarget({
            kind: "broken",
            open: async () => {
              throw new Error("connect failed with token=secret");
            },
          }),
        },
        { id: "generic", version: "canonical", target: valid.target },
      ],
    });
    expect(report.profiles).toMatchObject([
      { profile: { id: "broken" }, ok: false, phase: "connect" },
      { profile: { id: "generic" }, ok: true },
    ]);
    expect(JSON.stringify(report)).not.toContain("token=secret");
  });

  it("bounds oversized compatibility evidence with explicit incompleteness", async () => {
    const cases = Array.from({ length: 20 }, (_, index) => {
      const fixture = targetFor({ subject: "generic-client" });
      return {
        id: `generic-${String(index).padStart(2, "0")}`,
        version: "canonical",
        target: fixture.target,
        fixtures: [
          {
            name: `minimal-${index}-${"x".repeat(100)}`,
            tool: "lookup",
            arguments: { query: "value", tenantId: "tenant" },
            sideEffect: "read-only" as const,
          },
        ],
      };
    });
    const report = await runMcpFnClientProfileContracts({
      profiles: cases,
      maxReportBytes: 2_048,
    });
    expect(report).toMatchObject({
      ok: false,
      status: "incomplete",
      incompleteReason: expect.stringContaining("truncated"),
    });
    expect(report.droppedProfiles).toBeGreaterThan(0);
    expect(
      new TextEncoder().encode(JSON.stringify(report)).byteLength,
    ).toBeLessThanOrEqual(2_048);
  });
});
