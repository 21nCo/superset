import { memoryAdapter } from "@superfunctions/db/adapters";
import { describe, it, expect, beforeEach } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { fixtureF1Schema } from "./fixtures/f1.js";

describe("/datafn/sync endpoints (Phase 04)", () => {
  let db: any;

  beforeEach(() => {
    // Create fresh store for each test
    db = memoryAdapter();
  });

  // Helper to create server with fixture F1
  async function createF1Server(db: any) {
    return await createDatafnServer({ allowUnknownResources: true,
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
      database: db,
    });
  }

  it("PROTO-PUSH-001: Push returns cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:device-1",
          mutations: [
            {
              resource: "tag",
              version: 1,
              operation: "insert",
              clientId: "client:device-1",
              mutationId: "m1",
              id: "tag:1",
              record: { label: "one" },
            },
          ],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.applied).toContain("m1");
    // Verify cursor presence and format
    expect(typeof body.result.cursor).toBe("string");
    expect(body.result.cursor).toMatch(/^\d+$/);
    expect(body.result.cursor).not.toBe("0"); // Should be > 0 after mutation
  });

  it("TV-CURSOR-BEFORE-001: Push returns cursorBefore for single client (no foreign changes)", async () => {
    const server = await createF1Server(db);

    // First push: no prior seqs, so cursorBefore should be "0"
    const res = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "tag:1", record: { label: "one" } },
          ],
        }),
      }),
    );
    const body = await res.json();
    expect(body.result.ok).toBe(true);
    expect(typeof body.result.cursorBefore).toBe("string");
    expect(body.result.cursorBefore).toMatch(/^\d+$/);
    // cursorBefore should be 0 (nothing before this push)
    expect(body.result.cursorBefore).toBe("0");
    // cursor should be > cursorBefore
    expect(parseInt(body.result.cursor, 10)).toBeGreaterThan(
      parseInt(body.result.cursorBefore, 10),
    );
  });

  it("TV-CURSOR-BEFORE-002: cursorBefore reflects sequence before push, cursor reflects after", async () => {
    const server = await createF1Server(db);

    // Client A pushes first — advances global seq
    const resA = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:A",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:A", mutationId: "mA1", id: "tag:A1", record: { label: "A" } },
          ],
        }),
      }),
    );
    const bodyA = await resA.json();
    expect(bodyA.result.ok).toBe(true);
    const cursorAfterA = parseInt(bodyA.result.cursor, 10);

    // Client B pushes second — cursorBefore should equal cursor returned by A's push
    const resB = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:B",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:B", mutationId: "mB1", id: "tag:B1", record: { label: "B" } },
          ],
        }),
      }),
    );
    const bodyB = await resB.json();
    expect(bodyB.result.ok).toBe(true);

    // B's cursorBefore should equal A's final cursor (B saw A's changes)
    expect(parseInt(bodyB.result.cursorBefore, 10)).toBe(cursorAfterA);
    // B's cursor should be greater than cursorBefore
    expect(parseInt(bodyB.result.cursor, 10)).toBeGreaterThan(
      parseInt(bodyB.result.cursorBefore, 10),
    );
  });

  it("TV-CURSOR-BEFORE-003: Push with relate mutation returns cursorBefore correctly", async () => {
    const server = await createF1Server(db);

    // Insert prerequisite records
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "ms1", id: "task:1", record: { label: "T1", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "ms2", id: "tag:1", record: { label: "urgent" } },
          ],
        }),
      }),
    );

    // Capture seq before relate push
    const resRelate = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            {
              resource: "task",
              version: 1,
              operation: "relate",
              id: "task:1",
              relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "client:1",
              mutationId: "m-relate-1",
            },
          ],
        }),
      }),
    );
    const bodyRelate = await resRelate.json();
    expect(bodyRelate.result.ok).toBe(true);
    // cursorBefore must be present and be a valid integer string
    expect(typeof bodyRelate.result.cursorBefore).toBe("string");
    expect(bodyRelate.result.cursorBefore).toMatch(/^\d+$/);
    // cursor > cursorBefore (relation mutations consume 2+ seqs)
    expect(parseInt(bodyRelate.result.cursor, 10)).toBeGreaterThan(
      parseInt(bodyRelate.result.cursorBefore, 10),
    );
  });

  it("TV-CURSOR-BEFORE-004: Deduped push returns cursorBefore correctly", async () => {
    const server = await createF1Server(db);

    const payload = {
      clientId: "client:1",
      mutations: [
        { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m-dup", id: "tag:dup", record: { label: "dup" } },
      ],
    };

    // First push
    const res1 = await server.router.handle(
      new Request("http://localhost/datafn/push", { method: "POST", body: JSON.stringify(payload) }),
    );
    const body1 = await res1.json();
    expect(body1.result.ok).toBe(true);

    // Second push (idempotent retry)
    const res2 = await server.router.handle(
      new Request("http://localhost/datafn/push", { method: "POST", body: JSON.stringify(payload) }),
    );
    const body2 = await res2.json();
    expect(body2.result.ok).toBe(true);
    expect(body2.result.applied).toContain("m-dup");
    // cursorBefore should still be present
    expect(typeof body2.result.cursorBefore).toBe("string");
    expect(body2.result.cursorBefore).toMatch(/^\d+$/);
  });

  it("PROTO-PULL-001: Pull supports global cursor and pagination", async () => {
    const server = await createF1Server(db);

    // 1. Seed data via push to generate sequence numbers
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "1" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "tag:2", record: { label: "2" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m3", id: "tag:3", record: { label: "3" } },
          ],
        }),
      }),
    );

    // 2. Pull with limit 2 (should get m1, m2)
    const res1 = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: "0",
          limit: 2,
        }),
      }),
    );

    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.result.ok).toBe(true);
    expect(body1.result.changes).toHaveLength(2);
    expect(body1.result.changes[0].id).toBe("tag:1");
    expect(body1.result.changes[1].id).toBe("tag:2");
    expect(body1.result.nextCursor).toBeDefined();
    expect(body1.result.nextCursor).not.toBeNull();

    const nextCursor = body1.result.nextCursor;

    // 3. Pull remaining (should get m3)
    const res2 = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: nextCursor,
          limit: 2,
        }),
      }),
    );

    const body2 = await res2.json();
    expect(body2.result.changes).toHaveLength(1);
    expect(body2.result.changes[0].id).toBe("tag:3");
    
    // Pull now returns the latest server cursor even on a short final page.
    expect(body2.result.nextCursor).toBe("3");
  });

  it("PROTO-PULL-001: Pull validates cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: "invalid",
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor");
  });

  it("TV-SYNC-001: Clone returns cursors (unchanged)", async () => {
     // This test ensures we didn't break clone
     const server = await createF1Server(db);
     await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1", tables: ["tag"] }),
      }),
    );
    // Just ensure it doesn't 500
  });

  // TV-REL-001: Push applies relation mutation and records join delta
  it("TV-REL-001: Push applies relation mutation and records join delta", async () => {
    // Create schema with many-many relation
    const relSchema = {
      resources: [
        {
          name: "node",
          version: 1,
          idPrefix: "node",
          fields: [{ name: "label", type: "string" as const, required: false }],
        },
        {
          name: "property",
          version: 1,
          idPrefix: "property",
          fields: [{ name: "name", type: "string" as const, required: false }],
        },
      ],
      relations: [
        {
          from: "node",
          to: "property",
          type: "many-many" as const,
          relation: "properties",
          metadata: [{ name: "value", type: "string" as const }],
        },
      ],
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: relSchema,
      limits: { maxLimit: 100 },
      database: db,
    });

    // Seed initial records
    await db.create({
      model: "node",
      data: { id: "node:1", label: "Node 1" },
      namespace: "datafn",
    });
    await db.create({
      model: "property",
      data: { id: "property:1", name: "Prop 1" },
      namespace: "datafn",
    });

    // Push relation mutation
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            {
              resource: "node",
              version: 1,
              operation: "relate",
              id: "node:1",
              relations: { properties: [{ $ref: "property:1", value: "v" }] },
              clientId: "client:1",
              mutationId: "m-1",
            },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.result.ok).toBe(true);
    expect(pushBody.result.applied).toContain("m-1");
    expect(pushBody.result.errors).toHaveLength(0);

    // Verify join row was created (uses standard adapter CRUD)
    const joinRow = await db.findOne({
      model: "__datafn_join_node_properties",
      where: [
        { field: "from", operator: "eq", value: "node:1" },
        { field: "to", operator: "eq", value: "property:1" },
      ],
      namespace: "datafn"
    });
    expect(joinRow).toBeDefined();
    expect(joinRow!.value).toBe("v");

    // Verify change tracking recorded join delta (uses internal CRUD store)
    const changes = await db.internal.findMany(
      "__datafn_changes",
      [{ field: "namespace", op: "eq", value: "datafn" }],
      { orderBy: "server_seq" },
    );

    // Should have at least one change for the join
    const joinChanges = changes.filter(
      (c: any) => c.resource && c.resource.startsWith("join_")
    );
    expect(joinChanges.length).toBeGreaterThan(0);
  });

  // TV-REL-001N: Push rejects relation mutation for unknown relation  
  it("TV-REL-001N: Push rejects relation mutation for unknown relation", async () => {
    const server = await createF1Server(db);

    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            {
              resource: "tag",
              version: 1,
              operation: "relate",
              id: "tag:1",
              relations: { unknownRel: "x" },
              clientId: "client:1",
              mutationId: "m-1",
            },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    // Validation errors result in ok: false envelope with error 
    expect(pushBody.ok).toBe(false);
    expect(pushBody.error).toBeDefined();
    expect(pushBody.error.code).toBe("DFQL_UNKNOWN_RELATION");
    expect(pushBody.error.message).toContain("unknownRel");
  });

  // Idempotency test for relation mutations
  it("Push relation mutation is idempotent", async () => {
    // Create schema with many-many relation
    const relSchema = {
      resources: [
        {
          name: "node",
          version: 1,
          idPrefix: "node",
          fields: [{ name: "label", type: "string" as const, required: false }],
        },
        {
          name: "property",
          version: 1,
          idPrefix: "property",
          fields: [{ name: "name", type: "string" as const, required: false }],
        },
      ],
      relations: [
        {
          from: "node",
          to: "property",
          type: "many-many" as const,
          relation: "properties",
          metadata: [{ name: "value", type: "string" as const }],
        },
      ],
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: relSchema,
      limits: { maxLimit: 100 },
      database: db,
    });

    // Seed
    await db.create({
      model: "node",
      data: { id: "node:1", label: "Node 1" },
      namespace: "datafn",
    });
    await db.create({
      model: "property",
      data: { id: "property:1", name: "Prop 1" },
      namespace: "datafn",
    });

    const payload = {
      clientId: "client:1",
      mutations: [
        {
          resource: "node",
          version: 1,
          operation: "relate",
          id: "node:1",
          relations: { properties: [{ $ref: "property:1", value: "v" }] },
          clientId: "client:1",
          mutationId: "m-idempotent-1",
        },
      ],
    };

    // First push
    const res1 = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const body1 = await res1.json();
    expect(body1.result.applied).toContain("m-idempotent-1");

    // Get initial change count
    const changes1 = await db.findMany({
      model: "__datafn_changes",
      where: [{ field: "namespace", operator: "eq", value: "datafn" }],
      namespace: "datafn",
    });
    const initialChangeCount = changes1.length;

    // Second push (retry)
    const res2 = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const body2 = await res2.json();
    expect(body2.result.applied).toContain("m-idempotent-1");

    // Verify no duplicate changes were recorded
    const changes2 = await db.findMany({
      model: "__datafn_changes",
      where: [{ field: "namespace", operator: "eq", value: "datafn" }],
      namespace: "datafn",
    });
    expect(changes2.length).toBe(initialChangeCount);
  });

  // PHASE_05 Tests

  it("TV-SYNC-003: Per-table pull returns grouped records/deletes and updated cursors", async () => {
    const server = await createF1Server(db);

    // Seed data via push
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "X" } },
            { resource: "goal", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "goal:1", record: { label: "Y", status: "active", isArchived: false } },
            { resource: "tag", version: 1, operation: "delete", clientId: "seed", mutationId: "m3", id: "tag:1" },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.result.ok).toBe(true);

    // Pull with per-table cursors
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { tag: "0", goal: "0" },
          limit: 100,
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    
    // Verify grouped records
    expect(body.result.records.tag).toBeDefined();
    // Tag was inserted then deleted, so we should see it in records (the upsert)
    expect(body.result.records.tag.length).toBeGreaterThanOrEqual(1);
    
    expect(body.result.records.goal).toBeDefined();
    expect(body.result.records.goal).toHaveLength(1);
    expect(body.result.records.goal[0].id).toBe("goal:1");
    
    // Verify deleted - tag:1 should be in the deleted array
    expect(body.result.deleted.tag).toBeDefined();
    expect(body.result.deleted.tag).toContain("tag:1");
    
    // Verify cursors updated
    expect(body.result.cursors.tag).toBeDefined();
    expect(body.result.cursors.tag).toMatch(/^\d+$/);
    expect(body.result.cursors.goal).toBeDefined();
    expect(body.result.cursors.goal).toMatch(/^\d+$/);
  });

  it("TV-SYNC-003N: Pull rejects invalid cursor format", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { tag: "not-an-int" },
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor must be an integer string");
    expect(body.result.error.details.path).toBe("cursors.tag");
  });

  it("TV-SYNC-004: Legacy global-cursor pull remains supported", async () => {
    const server = await createF1Server(db);

    // Seed data
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "X" } },
          ],
        }),
      }),
    );

    // Pull with legacy format
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursor: "0",
          limit: 2,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.changes).toBeDefined();
    expect(Array.isArray(body.result.changes)).toBe(true);
    expect(body.result.changes).toHaveLength(1);
    expect(body.result.changes[0].id).toBe("tag:1");
  });

  it("TV-SYNC-004N: Legacy pull rejects non-integer cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursor: "x",
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor must be an integer string");
  });

  it("TV-REL-002: Pull hydrates join rows into response", async () => {
    const server = await createF1Server(db);

    // Push relation mutation to generate join change
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "task:1", record: { label: "T1", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m2", id: "tag:1", record: { label: "urgent" } },
            {
              resource: "task",
              version: 1,
              operation: "relate",
              id: "task:1",
              relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "client:1",
              mutationId: "m3",
            },
          ],
        }),
      }),
    );

    // Pull with per-table cursors including joins
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:2",
          cursors: { task: "0", tag: "0", join_task_tags_tag: "0" },
          limit: 100,
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    
    // Verify join rows are included
    expect(body.result.joins).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"]).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"].upsert).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"].upsert.length).toBeGreaterThan(0);
    
    const joinRow = body.result.joins["join_task_tags_tag"].upsert[0];
    expect(joinRow.from).toBe("task:1");
    expect(joinRow.to).toBe("tag:1");
    expect(joinRow.order).toBe(1);
  });

  // PHASE_06 Tests
  it("TV-SYNC-001: Paginated clone returns deterministic page and next marker", async () => {
    const server = await createF1Server(db);

    // Seed 3 tasks
    await db.create({
      model: "task",
      data: { id: "task:1", label: "A", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });
    await db.create({
      model: "task",
      data: { id: "task:2", label: "B", priority: 2, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });
    await db.create({
      model: "task",
      data: { id: "task:3", label: "C", priority: 3, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });

    // Clone with pagination (limit 2)
    const res = await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          tables: ["task"],
          page: {
            table: "task",
            afterId: null,
            limit: 2,
          },
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.data.task).toHaveLength(2);
    expect(body.result.data.task[0].id).toBe("task:1");
    expect(body.result.data.task[1].id).toBe("task:2");
    
    // Verify next marker
    expect(body.result.next).toBeDefined();
    expect(body.result.next.task).toBe("task:2");
  });

  it("TV-SYNC-001N: Clone rejects remote-only resources", async () => {
    // Use fixtureF1Schema which doesn't have remote-only resources
    // Add a modified schema with a remote-only resource for this test
    const schemaWithRemoteOnly = {
      ...fixtureF1Schema,
      resources: [
        ...fixtureF1Schema.resources,
        { name: "vector", version: 1, isRemoteOnly: true, fields: [] },
      ],
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: schemaWithRemoteOnly as any,
      limits: { maxLimit: 100 },
      database: db,
    });

    const res = await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          tables: ["vector"],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("remote-only table cannot be cloned");
  });

  // PHASE_07: Reconcile tests (TV-RECON-001, TV-RECON-001N)
  it("TV-RECON-001: Reconcile returns deterministic counts", async () => {
    const server = await createF1Server(db);

    // Seed some data
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "one" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "tag:2", record: { label: "two" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m3", id: "tag:3", record: { label: "three" } },
          ],
        }),
      }),
    );

    // Call reconcile
    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["tag"],
          includeJoins: false,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.counts).toBeDefined();
    expect(body.result.counts.tag).toBe(3);
    expect(body.result.latestCursor).toBeDefined();
    expect(typeof body.result.latestCursor).toBe("string");
  });

  it("TV-RECON-001N: Reconcile rejects unknown resource", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["unknown"],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
    expect(body.error.message).toContain("Unknown resource: unknown");
  });

  // FIX-A+B: Merge operation and per-resource cursors tests

  it("TV-MERGE-CHANGELOG-001: Push merge mutation records op=merge in changelog", async () => {
    const server = await createF1Server(db);

    // Insert a tag first
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m-insert", id: "tag:1", record: { label: "original" } },
          ],
        }),
      }),
    );

    // Merge (partial update) the tag
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "merge", clientId: "client:1", mutationId: "m-merge", id: "tag:1", record: { label: "updated" } },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.result.ok).toBe(true);
    expect(pushBody.result.applied).toContain("m-merge");

    // Check the changelog — the merge entry must have op="merge"
    const changes = await db.internal.findMany(
      "__datafn_changes",
      [{ field: "namespace", op: "eq", value: "datafn" }],
      { orderBy: "server_seq" },
    );

    const mergeChange = changes.find((c: any) => c.record_id === "tag:1" && c.op === "merge");
    expect(mergeChange).toBeDefined();
    expect(mergeChange!.op).toBe("merge");

    // The changelog record must only contain the partial fields (not the full record)
    const changeRecord = JSON.parse(mergeChange!.record as string);
    expect(changeRecord.label).toBe("updated");
  });

  it("TV-MERGE-PULL-001: Canonical pull returns merged field (not records) for merge mutations", async () => {
    const server = await createF1Server(db);

    // Insert a tag
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m-insert", id: "tag:1", record: { label: "original" } },
          ],
        }),
      }),
    );

    // Capture the cursor after insert
    const insertPull = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1", cursors: { tag: "0" } }),
      }),
    );
    const insertPullBody = await insertPull.json();
    const cursorAfterInsert = insertPullBody.result.cursors.tag;

    // Now merge
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "merge", clientId: "client:1", mutationId: "m-merge", id: "tag:1", record: { label: "updated" } },
          ],
        }),
      }),
    );

    // Pull only the new changes (since the insert cursor)
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c2",
          cursors: { tag: cursorAfterInsert },
          limit: 100,
        }),
      }),
    );

    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // The merge delta must appear in `merged`, NOT in `records`
    expect(pullBody.result.merged).toBeDefined();
    expect(pullBody.result.merged.tag).toBeDefined();
    expect(pullBody.result.merged.tag).toHaveLength(1);
    expect(pullBody.result.merged.tag[0].id).toBe("tag:1");
    expect(pullBody.result.merged.tag[0].label).toBe("updated");

    // The merge record must NOT appear in records[] as a full upsert
    const mergeInRecords = (pullBody.result.records.tag || []).find(
      (r: any) => r.id === "tag:1" && r.label === "updated",
    );
    expect(mergeInRecords).toBeUndefined();
  });

  it("TV-PUSH-CURSORS-001: Push returns per-resource cursors map", async () => {
    const server = await createF1Server(db);

    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "tag:1", record: { label: "X" } },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.result.ok).toBe(true);

    // cursors must be present with the tag resource
    expect(pushBody.result.cursors).toBeDefined();
    expect(typeof pushBody.result.cursors).toBe("object");
    expect(pushBody.result.cursors.tag).toBeDefined();
    expect(pushBody.result.cursors.tag).toMatch(/^\d+$/);
    // The tag cursor must match the push cursor value
    expect(parseInt(pushBody.result.cursors.tag, 10)).toBe(
      parseInt(pushBody.result.cursor, 10),
    );
  });

  it("TV-PUSH-CURSORS-002: Push with multiple resources returns cursors for each", async () => {
    const server = await createF1Server(db);

    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "tag:1", record: { label: "X" } },
            { resource: "goal", version: 1, operation: "insert", clientId: "client:1", mutationId: "m2", id: "goal:1", record: { label: "G", status: "active", isArchived: false } },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.result.ok).toBe(true);

    expect(pushBody.result.cursors.tag).toBeDefined();
    expect(pushBody.result.cursors.goal).toBeDefined();
    // Both cursors must be integer strings
    expect(pushBody.result.cursors.tag).toMatch(/^\d+$/);
    expect(pushBody.result.cursors.goal).toMatch(/^\d+$/);
    // They can be different since each mutation gets its own serverSeq
    expect(parseInt(pushBody.result.cursors.tag, 10)).toBeGreaterThan(0);
    expect(parseInt(pushBody.result.cursors.goal, 10)).toBeGreaterThan(0);
  });

  it("TV-INSERT-CHANGELOG-001: Push insert mutation records op=insert in changelog", async () => {
    const server = await createF1Server(db);

    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "tag:1", record: { label: "X" } },
          ],
        }),
      }),
    );

    const changes = await db.internal.findMany(
      "__datafn_changes",
      [{ field: "namespace", op: "eq", value: "datafn" }],
      { orderBy: "server_seq" },
    );

    const insertChange = changes.find((c: any) => c.record_id === "tag:1");
    expect(insertChange).toBeDefined();
    expect(insertChange!.op).toBe("insert");
  });

  it("TV-INSERT-PULL-001: Canonical pull returns insert changes in records field", async () => {
    const server = await createF1Server(db);

    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "X" } },
          ],
        }),
      }),
    );

    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1", cursors: { tag: "0" } }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // Insert appears in records[] (full record)
    expect(pullBody.result.records.tag).toBeDefined();
    expect(pullBody.result.records.tag).toHaveLength(1);
    expect(pullBody.result.records.tag[0].id).toBe("tag:1");

    // merged should be absent or empty for inserts
    const mergedTags = pullBody.result.merged?.tag;
    expect(mergedTags === undefined || mergedTags.length === 0).toBe(true);
  });

  // FIX-REL-001: Relate/unrelate spurious upsert bug regression tests

  it("TV-REL-NOSPURIOUS-001: many-many relate does NOT produce id-only stub in pull records", async () => {
    const server = await createF1Server(db);

    // Insert task and tag with full fields
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "task:1", record: { label: "Buy milk", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "tag:1", record: { label: "urgent" } },
          ],
        }),
      }),
    );

    // Capture the cursor after seed — "Client B" starts here
    const pullAfterSeed = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "clientB", cursors: { task: "0", tag: "0", join_task_tags_tag: "0" }, includeJoins: true }),
      }),
    );
    const seedBody = await pullAfterSeed.json();
    const cursorAfterSeed = seedBody.result.cursors.task;

    // Client A performs a many-many relate
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "relate",
              id: "task:1", relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "clientA", mutationId: "m-relate",
            },
          ],
        }),
      }),
    );

    // Client B pulls changes since seed cursor
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientB",
          cursors: { task: cursorAfterSeed, tag: cursorAfterSeed, join_task_tags_tag: cursorAfterSeed },
          includeJoins: true,
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // CRITICAL: task should NOT appear in records[] with a stub { id } — that would corrupt Client B's record
    const taskRecords: any[] = pullBody.result.records.task || [];
    const idOnlyStub = taskRecords.find((r: any) => r.id === "task:1" && Object.keys(r).length === 1);
    expect(idOnlyStub).toBeUndefined(); // No id-only stub should exist

    // The join row SHOULD appear in joins
    expect(pullBody.result.joins).toBeDefined();
    expect(pullBody.result.joins["join_task_tags_tag"]).toBeDefined();
    expect(pullBody.result.joins["join_task_tags_tag"].upsert.length).toBeGreaterThan(0);
    expect(pullBody.result.joins["join_task_tags_tag"].upsert[0].from).toBe("task:1");
    expect(pullBody.result.joins["join_task_tags_tag"].upsert[0].to).toBe("tag:1");
  });

  it("TV-REL-NOSPURIOUS-002: many-many unrelate does NOT produce id-only stub in pull records", async () => {
    const server = await createF1Server(db);

    // Seed task, tag, and existing relation
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "task:1", record: { label: "Buy milk", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "tag:1", record: { label: "urgent" } },
            { resource: "task", version: 1, operation: "relate",
              id: "task:1", relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "seed", mutationId: "m3" },
          ],
        }),
      }),
    );

    const pullAfterSeed = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "clientB", cursors: { task: "0", tag: "0", join_task_tags_tag: "0" }, includeJoins: true }),
      }),
    );
    const seedBody = await pullAfterSeed.json();
    const cursorAfterSeed = seedBody.result.cursors.task;

    // Client A performs unrelate
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "unrelate",
              id: "task:1", relations: { tags: "tag:1" },
              clientId: "clientA", mutationId: "m-unrelate",
            },
          ],
        }),
      }),
    );

    // Client B pulls changes since seed
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientB",
          cursors: { task: cursorAfterSeed, tag: cursorAfterSeed, join_task_tags_tag: cursorAfterSeed },
          includeJoins: true,
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // CRITICAL: task should NOT appear in records[] with a stub { id }
    const taskRecords: any[] = pullBody.result.records.task || [];
    const idOnlyStub = taskRecords.find((r: any) => r.id === "task:1" && Object.keys(r).length === 1);
    expect(idOnlyStub).toBeUndefined();

    // The join row delete SHOULD appear
    expect(pullBody.result.joins).toBeDefined();
    expect(pullBody.result.joins["join_task_tags_tag"]).toBeDefined();
    expect(pullBody.result.joins["join_task_tags_tag"].delete.length).toBeGreaterThan(0);
  });

  it("TV-REL-MANYOONE-FK-001: many-one relate produces FK merge delta in pull merged (not id-only in records)", async () => {
    const server = await createF1Server(db);

    // Insert task (without goalId initially) and goal
    // Note: F1 schema has task with goalId required, so we use a placeholder goal
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "goal", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "goal:1", record: { label: "Goal 1", status: "active", isArchived: false } },
            { resource: "goal", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "goal:2", record: { label: "Goal 2", status: "active", isArchived: false } },
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m3",
              id: "task:10", record: { label: "My task", priority: 5, goalId: "goal:1", isArchived: false, updatedAt: "2026-01-01" } },
          ],
        }),
      }),
    );

    // Capture cursor after seed
    const pullAfterSeed = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "clientB", cursors: { task: "0", goal: "0" } }),
      }),
    );
    const seedBody = await pullAfterSeed.json();
    const cursorAfterSeedTask = seedBody.result.cursors.task;

    // Client A reassigns the task to goal:2 via many-one relate
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "relate",
              id: "task:10", relations: { goal: "goal:2" },
              clientId: "clientA", mutationId: "m-relate-goal",
            },
          ],
        }),
      }),
    );

    // Client B pulls changes
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientB",
          cursors: { task: cursorAfterSeedTask, goal: cursorAfterSeedTask },
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // CRITICAL: task should NOT appear in records[] with a stub { id }
    const taskRecords: any[] = pullBody.result.records.task || [];
    const idOnlyStub = taskRecords.find((r: any) => r.id === "task:10" && Object.keys(r).length === 1);
    expect(idOnlyStub).toBeUndefined();

    // The FK change SHOULD appear in merged[] with the persisted record so clients
    // do not lose unrelated fields while applying the relation update.
    expect(pullBody.result.merged).toBeDefined();
    expect(pullBody.result.merged.task).toBeDefined();
    const fkDelta = pullBody.result.merged.task.find((r: any) => r.id === "task:10");
    expect(fkDelta).toBeDefined();
    expect(fkDelta.goalId).toBe("goal:2"); // FK was updated
    expect(fkDelta.label).toBe("My task");
    expect(fkDelta.priority).toBe(5);
  });

  it("TV-REL-MANYOONE-UNRELATE-001: many-one unrelate clears FK via merge delta (no id-only stub)", async () => {
    const server = await createF1Server(db);

    // Seed task with a goal
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "goal", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "goal:1", record: { label: "Goal 1", status: "active", isArchived: false } },
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "task:10", record: { label: "My task", priority: 5, goalId: "goal:1", isArchived: false, updatedAt: "2026-01-01" } },
          ],
        }),
      }),
    );

    const pullAfterSeed = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "clientB", cursors: { task: "0", goal: "0" } }),
      }),
    );
    const seedBody = await pullAfterSeed.json();
    const cursorAfterSeedTask = seedBody.result.cursors.task;

    // Client A unrelates task from goal
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "unrelate",
              id: "task:10", relations: { goal: "goal:1" },
              clientId: "clientA", mutationId: "m-unrelate-goal",
            },
          ],
        }),
      }),
    );

    // Client B pulls changes
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientB",
          cursors: { task: cursorAfterSeedTask, goal: cursorAfterSeedTask },
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // CRITICAL: No id-only stub in records[]
    const taskRecords: any[] = pullBody.result.records.task || [];
    const idOnlyStub = taskRecords.find((r: any) => r.id === "task:10" && Object.keys(r).length === 1);
    expect(idOnlyStub).toBeUndefined();

    // FK clear SHOULD appear in merged[] as { id, goalId: null }
    expect(pullBody.result.merged).toBeDefined();
    expect(pullBody.result.merged.task).toBeDefined();
    const fkDelta = pullBody.result.merged.task.find((r: any) => r.id === "task:10");
    expect(fkDelta).toBeDefined();
    expect(fkDelta.goalId).toBeNull(); // FK was cleared
  });

  it("TV-REL-CHANGELOG-NOSPURIOUS-001: relate does NOT record op=upsert with {id} stub in changelog", async () => {
    const server = await createF1Server(db);

    // Seed task and tag
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "task:1", record: { label: "Buy milk", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "tag:1", record: { label: "urgent" } },
          ],
        }),
      }),
    );

    // Push a relate mutation
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "relate",
              id: "task:1", relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "clientA", mutationId: "m-relate",
            },
          ],
        }),
      }),
    );

    // Inspect changelog directly
    const changes = await db.internal.findMany(
      "__datafn_changes",
      [{ field: "namespace", op: "eq", value: "datafn" }],
      { orderBy: "server_seq" },
    );

    // There must be NO changelog entry for resource="task" with op="upsert" and only {id} in record
    const spuriousEntry = changes.find((c: any) => {
      if (c.resource !== "task" || c.op !== "upsert") return false;
      try {
        const rec = JSON.parse(c.record as string);
        return rec && Object.keys(rec).length === 1 && rec.id === "task:1";
      } catch { return false; }
    });
    expect(spuriousEntry).toBeUndefined();

    // The join delta MUST be present
    const joinChange = changes.find((c: any) => c.resource && c.resource.startsWith("join_"));
    expect(joinChange).toBeDefined();
  });

  it("TV-REL-PRESERVE-FIELDS-001: other clients pulling after relate keep their full record intact", async () => {
    // This is the core scenario from the issue: Client B's record should not be
    // overwritten with just { id } after Client A performs a relate.
    const server = await createF1Server(db);

    // Seed task and tag
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "seed", mutationId: "m1",
              id: "task:1", record: { label: "Buy milk", priority: 3, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-10" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2",
              id: "tag:urgent", record: { label: "urgent" } },
          ],
        }),
      }),
    );

    // Client B clones — gets the full record
    const cloneRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({ clientId: "clientB", cursors: { task: "0", tag: "0", join_task_tags_tag: "0" }, includeJoins: true }),
      }),
    );
    const cloneBody = await cloneRes.json();
    expect(cloneBody.result.ok).toBe(true);
    const clientBCursorTask = cloneBody.result.cursors.task;
    const clientBCursorTag = cloneBody.result.cursors.tag;
    const clientBCursorJoin = cloneBody.result.cursors["join_task_tags_tag"] || "0";

    // Client A relates task → tag (many-many)
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientA",
          mutations: [
            {
              resource: "task", version: 1, operation: "relate",
              id: "task:1", relations: { tags: [{ $ref: "tag:urgent", order: 1 }] },
              clientId: "clientA", mutationId: "m-relate",
            },
          ],
        }),
      }),
    );

    // Client B pulls incremental changes
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "clientB",
          cursors: { task: clientBCursorTask, tag: clientBCursorTag, join_task_tags_tag: clientBCursorJoin },
          includeJoins: true,
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullBody.result.ok).toBe(true);

    // The task must NOT be in records[] at all (since the primary resource didn't change)
    const taskInRecords = (pullBody.result.records.task || []).find((r: any) => r.id === "task:1");
    expect(taskInRecords).toBeUndefined(); // No task record in upsert bucket

    // The task must NOT be in merged[] either (it's many-many — no FK on primary)
    const taskInMerged = (pullBody.result.merged?.task || []).find((r: any) => r.id === "task:1");
    expect(taskInMerged).toBeUndefined();

    // The join row SHOULD appear in joins
    expect(pullBody.result.joins).toBeDefined();
    expect(pullBody.result.joins["join_task_tags_tag"].upsert.length).toBeGreaterThan(0);
    expect(pullBody.result.joins["join_task_tags_tag"].upsert[0].from).toBe("task:1");
    expect(pullBody.result.joins["join_task_tags_tag"].upsert[0].to).toBe("tag:urgent");
  });

  it("RECON-JOINS: Reconcile includes join counts when requested", async () => {
    // Fixture F1 already has task-tag many-many relation
    const server = await createF1Server(db);

    // Seed data with proper fields matching schema
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { 
              resource: "tag", 
              version: 1, 
              operation: "insert", 
              clientId: "seed", 
              mutationId: "m1", 
              id: "tag:1", 
              record: { label: "one" } 
            },
            { 
              resource: "task", 
              version: 1, 
              operation: "insert", 
              clientId: "seed", 
              mutationId: "m2", 
              id: "task:1", 
              record: { 
                label: "Task 1", 
                priority: 1, 
                goalId: "goal:g1", 
                isArchived: false, 
                updatedAt: "2026-02-07" 
              } 
            },
          ],
        }),
      }),
    );

    // Call reconcile with includeJoins
    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["tag", "task"],
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.counts).toBeDefined();
    expect(body.result.counts.tag).toBe(1);
    expect(body.result.counts.task).toBe(1);
    expect(body.result.joinCounts).toBeDefined();
    // Join store should be empty initially (no relations created yet)
    expect(body.result.joinCounts["join_task_tags_tag"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TV-CLIENT-PULL-001 / TV-CLIENT-PULL-002: hasMore in canonical pull response
// ---------------------------------------------------------------------------

describe("hasMore field in canonical pull response (CLIENT-PULL-001)", () => {
  async function createSimpleServer(db: any) {
    const { memoryAdapter } = await import("@superfunctions/db/adapters");
    const simpleSchema = {
      resources: [
        {
          name: "task",
          version: 1,
          fields: [{ name: "title", type: "string", required: true }],
        },
      ],
    };
    return await createDatafnServer({ allowUnknownResources: true,
      schema: simpleSchema as any,
      limits: { maxLimit: 500, maxPullLimit: 200 },
      database: db,
    });
  }

  async function pushMutations(server: any, count: number) {
    const mutations = Array.from({ length: count }, (_, i) => ({
      resource: "task",
      version: 1,
      operation: "insert",
      clientId: "seeder",
      mutationId: `m${i}`,
      id: `task:${i}`,
      record: { title: `Task ${i}` },
    }));
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({ clientId: "seeder", mutations }),
      }),
    );
  }

  it("TV-CLIENT-PULL-001: 150 changes with limit 100 → hasMore=true", async () => {
    const { memoryAdapter } = await import("@superfunctions/db/adapters");
    const db = memoryAdapter();
    await db.initialize();
    const server = await createSimpleServer(db);

    await pushMutations(server, 150);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { task: "0" },
          limit: 100,
        }),
      }),
    );

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.hasMore).toBe(true);
    // Should return exactly 100 records
    expect(body.result.records.task).toHaveLength(100);
  });

  it("TV-CLIENT-PULL-002: 50 changes with limit 100 → hasMore=false", async () => {
    const { memoryAdapter } = await import("@superfunctions/db/adapters");
    const db = memoryAdapter();
    await db.initialize();
    const server = await createSimpleServer(db);

    await pushMutations(server, 50);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { task: "0" },
          limit: 100,
        }),
      }),
    );

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.hasMore).toBe(false);
    // Should return all 50 records
    expect(body.result.records.task).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// TST-003: Transaction Rollback Assertions
