import { describe, expect, it } from "vitest";
import { stripNullsForNonNullableFields } from "../src/records.js";
import type { DatafnResourceSchema } from "../src/types.js";

const resource: DatafnResourceSchema = {
  name: "task",
  version: 1,
  fields: [
    { name: "title", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "deletedAt", type: "date", required: false, nullable: true },
  ],
};

describe("stripNullsForNonNullableFields", () => {
  it("removes null for non-nullable fields so reads expose undefined", () => {
    const record = {
      id: "task:1",
      title: "Hello",
      description: null,
      deletedAt: null,
      trashedAt: null,
      __ns: "ns:1",
    };
    const result = stripNullsForNonNullableFields(record, resource);
    expect(result).toEqual({
      id: "task:1",
      title: "Hello",
      deletedAt: null,
      trashedAt: null,
      __ns: "ns:1",
    });
    expect("description" in result).toBe(false);
    // Nullable and undeclared fields keep their null.
    expect(result.deletedAt).toBeNull();
    expect(result.trashedAt).toBeNull();
    // The input record is not mutated.
    expect(record.description).toBeNull();
  });

  it("returns the same record reference when nothing is stripped", () => {
    const record = { id: "task:1", title: "Hello", deletedAt: null };
    expect(stripNullsForNonNullableFields(record, resource)).toBe(record);
  });

  it("returns the record unchanged when the resource is unknown", () => {
    const record = { id: "task:1", description: null };
    expect(stripNullsForNonNullableFields(record, undefined)).toBe(record);
  });
});
