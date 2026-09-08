import { describe, it, expect } from "vitest";
import { executeQuery } from "../execute.js";
import type { DataStore } from "../../store.js";
import type { DatafnSchema } from "../../../core-types.js";

// A non-nullable `description` that a replace cleared persists as null in the
// store. In-memory execution must observe the same rows as the FULL_PUSHDOWN
// strategy (SQL IS NULL) while still normalizing cleared fields out of the
// returned records.
const schema: DatafnSchema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "description", type: "string" as const, required: false },
      ],
    },
  ],
  relations: [],
};

function makeStore(records: Record<string, unknown>[]): DataStore {
  return {
    getRecords: (resource: string) => (resource === "tasks" ? records : []),
    getRecord: (_resource: string, id: string) =>
      records.find((record) => record.id === id) ?? null,
    getJoinRows: () => [],
    findRecords: (_resource: string, field: string, value: unknown) =>
      records.filter((record) => record[field] === value),
  };
}

describe("executeQuery null normalization", () => {
  const records = [
    { id: "task-1", title: "One", description: null }, // replace-cleared
    { id: "task-2", title: "Two", description: "kept" },
  ];

  it("$eq: null matches stored nulls like pushdown IS NULL", () => {
    const result = executeQuery(
      {
        resource: "tasks",
        filters: { description: { $eq: null } },
      } as any,
      schema,
      makeStore(records),
    ) as { data: Record<string, unknown>[] };

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("task-1");
    // The read contract still normalizes the cleared field to absent.
    expect(result.data[0].description).toBeUndefined();
    expect("description" in result.data[0]).toBe(false);
  });

  it("$is_null matches cleared and unset fields uniformly", () => {
    const result = executeQuery(
      {
        resource: "tasks",
        filters: { description: { $is_null: true } },
      } as any,
      schema,
      makeStore(records),
    ) as { data: Record<string, unknown>[] };

    expect(result.data.map((row) => row.id)).toEqual(["task-1"]);
  });

  it("returned records omit cleared non-nullable fields without a select", () => {
    const result = executeQuery(
      { resource: "tasks" } as any,
      schema,
      makeStore(records),
    ) as { data: Record<string, unknown>[] };

    const cleared = result.data.find((row) => row.id === "task-1")!;
    expect(cleared.description).toBeUndefined();
    expect("description" in cleared).toBe(false);
    const kept = result.data.find((row) => row.id === "task-2")!;
    expect(kept.description).toBe("kept");
  });

  it("aggregate group keys normalize cleared fields to absent", () => {
    const result = executeQuery(
      {
        resource: "tasks",
        groupBy: ["description"],
        aggregations: { total: { op: "count", field: "id" } },
      } as any,
      schema,
      makeStore(records),
    ) as unknown as { groups: Record<string, unknown>[] };

    const clearedGroup = result.groups.find(
      (group) => !("description" in group),
    );
    expect(clearedGroup).toBeDefined();
    expect(clearedGroup!.total).toBe(1);
    const keptGroup = result.groups.find(
      (group) => group.description === "kept",
    );
    expect(keptGroup).toBeDefined();
    expect(keptGroup!.total).toBe(1);
  });
});
