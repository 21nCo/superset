/**
 * Comprehensive validation tests for DFQL schema-bounded validation
 * Tests VALID-001: Schema-bounded validation for all endpoints
 */

import { describe, it, expect } from "vitest";
import { createDatafnServer } from "../../server.js";
import { memoryAdapter } from "@superfunctions/db/adapters";

async function readJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

// Fixture F1 schema for testing
const fixtureF1Schema = {
  resources: [
    {
      name: "goal",
      version: 1,
      idPrefix: "goal:",
      fields: [
        { name: "label", type: "string" as const, required: true },
        { name: "status", type: "string" as const, required: true },
        { name: "isArchived", type: "boolean" as const, required: true },
      ],
    },
    {
      name: "task",
      version: 1,
      idPrefix: "task:",
      fields: [
        { name: "label", type: "string" as const, required: true },
        { name: "priority", type: "number" as const, required: true },
        { name: "goalId", type: "string" as const, required: true },
        { name: "isArchived", type: "boolean" as const, required: true },
        { name: "updatedAt", type: "string" as const, required: true },
      ],
      indices: ["label"],
    },
    {
      name: "tag",
      version: 1,
      idPrefix: "tag:",
      fields: [{ name: "label", type: "string" as const, required: true }],
    },
  ],
  relations: [
    {
      from: "task",
      to: "goal",
      type: "many-one" as const,
      relation: "goal",
      inverse: "tasks",
      fkField: "goalId",
    },
    {
      from: "task",
      to: "tag",
      type: "many-many" as const,
      relation: "tags",
      inverse: "tasks",
      metadata: [
        { name: "order", type: "number" as const },
        { name: "addedAt", type: "date" as const },
      ],
    },
  ],
};

describe("Query Validation - VALID-001", () => {
  it("rejects an explicitly supplied falsy temporal value", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
      database: db,
    });

    try {
      const response = await server.router.handle(new Request(
        "http://localhost/datafn/query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "task", temporal: false }),
        },
      ));
      const body = await readJson(response);

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.details.path).toBe("temporal");
    } finally {
      await server.close();
    }
  });

  it("rejects non-boolean null-predicate operands", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
      database: db,
    });

    try {
      const response = await server.router.handle(new Request(
        "http://localhost/datafn/query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "task",
            filters: { label: { is_null: "yes" } },
          }),
        },
      ));
      const body = await readJson(response);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.details.path).toBe("filters.label.is_null");
    } finally {
      await server.close();
    }
  });

  describe("Resource validation", () => {
    it("TV-VALID-RESOURCE-001: unknown resource returns DFQL_UNKNOWN_RESOURCE", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "unknown_table", version: 1 }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
      expect(body.error.message).toBe("Unknown resource: unknown_table");
      expect(body.error.details.path).toBe("resource");
    });

    it("accepts valid resource", async () => {
      const db = memoryAdapter();
      await db.initialize();

      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "task", version: 1 }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Field validation", () => {
    it("TV-VALID-FIELD-001: unknown field in select returns DFQL_UNKNOWN_FIELD", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          select: ["id", "unknown_field"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.details.path).toBe("select[1]");
    });

    it("unknown field in filters returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          filters: { unknown_field: "value" },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.message).toBe("Unknown field: filters.unknown_field");
      expect(body.error.details.path).toBe("filters.unknown_field");
    });

    it("unknown field in sort returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          sort: ["unknown_field:asc"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.details.path).toBe("sort[0]");
    });

    it("validates structured sort terms against the resource schema", async () => {
      const server = await createDatafnServer({
        allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const accepted = await server.router.handle(new Request(
        "http://localhost/datafn/query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "task",
            version: 1,
            sort: [{ field: "updatedAt", direction: "desc" }],
          }),
        },
      ));
      expect(accepted.status).toBe(200);

      const rejected = await server.router.handle(new Request(
        "http://localhost/datafn/query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "task",
            version: 1,
            sort: [{ field: "unknown_field", direction: "asc" }],
          }),
        },
      ));
      expect(rejected.status).toBe(400);
      await expect(readJson(rejected)).resolves.toMatchObject({
        error: { code: "DFQL_UNKNOWN_FIELD", details: { path: "sort[0]" } },
      });
    });

    it("unknown field in omit returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          omit: ["unknown_field"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.details.path).toBe("omit[0]");
    });

    it("rejects legacy system fields in select when capability is not enabled", async () => {
      const db = memoryAdapter();
      await db.initialize();

      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          select: ["id", "createdAt", "updatedAt", "createdBy", "updatedBy", "isArchived"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.details.path).toBe("select[1]");
    });
  });

  describe("Relation validation", () => {
    it("TV-VALID-RELATION-001: unknown relation in select returns DFQL_UNKNOWN_RELATION", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          select: ["id", "unknown_relation.*"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_RELATION");
      expect(body.error.details.path).toBe("select[1]");
    });

    it("accepts valid relation in select", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          select: ["id", "goal.*", "tags.*"],
        }),
      });

      const res = await server.router.handle(req);
      if (res.status !== 200) console.log("Validation Select Fail:", await res.json());
      expect(res.status).toBe(200);
    });
  });
});

