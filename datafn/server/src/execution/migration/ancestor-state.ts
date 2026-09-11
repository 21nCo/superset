import type { Adapter } from "@superfunctions/db";
import {
  endpointIncludes,
  relationFkFieldForManyOne,
  relationFkFieldForOneMany,
  resolveEndpointResource,
  type DatafnSchema,
} from "@datafn/core";

/** Repair reads primary state and links, never the derived flags being repaired. */
export async function resolveAuthoritativeAncestorInactive(
  adapter: Adapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  namespace: string,
  maxGraphNodes: number,
): Promise<boolean> {
  const active = new Set<string>();
  const resolved = new Map<string, boolean>();
  let visited = 0;

  async function visit(model: string, row: Record<string, unknown>, root = false): Promise<boolean> {
    if (typeof row.id !== "string" || row.id.length === 0) {
      throw new Error("Ancestor repair: malformed record identifier");
    }
    const key = JSON.stringify([model, row.id]);
    if (active.has(key)) throw new Error("Ancestor repair: cycle detected");
    if (resolved.has(key)) return resolved.get(key)!;
    if (++visited > maxGraphNodes) throw new Error("Ancestor repair: maxGraphNodes exceeded");
    active.add(key);
    let inherited = false;
    for (const relation of schema.relations ?? []) {
      if (relation.inheritsInactive !== true || relation.type === "many-many") continue;
      const dependent = relation.type === "many-one" ? relation.from : relation.to;
      if (!endpointIncludes(dependent, model)) continue;
      const endpoint = relation.type === "many-one" ? relation.to : relation.from;
      const field = relation.type === "many-one"
        ? relationFkFieldForManyOne(relation)
        : relation.type === "htree"
          ? relation.fkField || relation.foreignKey || relation.inverse || "parentId"
          : relationFkFieldForOneMany(relation);
      const parentId = row[field];
      if (parentId === null || parentId === undefined || parentId === "") continue;
      if (typeof parentId !== "string") throw new Error("Ancestor repair: malformed parent link");
      const parentResource = resolveEndpointResource(endpoint, parentId, schema);
      if (!parentResource) throw new Error("Ancestor repair: ambiguous parent resource");
      const parent = await adapter.findOne<Record<string, unknown>>({
        model: parentResource, where: [{ field: "id", operator: "eq", value: parentId }], namespace,
      });
      if (!parent) throw new Error("Ancestor repair: missing parent record");
      // Do not short-circuit: an inactive parent must not hide a cycle elsewhere.
      const parentInactive = await visit(parentResource, parent);
      inherited = inherited || parentInactive;
    }
    active.delete(key);
    const effective = inherited || row.isArchived === true || row.trashedAt != null;
    resolved.set(key, effective);
    return root ? inherited : effective;
  }

  return visit(resource, record, true);
}
