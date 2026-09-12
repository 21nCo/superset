import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { executeLocalQuery } from "../src/offline/query.js";

const schema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "description", type: "string" as const, required: false },
        { name: "note", type: "string" as const, required: false, nullable: true },
      ],
    },
  ],
  relations: [],
} as const;

describe("@datafn/client local query null normalization", () => {
  async function seedStorage() {
    const storage = new MemoryStorageAdapter(["task"]);
    // Simulates a record hydrated from a synced replace clear: the explicit
    // null is the transport-safe clear representation.
    await storage.upsertRecord("task", {
      id: "task:1",
      title: "Alpha",
      description: null,
      note: null,
    });
    return storage;
  }

  it("no-select local queries expose cleared non-nullable fields as undefined", async () => {
    const storage = await seedStorage();
    const result = await executeLocalQuery(storage, schema, {
      resource: "task",
      version: 1,
    });

    expect(result.data).toHaveLength(1);
    const row = result.data![0];
    expect(row.title).toBe("Alpha");
    expect(row.description).toBeUndefined();
    expect("description" in row).toBe(false);
    // Nullable fields keep their explicit null.
    expect(row.note).toBeNull();
    // The stored record is not mutated.
    const stored = await storage.getRecord("task", "task:1");
    expect(stored?.description).toBeNull();
  });

  it("$is_null treats cleared and nullable fields uniformly", async () => {
    const storage = await seedStorage();

    // $is_null matches both null and absent values by design
    // (core filters.ts), so filtering is unaffected by normalization.
    const cleared = await executeLocalQuery(storage, schema, {
      resource: "task",
      version: 1,
      filters: { description: { $is_null: true } },
    });
    expect(cleared.data).toHaveLength(1);

    const nullable = await executeLocalQuery(storage, schema, {
      resource: "task",
      version: 1,
      filters: { note: { $is_null: true } },
    });
    expect(nullable.data).toHaveLength(1);
    expect(nullable.data![0].id).toBe("task:1");
  });

  it("wildcard select results match the same normalized shape", async () => {
    const storage = await seedStorage();
    const result = await executeLocalQuery(storage, schema, {
      resource: "task",
      version: 1,
      select: ["*"],
    });

    expect(result.data).toHaveLength(1);
    const row = result.data![0];
    expect("description" in row).toBe(false);
    expect(row.note).toBeNull();
  });
  it("aggregate filters keep stored nulls while only non-nullable group keys are omitted", async () => {
    const storage = await seedStorage();
    const result = await executeLocalQuery(storage, schema, {
      resource: "task", version: 1,
      filters: { description: { $eq: null } },
      groupBy: ["description", "note"],
      having: { description: { $eq: null } },
      aggregations: { total: { op: "count", field: "id" } },
    });
    expect(result.groups).toEqual([{ note: null, total: 1 }]);
    expect((await storage.getRecord("task", "task:1"))?.description).toBeNull();
  });

});