describe("Mutation Validation - VALID-001", () => {
  describe("Resource validation", () => {
    it("TV-VALID-MUTATION-001: unknown resource returns DFQL_UNKNOWN_RESOURCE", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "unknown_table",
          version: 1,
          operation: "insert",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "item:1",
          record: { label: "test" },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
      expect(body.error.message).toBe("Unknown resource: unknown_table");
    });
  });

  describe("Field validation", () => {
    it("unknown field in mutation record returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "insert",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: { label: "test", unknown_field: "value" },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.message).toContain("unknown_field");
    });

    it("accepts valid fields in mutation record", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "insert",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: {
            label: "test",
            priority: 1,
            goalId: "goal:1",
            isArchived: false,
            updatedAt: "2024-01-01",
          },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Relation validation", () => {
    it("unknown relation in mutation returns DFQL_UNKNOWN_RELATION", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "relate",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: {},
          relations: {
            unknown_relation: { $ref: "item:1" },
          },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_RELATION");
      expect(body.error.message).toContain("unknown_relation");
    });

    it("unknown metadata key in relation mutation returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "relate",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: {},
          relations: {
            tags: { $ref: "tag:1", unknown_meta: "value" },
          },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
      expect(body.error.message).toContain("unknown_meta");
    });

    it("accepts valid metadata key in relation mutation", async () => {
      const db = memoryAdapter();
      await db.initialize();
      // Seed target record for relation validation (relate checks existence)
      await db.create({
        model: "tag",
        data: { id: "tag:1", label: "Tag 1" },
        namespace: "datafn",
      });
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
        database: db,
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "relate",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: {},
          relations: {
            tags: { $ref: "tag:1", order: 1, addedAt: "2024-01-01" },
          },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(200);
    });
  });

  describe("Operation validation", () => {
    it("unsupported operation returns DFQL_UNSUPPORTED", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "invalid_op",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
          record: { label: "test" },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNSUPPORTED");
    });

    it("insert requires record", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          operation: "insert",
          clientId: "client:1",
          mutationId: "mut:1",
          id: "task:1",
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);

      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_INVALID");
      expect(body.error.message).toContain("record");
    });
  });
});

describe("Transact Validation - VALID-001", () => {
  it("validates mutation steps in transaction", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
    });

    const req = new Request("http://localhost/datafn/transact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: [
          {
            resource: "unknown_table",
            version: 1,
            operation: "insert",
            clientId: "client:1",
            mutationId: "mut:1",
            id: "item:1",
            record: { label: "test" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
  });

  it("validates query steps in transaction", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
    });

    const req = new Request("http://localhost/datafn/transact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: [
          {
            resource: "unknown_table",
            version: 1,
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
  });

  it("validates unknown fields in transaction mutation step", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
    });

    const req = new Request("http://localhost/datafn/transact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: [
          {
            resource: "task",
            version: 1,
            operation: "insert",
            clientId: "client:1",
            mutationId: "mut:1",
            id: "task:1",
            record: { label: "test", unknown_field: "value" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
  });
});

