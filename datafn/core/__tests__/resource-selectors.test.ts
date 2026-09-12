/**
 * Conformance suite for structural resource-selector extraction.
 *
 * Parser and extractor share these fixtures so a new protocol envelope cannot
 * be accepted by one without the other.
 */

import { describe, expect, it } from "vitest";
import {
  DATAFN_ERROR_CODES,
  DATAFN_REQUEST_ACTIONS,
  DATAFN_REQUEST_PROTOCOL_VERSION,
  DATAFN_STRUCTURAL_SELECTOR_POSITIONS,
  collectStructuralResourceSelectors,
  extractStructuralResourceSelectors,
  isDatafnRequestAction,
  parseDatafnRequest,
  type DatafnRequestAction,
  type ParsedDatafnRequest,
} from "../src/index.js";

const APPLICATION_NOISE = {
  filters: {
    metadata: { resource: "workspaces" },
    nested: { resources: ["workspaceMemberships"] },
  },
  record: {
    resource: "should-not-appear",
    resources: ["also-not-a-selector"],
    nested: [{ resource: "deep-record" }],
  },
  records: [{ resource: "batch-record" }],
  search: { query: "resource", fields: ["resource"] },
  metadata: { resource: "meta-resource", resources: ["meta-resources"] },
};

function expectSelectors(
  action: string,
  payload: unknown,
  expected: readonly string[],
): void {
  const extracted = extractStructuralResourceSelectors(action, payload);
  expect(extracted.ok).toBe(true);
  if (!extracted.ok) return;
  expect(extracted.result.protocolVersion).toBe(DATAFN_REQUEST_PROTOCOL_VERSION);
  expect([...extracted.result.selectors]).toEqual([...expected]);

  const parsed = parseDatafnRequest(action, payload);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const collected = collectStructuralResourceSelectors(parsed.result);
  expect([...collected.selectors]).toEqual([...expected]);
}

function expectError(
  action: string,
  payload: unknown,
  code: string,
  path?: string,
): void {
  const extracted = extractStructuralResourceSelectors(action, payload);
  expect(extracted.ok).toBe(false);
  if (extracted.ok) return;
  expect(extracted.error.code).toBe(code);
  if (path !== undefined) {
    expect((extracted.error.details as { path?: string } | undefined)?.path).toBe(
      path,
    );
  }
  expect(parseDatafnRequest(action, payload).ok).toBe(false);
}

describe("DATAFN_REQUEST_ACTIONS", () => {
  it("is the exhaustive protocol action inventory", () => {
    expect([...DATAFN_REQUEST_ACTIONS]).toEqual([
      "status",
      "query",
      "mutation",
      "transact",
      "search",
      "seed",
      "clone",
      "pull",
      "push",
      "reconcile",
    ]);
    const positions: Record<DatafnRequestAction, readonly string[]> =
      DATAFN_STRUCTURAL_SELECTOR_POSITIONS;
    for (const action of DATAFN_REQUEST_ACTIONS) {
      expect(isDatafnRequestAction(action)).toBe(true);
      expect(Array.isArray(positions[action])).toBe(true);
    }
  });

  it("rejects unknown actions before any payload traversal", () => {
    expect(isDatafnRequestAction("explode")).toBe(false);
    expectError("explode", { resource: "todos" }, "DFQL_UNSUPPORTED", "$");
  });
});

describe("TV-DATA-6-QUERY: query envelopes", () => {
  it("collects a single query resource", () => {
    expectSelectors("query", { resource: "todos", version: 1 }, ["todos"]);
  });

  it("collects batch query resources in encounter order and deduplicates", () => {
    expectSelectors(
      "query",
      [
        { resource: "todos", version: 1 },
        { resource: "categories", version: 1 },
        { resource: "todos", version: 1 },
      ],
      ["todos", "categories"],
    );
  });

  it("ignores resource-shaped application filters and records", () => {
    expectSelectors(
      "query",
      {
        resource: "skills",
        version: 1,
        ...APPLICATION_NOISE,
      },
      ["skills"],
    );
  });

  it("rejects a missing query resource", () => {
    expectError("query", { version: 1 }, "DFQL_INVALID", "$.resource");
  });

  it("rejects prototype-pollution keys on protocol objects", () => {
    expectError(
      "query",
      { resource: "todos", constructor: "nope" },
      "DFQL_INVALID",
      "$",
    );
  });

  it("rejects a non-string query resource", () => {
    expectError("query", { resource: ["todos"] }, "DFQL_INVALID", "$.resource");
  });

  it("rejects a blank query resource", () => {
    expectError("query", { resource: "   " }, "DFQL_INVALID", "$.resource");
  });
});

describe("TV-DATA-6-MUTATION: mutation envelopes", () => {
  it("collects a single mutation resource", () => {
    expectSelectors(
      "mutation",
      {
        resource: "todos",
        version: 1,
        operation: "insert",
        record: APPLICATION_NOISE.record,
      },
      ["todos"],
    );
  });

  it("collects batched mutations and ignores nested application keys", () => {
    expectSelectors(
      "mutation",
      [
        {
          resource: "contextNotes",
          operation: "merge",
          record: { resources: ["workspaceMemberships"] },
        },
        { resource: "skills", operation: "delete", id: "skill_1" },
      ],
      ["contextNotes", "skills"],
    );
  });

  it("rejects a malformed mutation selector", () => {
    expectError(
      "mutation",
      { resource: 12, operation: "delete" },
      "DFQL_INVALID",
      "$.resource",
    );
  });
});

