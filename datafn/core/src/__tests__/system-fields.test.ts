import { describe, expect, it } from "vitest";
import { validateSchema } from "../schema.js";
import {
  ANCESTOR_INACTIVE_FIELD,
  ANCESTOR_INACTIVE_FIELD_DEF,
  findSystemFieldWrite,
  getAncestorInactiveResources,
  resourceRequiresAncestorInactive,
} from "../system-fields.js";

const goals = {
  name: "goals",
  version: 1,
  fields: [
    { name: "label", type: "string" as const, required: false },
    { name: "parentId", type: "string" as const, required: false },
  ],
};
const tasks = {
  name: "tasks",
  version: 1,
  fields: [
    { name: "title", type: "string" as const, required: false },
    { name: "goalId", type: "string" as const, required: false },
  ],
};
const notes = {
  name: "notes",
  version: 1,
  fields: [{ name: "body", type: "string" as const, required: false }],
};

const htree = {
  from: "goals",
  to: "goals",
  type: "htree",
  relation: "children",
  inverse: "parent",
  fkField: "parentId",
  inheritsInactive: true,
};
const manyOne = {
  from: "tasks",
  to: "goals",
  type: "many-one",
  relation: "goal",
  inverse: "tasks",
  fkField: "goalId",
  inheritsInactive: true,
};

function fieldsOf(result: ReturnType<typeof validateSchema>, resource: string) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result.resources.find((r) => r.name === resource)!.fields;
}

describe("isAncestorInactive system field", () => {
  it("injects the canonical field into dependent resources of inheritsInactive relations", () => {
    const result = validateSchema({ resources: [goals, tasks, notes], relations: [htree, manyOne] });
    expect(result.ok).toBe(true);

    const goalField = fieldsOf(result, "goals").filter((f) => f.name === ANCESTOR_INACTIVE_FIELD);
    expect(goalField).toHaveLength(1);
    expect(goalField[0]).toEqual({
      name: "isAncestorInactive",
      type: "boolean",
      required: true,
      nullable: false,
      readonly: true,
      default: false,
    });
    expect(goalField[0]).toEqual(ANCESTOR_INACTIVE_FIELD_DEF);

    expect(fieldsOf(result, "tasks").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(true);
    expect(fieldsOf(result, "notes").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(false);
  });

  it("does not inject when the relation does not inherit inactivity", () => {
    const result = validateSchema({
      resources: [goals, tasks],
      relations: [{ ...manyOne, inheritsInactive: false }],
    });
    expect(result.ok).toBe(true);
    expect(fieldsOf(result, "tasks").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(false);
    expect(fieldsOf(result, "goals").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(false);
  });

  it("uses the parent side of many-one as the parent, not the dependent", () => {
    const result = validateSchema({ resources: [goals, tasks], relations: [manyOne] });
    expect(fieldsOf(result, "tasks").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(true);
    expect(fieldsOf(result, "goals").some((f) => f.name === ANCESTOR_INACTIVE_FIELD)).toBe(false);
  });

  it("rejects consumer declarations of the field with SYSTEM_FIELD_COLLISION", () => {
    const result = validateSchema({
      resources: [
        { ...goals, fields: [...goals.fields, { name: "isAncestorInactive", type: "boolean", required: false }] },
      ],
      relations: [htree],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SYSTEM_FIELD_COLLISION");
    expect(result.error.details).toEqual({ path: "resources.goals.fields.isAncestorInactive" });
  });

  it("still allows a consumer field named isAncestorInactive on resources without inheritsInactive", () => {
    const result = validateSchema({
      resources: [{ ...notes, fields: [...notes.fields, { name: "isAncestorInactive", type: "boolean" }] }],
      relations: [],
    });
    expect(result.ok).toBe(true);
  });

  it("no longer requires consumers to declare the field", () => {
    const result = validateSchema({ resources: [goals], relations: [htree] });
    expect(result.ok).toBe(true);
  });
});

describe("system field helpers", () => {
  const relations = [htree, manyOne] as const;

  it("getAncestorInactiveResources works on raw relations and ignores many-many", () => {
    const set = getAncestorInactiveResources([
      ...relations,
      { from: "tasks", to: "notes", type: "many-many", relation: "x", inheritsInactive: true },
      { from: "notes", to: ["goals", "tasks"], type: "one-many", relation: "y", inheritsInactive: true },
    ]);
    expect([...set].sort()).toEqual(["goals", "tasks"]);
    expect(getAncestorInactiveResources(undefined).size).toBe(0);
  });

  it("resourceRequiresAncestorInactive follows relation semantics", () => {
    const result = validateSchema({ resources: [goals, tasks, notes], relations: [...relations] });
    if (!result.ok) throw new Error(result.error.message);
    const rels = result.result.relations;
    expect(resourceRequiresAncestorInactive(rels, "goals")).toBe(true);
    expect(resourceRequiresAncestorInactive(rels, "tasks")).toBe(true);
    expect(resourceRequiresAncestorInactive(rels, "notes")).toBe(false);
    expect(resourceRequiresAncestorInactive(undefined, "goals")).toBe(false);
  });

  it("findSystemFieldWrite flags writes only on owning resources", () => {
    const result = validateSchema({ resources: [goals, tasks, notes], relations: [...relations] });
    if (!result.ok) throw new Error(result.error.message);
    const rels = result.result.relations;
    expect(findSystemFieldWrite(rels, "goals", { isAncestorInactive: true })).toBe("isAncestorInactive");
    expect(findSystemFieldWrite(rels, "goals", { label: "x" })).toBeNull();
    expect(findSystemFieldWrite(rels, "notes", { isAncestorInactive: true })).toBeNull();
  });
});