// Previously "commented out" — now unconditional per TST-003 requirement.
// ---------------------------------------------------------------------------

import { executeTransaction } from "../src/execution/transact.js";
import { vi } from "vitest";

function makeIdempotencyStore() {
  const store = new Map<string, any>();
  return {
    get: vi.fn(async (clientId: string, mutationId: string) =>
      store.get(`${clientId}:${mutationId}`) ?? null,
    ),
    set: vi.fn(async (clientId: string, mutationId: string, result: any) => {
      store.set(`${clientId}:${mutationId}`, result);
    }),
  };
}

const taskSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "status", type: "string" as const, required: false },
      ],
    },
  ],
};

describe("TST-003: Transaction rollback assertions (unconditional)", () => {
  it("TV-REL-005: failed step causes all prior results to be annotated rolledBack: true", async () => {
    const db = memoryAdapter();
    let insertCount = 0;
    const originalCreate = db.create.bind(db);
    (db as any).transaction = async (fn: any) => {
      const txDb = new Proxy(db, {
        get(target, prop) {
          if (prop === "create") {
            return async (params: any) => {
              insertCount++;
              if (insertCount === 3) throw new Error("constraint violation");
              return originalCreate(params);
            };
          }
          return (target as any)[prop];
        },
      });
      await fn(txDb);
    };

    const idempotencyStore = makeIdempotencyStore();
    const result = await executeTransaction(
      {
        atomic: true,
        steps: [
          { mutation: { resource: "task", operation: "insert", id: "task:1", record: { title: "A" } } as any },
          { mutation: { resource: "task", operation: "insert", id: "task:2", record: { title: "B" } } as any },
          { mutation: { resource: "task", operation: "insert", id: "task:3", record: { title: "C" } } as any },
        ],
      },
      taskSchema as any,
      db,
      idempotencyStore,
      undefined,
      "default",
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(result.result?.ok).toBe(false);
    expect(result.result?.error?.code).toBe("TRANSACTION_ROLLED_BACK");

    const results = result.result!.results;

    // Unconditional assertions — previously "commented out" per TST-003:
    expect(results[0].ok).toBe(false);
    expect(results[0].rolledBack).toBe(true);  // was: // expect(results[0].rolledBack).toBe(true)
    expect(results[0].result).toBeDefined();

    expect(results[1].ok).toBe(false);
    expect(results[1].rolledBack).toBe(true);  // was: // expect(results[1].rolledBack).toBe(true)

    expect(results[2].ok).toBe(false);
    expect(results[2].rolledBack).toBeUndefined();
  });

  it("TV-REL-005b: rolled-back task is NOT persisted (taskNew is null)", async () => {
    const db = memoryAdapter();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: taskSchema as any,
      database: db,
    });

    let insertCount = 0;
    const originalCreate = db.create.bind(db);
    const originalDelete = db.delete.bind(db);
    (db as any).transaction = async (fn: any) => {
      // Simulate a real transactional DB: track inserts so we can undo them on failure
      const insertedRecords: Array<{ model: string; id: string; namespace: string }> = [];
      const txDb = new Proxy(db, {
        get(target, prop) {
          if (prop === "create") {
            return async (params: any) => {
              insertCount++;
              if (insertCount === 2) throw new Error("step 1 fails");
              const result = await originalCreate(params);
              insertedRecords.push({
                model: params.model,
                id: params.data.id,
                namespace: params.namespace || "default",
              });
              return result;
            };
          }
          return (target as any)[prop];
        },
      });
      try {
        await fn(txDb);
      } catch {
        // Simulate rollback: undo inserts in reverse order
        for (const rec of insertedRecords.reverse()) {
          await originalDelete({
            model: rec.model,
            where: [{ field: "id", operator: "eq" as const, value: rec.id }],
            namespace: rec.namespace,
          });
        }
      }
    };

    const idempotencyStore = makeIdempotencyStore();
    await executeTransaction(
      {
        atomic: true,
        steps: [
          { mutation: { resource: "task", operation: "insert", id: "task:rb1", record: { title: "Should not persist" } } as any },
          { mutation: { resource: "task", operation: "insert", id: "task:rb2", record: { title: "Fails" } } as any },
        ],
      },
      taskSchema as any,
      db,
      idempotencyStore,
      undefined,
      "default",
      undefined,
    );

    // Query for the rolled-back task — must not exist
    const queryRes = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "task", filters: { id: { $eq: "task:rb1" } } }),
      }),
    );
    const queryBody = await queryRes.json();
    expect(queryBody.ok).toBe(true);

    const taskNew = queryBody.result?.data?.find((r: any) => r.id === "task:rb1") ?? null;
    expect(taskNew).toBeNull();  // TST-003: previously "// expect(taskNew).toBeNull()"
  });

  it("TV-REL-006: successful transaction has no rolledBack annotation", async () => {
    const db = memoryAdapter();
    (db as any).transaction = async (fn: any) => { await fn(db); };

    const idempotencyStore = makeIdempotencyStore();
    const result = await executeTransaction(
      {
        atomic: true,
        steps: [
          { mutation: { resource: "task", operation: "insert", id: "task:ok1", record: { title: "A" } } as any },
          { mutation: { resource: "task", operation: "insert", id: "task:ok2", record: { title: "B" } } as any },
        ],
      },
      taskSchema as any,
      db,
      idempotencyStore,
      undefined,
      "default",
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(result.result?.ok).toBe(true);

    // Unconditional: no rolledBack on any result
    for (const r of result.result!.results) {
      expect(r.rolledBack).toBeUndefined();
      expect(r.ok).toBe(true);
    }
  });

  it("rolledBack annotation includes original ok: true result for debugging", async () => {
    const db = memoryAdapter();
    let insertCount = 0;
    const originalCreate = db.create.bind(db);
    (db as any).transaction = async (fn: any) => {
      const txDb = new Proxy(db, {
        get(target, prop) {
          if (prop === "create") {
            return async (params: any) => {
              insertCount++;
              if (insertCount === 2) throw new Error("fail");
              return originalCreate(params);
            };
          }
          return (target as any)[prop];
        },
      });
      await fn(txDb);
    };

    const idempotencyStore = makeIdempotencyStore();
    const result = await executeTransaction(
      {
        atomic: true,
        steps: [
          { mutation: { resource: "task", operation: "insert", id: "task:rba", record: { title: "Will rollback" } } as any },
          { mutation: { resource: "task", operation: "insert", id: "task:rbb", record: { title: "Fails" } } as any },
        ],
      },
      taskSchema as any,
      db,
      idempotencyStore,
      undefined,
      "default",
      undefined,
    );

    const results = result.result!.results;
    expect(results[0].rolledBack).toBe(true);
    expect(results[0].result?.ok).toBe(true); // original result preserved
  });
});

