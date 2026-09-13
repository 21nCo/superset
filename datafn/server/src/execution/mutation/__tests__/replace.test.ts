import { describe, it, expect, beforeEach } from "vitest";
import { createDatafnServer } from "../../../server.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { DatafnSchema } from "../../../core-types.js";

// Schema for testing
const schema: DatafnSchema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      idPrefix: "task",
      capabilities: ["timestamps", "audit"] as any,
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "description", type: "string" as const, required: false },
        { name: "status", type: "string" as const, required: false, default: "active" },
        { name: "priority", type: "string" as const, required: false },
        { name: "slug", type: "string" as const, required: false, readonly: true },
        {
          name: "nullableDefault",
          type: "string" as const,
          required: true,
          nullable: true,
          default: null,
        },
      ],
    },
  ],
  relations: [],
};

describe("MUT-REPLACE-001: Replace Operation Semantics", () => {
  let server: any;
  let db: any;

  beforeEach(async () => {
    db = memoryAdapter();
    await db.initialize();
    
    // Seed initial data
    await db.create({
      model: "tasks",
      data: {
        id: "task-1",
        title: "Old Title",
        description: "Old Description",
        status: "pending",
        priority: "high",
        slug: "old-slug",
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "user-1",
        updatedAt: "2026-01-01T00:00:00Z",
        updatedBy: "user-1"
      },
      namespace: "datafn"
    });

    server = await createDatafnServer({ allowUnknownResources: true,
      schema,
      database: db,
    });
  });

  it("TV-MUT-REPLACE-CLEAR-001: Replace with existing record clears unspecified fields", async () => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "tasks",
        version: "1",
        clientId: "client-1",
        mutationId: "mut-replace-1",
        operation: "replace",
        id: "task-1",
        record: {
          title: "New Title"
          // description, status, priority omitted -> should be cleared/defaulted
        }
      }),
    });

    const res = await server.router.handle(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify record state
    const task = await db.findOne({
      model: "tasks",
      where: [{ field: "id", operator: "eq", value: "task-1" }],
      namespace: "datafn"
    });

    expect(task.title).toBe("New Title");
    // Cleared fields persist as null: null is the only clear every supported
    // adapter applies (Drizzle/Prisma ignore undefined) and it survives JSON
    // change tracking. Read paths normalize it back to undefined.
    expect(task.description).toBeNull();
    expect(task.status).toBe("active"); // Default
    expect(task.priority).toBeNull();
    expect(task.nullableDefault).toBeNull(); // Nullable default

    // Query results expose cleared non-nullable fields as undefined again.
    const queryRes = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "tasks",
          filters: { id: { $eq: "task-1" } },
        }),
      }),
    );
    const queryBody = await queryRes.json();
    expect(queryBody.ok).toBe(true);
    const [row] = queryBody.result.data;
    expect(row.title).toBe("New Title");
    expect(row.description).toBeUndefined();
    expect("description" in row).toBe(false);
    expect(row.priority).toBeUndefined();
    expect("priority" in row).toBe(false);
    // Nullable fields keep their explicit null on read.
    expect(row.nullableDefault).toBeNull();
  });

  it("Replace preserves readonly schema fields clients cannot supply", async () => {
    // Write validation rejects readonly keys...
    const rejectedRes = await server.router.handle(
      new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "tasks",
          version: "1",
          clientId: "client-1",
          mutationId: "mut-replace-readonly",
          operation: "replace",
          id: "task-1",
          record: { title: "New Title", slug: "new-slug" },
        }),
      }),
    );
    const rejectedBody = await rejectedRes.json();
    expect(rejectedBody.ok).toBe(false);

    // ...so a replace necessarily omits readonly fields and must carry the
    // stored value forward instead of clearing it.
    const res = await server.router.handle(
      new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "tasks",
          version: "1",
          clientId: "client-1",
          mutationId: "mut-replace-readonly-2",
          operation: "replace",
          id: "task-1",
          record: { title: "New Title" },
        }),
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const task = await db.findOne({
      model: "tasks",
      where: [{ field: "id", operator: "eq", value: "task-1" }],
      namespace: "datafn",
    });
    expect(task.title).toBe("New Title");
    expect(task.slug).toBe("old-slug");
  });

  it("Replace preserves system fields and updates timestamps", async () => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "tasks",
        version: "1",
        clientId: "client-1",
        mutationId: "mut-replace-2",
        operation: "replace",
        id: "task-1",
        record: { title: "New Title" }
      }),
    });

    const res = await server.router.handle(req);
    await res.json();

    const task = await db.findOne({
      model: "tasks",
      where: [{ field: "id", operator: "eq", value: "task-1" }],
      namespace: "datafn"
    });

    // Preserved
    expect(task.id).toBe("task-1");
    expect(task.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(task.createdBy).toBe("user-1");

    // Updated
    expect(task.updatedAt).not.toBe("2026-01-01T00:00:00Z");
    // We didn't provide updatedBy, and since we don't have context, 
    // it likely defaults to null or preserved depending on implementation?
    // In our implementation: `result[key] = field.default !== undefined ? field.default : null;`
    // So updatedBy should be null if not provided and not in schema default.
    expect(task.updatedBy).toBeNull(); 
  });

  it("TV-MUT-REPLACE-NOTFOUND-001: Replace on non-existent record returns NOT_FOUND", async () => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "tasks",
        version: "1",
        clientId: "client-1",
        mutationId: "mut-replace-notfound",
        operation: "replace",
        id: "task-nonexistent",
        record: { title: "Test" }
      }),
    });

    const res = await server.router.handle(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Record not found");
  });

  it("TV-MUT-REPLACE-REQUIRED-001: Replace missing required field returns DFQL_INVALID", async () => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "tasks",
        version: "1",
        clientId: "client-1",
        mutationId: "mut-replace-invalid",
        operation: "replace",
        id: "task-1",
        record: { 
          // title is required but missing
          description: "New Desc"
        }
      }),
    });

    const res = await server.router.handle(req);
    const body = await res.json();

    // Since validation happens before execution (PHASE_01), this might be caught there.
    // BUT `replace` specific required check (clearing unspecified fields) happens in execution.
    // The PHASE_01 validation only checks if provided fields are valid keys.
    // It doesn't check if required fields are present for replace vs merge.
    // So this error should come from `buildReplaceRecord`.
    
    // Wait, PHASE_01 validation might check required fields for `insert`?
    // For `replace`, `validateMutation` doesn't know about full replacement semantics vs required fields yet.
    // So it passes validation and fails in execution.

    expect(res.status).toBe(400); // Bad Request (from buildReplaceRecord)
    expect(body.ok).toBe(false);
    // Is it DFQL_INVALID or CONFLICT? 
    // `buildReplaceRecord` returns DFQL_INVALID.
    // `executeMutation` wraps it in `opResult`.
    // Then `createMutationHandler` returns the error.
    
    // If it's DFQL_INVALID, it's a 400.
    
    if (res.status === 200) {
        // Single mutation error envelope
        expect(body.result.ok).toBe(false);
        expect(body.result.errors[0].code).toBe("DFQL_INVALID");
    } else {
        // Top-level error
        expect(body.error.code).toBe("DFQL_INVALID");
        expect(body.error.message).toContain("Required field missing");
    }
  });

  it("Merge still works as partial update (no regression)", async () => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "tasks",
        version: "1",
        clientId: "client-1",
        mutationId: "mut-merge-1",
        operation: "merge",
        id: "task-1",
        record: {
          title: "Merged Title"
          // description omitted -> should be PRESERVED
        }
      }),
    });

    const res = await server.router.handle(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const task = await db.findOne({
      model: "tasks",
      where: [{ field: "id", operator: "eq", value: "task-1" }],
      namespace: "datafn"
    });

    expect(task.title).toBe("Merged Title");
    expect(task.description).toBe("Old Description"); // Preserved!
  });
});
