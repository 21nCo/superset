import { describe, expectTypeOf, it } from "vitest";
import { defineSchema } from "@datafn/core";
import type { DatafnResourceRecord } from "../src/tables/table.js";

describe("isAncestorInactive inferred record types", () => {
  const schema = defineSchema({
    resources: [
      {
        name: "goals",
        version: 1,
        fields: [
          { name: "label", type: "string" as const, required: true },
          { name: "parentId", type: "string" as const, required: false },
        ],
      },
      {
        name: "tasks",
        version: 1,
        fields: [{ name: "goalId", type: "string" as const, required: false }],
      },
      {
        name: "notes",
        version: 1,
        fields: [{ name: "body", type: "string" as const, required: true }],
      },
    ],
    relations: [
      {
        from: "goals",
        to: "goals",
        type: "htree",
        relation: "children",
        inverse: "parent",
        fkField: "parentId",
        inheritsInactive: true,
      },
      {
        from: "tasks",
        to: "goals",
        type: "many-one",
        relation: "goal",
        inverse: "tasks",
        fkField: "goalId",
        inheritsInactive: true,
      },
    ],
  });

  it("is a required boolean on dependent resources", () => {
    type Goal = DatafnResourceRecord<typeof schema, "goals">;
    type Task = DatafnResourceRecord<typeof schema, "tasks">;
    expectTypeOf<Goal["isAncestorInactive"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Task["isAncestorInactive"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Goal>().toHaveProperty("isAncestorInactive");
    expectTypeOf<Goal["label"]>().toEqualTypeOf<string>();
  });

  it("is absent on resources that are not dependents", () => {
    type Note = DatafnResourceRecord<typeof schema, "notes">;
    expectTypeOf<Note>().not.toHaveProperty("isAncestorInactive");
  });
});
