import { describe, expect, it } from "vitest";
import { generateTypes } from "../codegen.js";
import { generateDrizzleSchema } from "../drizzle-codegen.js";

const str = (name: string, required = false) => ({ name, type: "string", required });

const schema = {
  namespaced: false,
  resources: [
    { name: "goals", version: 1, fields: [str("id", true), str("label"), str("parentId")] },
    { name: "notes", version: 1, fields: [str("id", true), str("body")] },
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
  ],
};

describe("codegen: isAncestorInactive system field", () => {
  it("emits a single required readonly boolean on owning resources only", () => {
    const output = generateTypes(schema);
    const occurrences = output.match(/isAncestorInactive/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(output).toContain("readonly isAncestorInactive: boolean;");
    expect(output).not.toContain("isAncestorInactive?:");
    const notes = output.slice(output.indexOf("interface Notes"));
    expect(notes).not.toContain("isAncestorInactive");
  });

  it("emits one non-null default-false column", () => {
    const output = generateDrizzleSchema(schema, "postgres");
    const columns = output.match(/isAncestorInactive: /g) ?? [];
    expect(columns).toHaveLength(1);
    expect(output).toContain(
      'isAncestorInactive: boolean("is_ancestor_inactive").notNull().default(false),',
    );
  });

  it("fails codegen when a consumer declares the field", () => {
    const declared = {
      ...schema,
      resources: [
        {
          ...schema.resources[0],
          fields: [...schema.resources[0]!.fields, { name: "isAncestorInactive", type: "boolean" }],
        },
        schema.resources[1],
      ],
    };
    expect(() => generateTypes(declared)).toThrow(/system field/);
    expect(() => generateDrizzleSchema(declared, "postgres")).toThrow(/system field/);
  });
});
