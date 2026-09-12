import { describe, it, expect } from "vitest";
import { decideMergeMode, executeSchemaAwareMerge } from "../merge-decision.js";
import type { DatafnSchema } from "../../../core-types.js";

const schema: DatafnSchema = { resources: [{ name: "task", version: 1, fields: [
  { name: "title", type: "string", required: true, nullable: true },
]}], relations: [] };

describe("merge-create nullable required fields", () => {
  it("creates a missing record with an explicitly supplied null", async () => {
    const created: Record<string, unknown>[] = [];
    const result = await executeSchemaAwareMerge({
      schema, resource: "task", id: "task:1", delta: { title: null },
      update: async () => { throw new Error("not found"); },
      create: async (record) => { created.push(record); },
    });
    expect(result.ok).toBe(true);
    expect(created).toEqual([{ id: "task:1", title: null }]);
  });
  it("does not treat an absent required field as supplied", () => {
    expect(decideMergeMode(schema, "task", "task:1", {}).mode).toBe("not_found");
    expect(decideMergeMode(schema, "task", "task:1", { title: undefined }).mode).toBe("not_found");
  });
});