describe("TV-DATA-6-TRANSACT: transaction envelopes", () => {
  it("reads wrapped, nested, and bare step selectors", () => {
    expectSelectors(
      "transact",
      {
        steps: [
          { query: { resource: "skills", filters: APPLICATION_NOISE.filters } },
          {
            mutation: {
              resource: "contextNotes",
              operation: "insert",
              record: APPLICATION_NOISE.record,
            },
          },
          { resource: "skillContexts" },
          { resource: "amendmentReviews", operation: "delete", id: "rev_1" },
        ],
      },
      ["skills", "contextNotes", "skillContexts", "amendmentReviews"],
    );
  });

  it("rejects a step that is both a query and a mutation", () => {
    expectError(
      "transact",
      {
        steps: [
          {
            query: { resource: "skills" },
            mutation: { resource: "contextNotes", operation: "delete" },
          },
        ],
      },
      "DFQL_INVALID",
      "steps[0]",
    );
  });

  it("rejects a missing steps array", () => {
    expectError("transact", { atomic: true }, "DFQL_INVALID", "steps");
  });
});

describe("TV-DATA-6-SEARCH: search envelopes", () => {
  it("collects explicit resources plus resource-map keys", () => {
    expectSelectors(
      "search",
      {
        query: "standup",
        resources: ["todos", "categories"],
        filters: {
          sessions: { resource: { eq: "application-field" } },
        },
        temporalByResource: {
          notes: { field: "createdAt" },
        },
      },
      ["todos", "categories", "sessions", "notes"],
    );
  });

  it("allows selector-less search of all resources", () => {
    expectSelectors("search", { query: "test" }, []);
  });

  it("rejects malformed resources arrays", () => {
    expectError(
      "search",
      { query: "test", resources: "todos" },
      "DFQL_INVALID",
      "resources",
    );
  });
});

describe("TV-DATA-6-SYNC: clone, pull, push, and reconcile", () => {
  it("collects clone tables and page.table", () => {
    expectSelectors(
      "clone",
      {
        clientId: "c1",
        tables: ["todos", "categories"],
        page: { table: "notes", afterId: null, limit: 100 },
      },
      ["todos", "categories", "notes"],
    );
  });

  it("collects pull cursor keys and ignores cursor values", () => {
    expectSelectors(
      "pull",
      {
        clientId: "c1",
        cursors: {
          todos: "12",
          categories: JSON.stringify({ resource: "not-a-selector" }),
        },
      },
      ["todos", "categories"],
    );
  });

  it("treats global-cursor pull as selector-less", () => {
    expectSelectors("pull", { clientId: "c1", cursor: "0" }, []);
  });

  it("collects push mutation resources and ignores records", () => {
    expectSelectors(
      "push",
      {
        clientId: "c1",
        mutations: [
          {
            resource: "todos",
            operation: "insert",
            record: APPLICATION_NOISE.record,
          },
          { resource: "categories", operation: "delete", id: "cat_1" },
        ],
      },
      ["todos", "categories"],
    );
  });

  it("collects reconcile resources", () => {
    expectSelectors(
      "reconcile",
      { clientId: "c1", resources: ["todos", "categories", "todos"] },
      ["todos", "categories"],
    );
  });
});

describe("TV-DATA-6-EMPTY: selector-less operations", () => {
  it("returns an empty selector set for status and seed", () => {
    expectSelectors("status", null, []);
    expectSelectors("seed", { clientId: "c1" }, []);
  });
});