describe("Push Validation - VALID-001", () => {
  it("TV-VALID-PUSH-001: validates mutations in push request", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
    });

    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            resource: "unknown_table",
            version: 1,
            operation: "insert",
            clientId: "client:1",
            mutationId: "mut:1",
            id: "item:1",
            record: { label: "test" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
  });

  describe("SEC-013: Having clause deep validation", () => {
    it("TV-SEC-035: having with unknown field returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          groupBy: ["label"],
          aggregations: { cnt: { op: "count", field: "*" } },
          having: { nonexistent_field: { $gt: 5 } },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
    });

    it("TV-SEC-036: having with aggregation alias is accepted", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          groupBy: ["label"],
          aggregations: { cnt: { op: "count", field: "*" } },
          having: { cnt: { $gt: 5 } },
        }),
      });

      const res = await server.router.handle(req);
      // Should not return 400 for unknown field
      expect(res.status).not.toBe(400);
    });
  });

  describe("SEC-014: GroupBy field schema validation", () => {
    it("TV-SEC-037: groupBy with unknown field returns DFQL_UNKNOWN_FIELD", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          groupBy: ["nonexistent_field"],
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
    });

    it("TV-SEC-038: groupBy with valid field is accepted", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          groupBy: ["label"],
        }),
      });

      const res = await server.router.handle(req);
      // Should not fail with DFQL_UNKNOWN_FIELD
      const body = await readJson(res);
      expect(body.error?.code).not.toBe("DFQL_UNKNOWN_FIELD");
    });
  });

  describe("SEC-015: LIKE pattern length cap", () => {
    it("TV-SEC-039: $like pattern >200 chars returns DFQL_INVALID", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          filters: { label: { $like: "%" + "a".repeat(300) } },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("DFQL_INVALID");
    });

    it("SEC-015: $like pattern <=200 chars is accepted", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          filters: { label: { $like: "%" + "a".repeat(100) } },
        }),
      });

      const res = await server.router.handle(req);
      // Should not fail with DFQL_INVALID due to pattern length
      const body = await readJson(res);
      expect(body.error?.code).not.toBe("DFQL_INVALID");
    });
  });

  describe("SEC-016: Search query length cap", () => {
    it("TV-SEC-040: search query >1000 chars returns LIMIT_EXCEEDED", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          search: { query: "a".repeat(1500), fields: ["label"] },
        }),
      });

      const res = await server.router.handle(req);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("LIMIT_EXCEEDED");
      expect(body.error.message).toBe("Search query exceeds maximum length");
    });

    it("SEC-016: search query <=1000 chars passes length check", async () => {
      const server = await createDatafnServer({ allowUnknownResources: true,
        schema: fixtureF1Schema,
        limits: { maxLimit: 100 },
      });

      const req = new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: 1,
          search: { query: "a".repeat(500), fields: ["label"] },
        }),
      });

      const res = await server.router.handle(req);
      // Should not fail specifically due to search query length
      const body = await readJson(res);
      expect(body.error?.code).not.toBe("DFQL_INVALID");
    });
  });

  it("validates unknown fields in push mutations", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
    });

    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            resource: "task",
            version: 1,
            operation: "insert",
            clientId: "client:1",
            mutationId: "mut:1",
            id: "task:1",
            record: { label: "test", unknown_field: "value" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_FIELD");
  });
});

// ---------------------------------------------------------------------------
// SRV-015: $or operator rejection
// ---------------------------------------------------------------------------