// ---------------------------------------------------------------------------
// TST-005 (partial): Concurrent push tests
// ---------------------------------------------------------------------------

describe("TST-005 (sync): Concurrent push produces correct ordering", () => {
  it("two clients pushing concurrently both succeed with all records persisted", async () => {
    const db = memoryAdapter();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: taskSchema as any,
      database: db,
    });

    const makePushReq = (clientId: string, mutations: any[]) =>
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, mutations: mutations.map((m) => ({ ...m, clientId })) }),
      });

    const [res1, res2] = await Promise.all([
      server.router.handle(
        makePushReq("c1", [
          { resource: "task", operation: "insert", id: "task:cc1", mutationId: "mm1", record: { title: "C1" } },
          { resource: "task", operation: "insert", id: "task:cc2", mutationId: "mm2", record: { title: "C1-2" } },
        ]),
      ),
      server.router.handle(
        makePushReq("c2", [
          { resource: "task", operation: "insert", id: "task:cc3", mutationId: "mm3", record: { title: "C2" } },
          { resource: "task", operation: "insert", id: "task:cc4", mutationId: "mm4", record: { title: "C2-2" } },
        ]),
      ),
    ]);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body1.ok).toBe(true);
    expect(body2.ok).toBe(true);

    // Verify all 4 tasks persisted
    const queryRes = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "task" }),
      }),
    );
    const queryBody = await queryRes.json();
    expect(queryBody.ok).toBe(true);
    expect(queryBody.result.data).toHaveLength(4);
  });

  it("idempotent mutations pushed twice are deduplicated (no duplicate records)", async () => {
    const db = memoryAdapter();
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: taskSchema as any,
      database: db,
    });

    const mutation = {
      resource: "task",
      operation: "insert",
      id: "task:idem-cc",
      mutationId: "idempotent-cc1",
      record: { title: "Idempotent" },
    };

    const makePushReq = (clientId: string) =>
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, mutations: [{ ...mutation, clientId }] }),
      });

    await server.router.handle(makePushReq("c1"));
    await server.router.handle(makePushReq("c1")); // duplicate

    const queryRes = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "task", filters: { id: { $eq: "task:idem-cc" } } }),
      }),
    );
    const queryBody = await queryRes.json();
    expect(queryBody.ok).toBe(true);
    expect(queryBody.result.data).toHaveLength(1); // exactly 1 — deduped
  });
});