describe("TV-DATA-6-VERSION: protocol version", () => {
  it("defaults omitted protocolVersion to the current version", () => {
    const parsed = parseDatafnRequest("query", { resource: "todos" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.protocolVersion).toBe("1");
  });

  it("fails closed for an unsupported protocol version", () => {
    expectError(
      "query",
      { resource: "todos", protocolVersion: "2" },
      "DATAFN_UNSUPPORTED_PROTOCOL_VERSION",
      "protocolVersion",
    );
    expect(DATAFN_ERROR_CODES).toContain("DATAFN_UNSUPPORTED_PROTOCOL_VERSION");
  });

  it("rejects a non-string protocolVersion", () => {
    expectError(
      "mutation",
      { resource: "todos", operation: "delete", protocolVersion: 1 },
      "DFQL_INVALID",
      "protocolVersion",
    );
  });
});

describe("TV-DATA-6-EXHAUSTIVE: parsed-request visitor", () => {
  it("visits every accepted protocol kind", () => {
    const samples: Record<DatafnRequestAction, unknown> = {
      status: null,
      query: { resource: "todos" },
      mutation: { resource: "todos", operation: "delete" },
      transact: { steps: [{ query: { resource: "todos" } }] },
      search: { query: "x", resources: ["todos"] },
      seed: { clientId: "c1" },
      clone: { clientId: "c1", tables: ["todos"] },
      pull: { clientId: "c1", cursors: { todos: "1" } },
      push: {
        clientId: "c1",
        mutations: [{ resource: "todos", operation: "delete" }],
      },
      reconcile: { clientId: "c1", resources: ["todos"] },
    };

    const seen = new Set<ParsedDatafnRequest["kind"]>();
    for (const action of DATAFN_REQUEST_ACTIONS) {
      const parsed = parseDatafnRequest(action, samples[action]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      seen.add(parsed.result.kind);
      const selection = collectStructuralResourceSelectors(parsed.result);
      expect(selection.protocolVersion).toBe(DATAFN_REQUEST_PROTOCOL_VERSION);
    }
    expect([...seen].sort()).toEqual([...DATAFN_REQUEST_ACTIONS].sort());
  });
});


describe("protocol boundary regressions", () => {
  it("excludes the reserved actor-feed cursor while preserving resource cursors", () => {
    expectSelectors("pull", { cursors: { __datafn_actor_feed__: 7, tasks: 2 } }, ["tasks"]);
  });
  it.each([
    ["query", [{ resource: "tasks", protocolVersion: "2" }]],
    ["mutation", [{ resource: "tasks", protocolVersion: "2" }]],
    ["transact", { steps: [{ protocolVersion: "2", query: { resource: "tasks" } }] }],
    ["transact", { steps: [{ query: { resource: "tasks", protocolVersion: "2" } }] }],
    ["push", { mutations: [{ resource: "tasks", protocolVersion: "2" }] }],
  ])("rejects unsupported nested versions for %s", (action, payload) => {
    expectError(action as string, payload, "DATAFN_UNSUPPORTED_PROTOCOL_VERSION");
  });
  it("ignores version-shaped application data", () => {
    expectSelectors("mutation", { resource: "tasks", record: { protocolVersion: "99" } }, ["tasks"]);
  });
  it("rejects inherited protocol fields", () => {
    expectError("query", Object.create({ resource: "tasks" }), "DFQL_INVALID");
    expectError("search", Object.create({ resources: ["tasks"] }), "DFQL_INVALID");
    expectSelectors("query", Object.assign(Object.create(null), { resource: "tasks" }), ["tasks"]);
  });
});

// Every object action must reject reserved envelope keys, not domain data keys.
describe("reserved top-level protocol keys", () => {
  for (const action of DATAFN_REQUEST_ACTIONS) {
    it.each(["constructor", "prototype", "__proto__"])(`${action} rejects %s`, (key) => {
      const payload = JSON.parse(`{"${key}":{},"resource":"tasks","resources":[],"steps":[],"mutations":[]}`);
      expectError(action, payload, "DFQL_INVALID", "$");
    });
  }
});

it("translates only trusted join cursors into endpoint selectors", () => {
  const schema: any = { resources: [{ name: "posts" }, { name: "tags" }, { name: "join_legitimate" }], relations: [{ type: "many-many", from: "posts", to: "tags", relation: "tags" }] };
  const payload = { cursors: { posts: "1", join_posts_tags_tags: "2", join_legitimate: "3" } };
  const parsed = parseDatafnRequest("pull", payload, { schema });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(collectStructuralResourceSelectors(parsed.result).selectors).toEqual(["posts", "tags", "join_legitimate"]);
  expect(extractStructuralResourceSelectors("pull", payload, { schema })).toEqual({ ok: true, result: { protocolVersion: "1", selectors: ["posts", "tags", "join_legitimate"] } });
  schema.resources.push({ name: "join_posts_tags_tags" });
  const collision = extractStructuralResourceSelectors("pull", payload, { schema });
  expect(collision.ok && collision.result.selectors).toContain("join_posts_tags_tags");
});


it.each([
  [{}, ["join_posts_to_tags_tags", "join_posts_tags_tags", "join_posts_undefined_tags"]],
  [{ joinTable: "post_tags" }, ["join_posts_post_tags_tags", "join_posts_tags_tags", "join_posts_undefined_tags"]],
  [{ inverse: "posts" }, ["join_posts_posts_tags", "join_posts_undefined_tags"]],
])("recognizes canonical and persisted unnamed relation cursors: %j", (options, keys) => {
  const schema: any = {
    resources: [{ name: "posts" }, { name: "tags" }],
    relations: [{ type: "many-many", from: "posts", to: "tags", ...options }],
  };
  for (const key of keys as string[]) {
    const result = extractStructuralResourceSelectors("pull", { cursors: { [key]: "1" } }, { schema });
    expect(result.ok && result.result.selectors).toEqual(["posts", "tags"]);
  }
  const unknown = extractStructuralResourceSelectors("pull", { cursors: { join_other_tags_tags: "1" } }, { schema });
  expect(unknown.ok && unknown.result.selectors).toEqual(["join_other_tags_tags"]);
});

it("rejects mixed global and resource pull cursors before authorization", () => {
  const result = extractStructuralResourceSelectors("pull", { cursor: "0", cursors: { allowed: "0" } });
  expect(result.ok).toBe(false);
});