describe("SRV-015: $or operator rejected at validation time", () => {
  it("TV-SRV-015-001: query with $or filter returns DFQL_UNSUPPORTED", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "task",
        filters: {
          $or: [
            { label: { $eq: "a" } },
            { label: { $eq: "b" } },
          ],
        },
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNSUPPORTED");
    expect(body.error.message).toMatch(/\$or/);
  });

  it("TV-SRV-015-002: $and is still accepted", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "task",
        filters: {
          $and: [
            { label: { $eq: "a" } },
          ],
        },
      }),
    });

    const res = await server.router.handle(req);
    const body = await readJson(res);
    // $and is supported — should not return DFQL_UNSUPPORTED
    expect(body.error?.code).not.toBe("DFQL_UNSUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// FIX-SRV-003: Bounded concurrency batch query (replaces old rejection-based SRV-003)
// ---------------------------------------------------------------------------

describe("FIX-SRV-003: bounded concurrency batch query", () => {
  it("batch larger than default concurrency (20) is accepted and processed fully", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      database: (await import("@superfunctions/db/adapters")).memoryAdapter(),
    });

    const queries = Array.from({ length: 25 }, () => ({ resource: "task" }));

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queries),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.result.length).toBe(25);
    await server.close();
  });

  it("batch at exactly default concurrency (20) is accepted", async () => {
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      database: (await import("@superfunctions/db/adapters")).memoryAdapter(),
    });

    const queries = Array.from({ length: 20 }, () => ({ resource: "task" }));

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queries),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    await server.close();
  });
});

// ─── FIX-SEC-008: Query-level prototype pollution checks ─────────────

describe("FIX-SEC-008: Query prototype pollution validation", () => {
  it("__proto__ in query aggregations is rejected at route level", async () => {
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    // Build JSON with __proto__ key in aggregations manually
    const bodyStr = '{"resource":"task","aggregations":{"__proto__":{"op":"count","field":"*"}}}';

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });

    const res = await server.router.handle(req);
    const body = await readJson(res);
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("Disallowed key");
  });

  it("constructor in having clause is rejected at route level", async () => {
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    const bodyStr = '{"resource":"task","aggregations":{"total":{"op":"count","field":"*"}},"having":{"constructor":{"prototype":{}}}}';

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });

    const res = await server.router.handle(req);
    const body = await readJson(res);
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("Disallowed key");
  });

  it("constructor nested inside array payload is rejected at route level", async () => {
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    const bodyStr = '{"resource":"task","select":[{"meta":{"constructor":{"prototype":{}}}}]}';

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });

    const res = await server.router.handle(req);
    const body = await readJson(res);
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("Disallowed key");
  });

  it("clean aggregations + having passes validation", async () => {
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: fixtureF1Schema,
    });

    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "task",
        aggregations: { total: { op: "count", field: "*" } },
        groupBy: ["priority"],
        having: { total: { $gt: 0 } },
      }),
    });

    const res = await server.router.handle(req);
    const body = await readJson(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

// ─── Date field min/max bounds ───────────────────────────────────────

describe("Date field bounds validation", () => {
  const boundsSchema = {
    resources: [
      {
        name: "event",
        version: 1,
        idPrefix: "event:",
        fields: [
          { name: "label", type: "string" as const, required: true },
          {
            name: "startsAt",
            type: "date" as const,
            required: true,
            min: Date.parse("2026-01-01T00:00:00.000Z"),
            max: Date.parse("2026-12-31T23:59:59.999Z"),
          },
        ],
      },
    ],
    relations: [],
  };

  async function pushMutation(record: Record<string, unknown>) {
    const db = memoryAdapter();
    await db.initialize();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: boundsSchema,
      database: db,
    });
    try {
      const res = await server.router.handle(
        new Request("http://localhost/datafn/mutation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resource: "event",
            version: "1",
            clientId: "client-1",
            mutationId: "mut-date-bounds",
            operation: "insert",
            id: "event:1",
            record,
          }),
        }),
      );
      return { status: res.status, body: await readJson(res) };
    } finally {
      await server.close();
    }
  }

  it("rejects a date before min", async () => {
    const { status, body } = await pushMutation({
      label: "Too early",
      startsAt: "2025-12-31T23:59:59.999Z",
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("startsAt");
  });

  it("rejects an epoch date after max", async () => {
    const { status, body } = await pushMutation({
      label: "Too late",
      startsAt: Date.parse("2027-01-01T00:00:00.000Z"),
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
  });

  it("accepts a date within bounds", async () => {
    const { status, body } = await pushMutation({
      label: "In range",
      startsAt: "2026-06-15T12:00:00.000Z",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