describe("MRG-003: push merge race retry behavior", () => {
  it("retries update once after create conflict and succeeds", async () => {
    const baseDb = memoryAdapter();
    await baseDb.initialize();
    baseDb.capabilities.transactions.supported = false;
    const baseCreate = baseDb.create.bind(baseDb);
    const baseUpdate = baseDb.update.bind(baseDb);
    let updateCalls = 0;
    let insertedByConcurrentWriter = false;

    const db = new Proxy(baseDb, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return async (params: any) => {
            const id = params?.where?.[0]?.value;
            if (params?.model === "task" && id === "task:race-ok") {
              updateCalls += 1;
              if (updateCalls === 1) {
                const err: any = new Error("Record not found");
                err.name = "NotFoundError";
                throw err;
              }
            }
            return baseUpdate(params);
          };
        }
        if (prop === "create") {
          return async (params: any) => {
            if (params?.model === "task" && params?.data?.id === "task:race-ok" && !insertedByConcurrentWriter) {
              insertedByConcurrentWriter = true;
              await baseCreate(params); // simulate concurrent insert winning the race
              const err: any = new Error("duplicate key value violates unique constraint");
              err.code = "23505";
              throw err;
            }
            return baseCreate(params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: taskSchema as any,
      database: db as any,
    });

    const res = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "race-client",
          mutations: [
            {
              resource: "task",
              version: 1,
              operation: "merge",
              clientId: "race-client",
              mutationId: "m-race-ok",
              id: "task:race-ok",
              record: { title: "Race title", status: "done" },
            },
          ],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.applied).toContain("m-race-ok");
    expect(body.result.errors).toHaveLength(0);
    expect(updateCalls).toBe(2);
  });

  it("returns NOT_FOUND when retry update still fails after create conflict", async () => {
    const baseDb = memoryAdapter();
    await baseDb.initialize();
    baseDb.capabilities.transactions.supported = false;
    const baseCreate = baseDb.create.bind(baseDb);

    const db = new Proxy(baseDb, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return async (params: any) => {
            const id = params?.where?.[0]?.value;
            if (params?.model === "task" && id === "task:race-fail") {
              const err: any = new Error("Record not found");
              err.name = "NotFoundError";
              throw err;
            }
            return (target as any).update(params);
          };
        }
        if (prop === "create") {
          return async (params: any) => {
            if (params?.model === "task" && params?.data?.id === "task:race-fail") {
              const err: any = new Error("duplicate key");
              err.code = "SQLITE_CONSTRAINT_UNIQUE";
              throw err;
            }
            return baseCreate(params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: taskSchema as any,
      database: db as any,
    });

    const res = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "race-client",
          mutations: [
            {
              resource: "task",
              version: 1,
              operation: "merge",
              clientId: "race-client",
              mutationId: "m-race-fail",
              id: "task:race-fail",
              record: { title: "Race title", status: "done" },
            },
          ],
        }),
      }),
    );

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.result.ok).toBe(false);
    expect(body.result.applied).not.toContain("m-race-fail");
    expect(body.result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mutationId: "m-race-fail", code: "NOT_FOUND", path: "id" }),
      ]),
    );
  });
});

 it.each(["constructor", "prototype", "__proto__"])("round-trips canonical changes for own resource key %s", async name => {
  const server = await createDatafnServer({allowUnknownResources: true, database: memoryAdapter(), schema: {resources: [{name, version: 1, fields: [{name: "label", type: "string"}]}]}});
  const request = async (action: string, payload: unknown) => (await server.router.handle(new Request(`http://localhost/datafn/${action}`, {method: "POST", body: JSON.stringify(payload)}))).json();
  let cursor = "0";
  for (const operation of ["insert", "merge", "delete"] as const) {
    const push = await request("push", {clientId: "writer", mutations: [{resource: name, version: 1, operation, clientId: "writer", mutationId: operation, id: "r1", record: {label: operation}}]});
    expect(push.ok, JSON.stringify(push)).toBe(true);
    expect(push.result.applied).toContain(operation);
    const pull = await request("pull", {clientId: "reader", cursors: {[name]: cursor}});
    expect(pull.result.ok).toBe(true);
    expect(Object.hasOwn(pull.result.cursors, name)).toBe(true);
    expect(Number(pull.result.cursors[name])).toBeGreaterThan(Number(cursor));
    const changes = pull.result[operation === "insert" ? "records" : operation === "merge" ? "merged" : "deleted"];
    expect(Object.hasOwn(changes, name)).toBe(true);
    expect(changes[name]).toHaveLength(1);
    cursor = pull.result.cursors[name];
  }
 });
