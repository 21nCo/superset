/**
 * System Fields
 *
 * Fields owned and maintained exclusively by the DataFn runtime. Unlike
 * capability-injected fields they are derived from schema structure (e.g.
 * relations) rather than an explicit capability opt-in.
 */

import type { DatafnFieldSchema, DatafnRelationSchema } from "./types.js";
import { endpointList } from "./relation-endpoints.js";

export const ANCESTOR_INACTIVE_FIELD = "isAncestorInactive";

export const ANCESTOR_INACTIVE_FIELD_DEF: DatafnFieldSchema = {
  name: ANCESTOR_INACTIVE_FIELD,
  type: "boolean",
  required: true,
  nullable: false,
  readonly: true,
  default: false,
};

function inheritsInactiveDependentEndpoint(
  relation: Pick<DatafnRelationSchema, "from" | "to" | "type">,
): DatafnRelationSchema["from"] {
  return relation.type === "many-one" ? relation.from : relation.to;
}

/**
 * Resource names that receive the runtime-owned `isAncestorInactive` field
 * because they are the dependent endpoint of an `inheritsInactive` relation.
 * Accepts raw (unvalidated) relations so it can run before normalization.
 */
export function getAncestorInactiveResources(relations: unknown): Set<string> {
  const resources = new Set<string>();
  if (!Array.isArray(relations)) return resources;
  for (const relation of relations) {
    if (typeof relation !== "object" || relation === null) continue;
    const r = relation as Record<string, unknown>;
    if (r.inheritsInactive !== true) continue;
    if (r.type === "many-many") continue;
    const endpoint = r.type === "many-one" ? r.from : r.to;
    if (typeof endpoint === "string") {
      resources.add(endpoint);
    } else if (Array.isArray(endpoint)) {
      for (const name of endpoint) {
        if (typeof name === "string") resources.add(name);
      }
    }
  }
  return resources;
}

export function resourceRequiresAncestorInactive(
  relations: readonly DatafnRelationSchema[] | undefined,
  resource: string,
): boolean {
  for (const relation of relations ?? []) {
    if (relation.inheritsInactive !== true || relation.type === "many-many") continue;
    if (endpointList(inheritsInactiveDependentEndpoint(relation)).includes(resource)) return true;
  }
  return false;
}

/**
 * Returns the name of the first runtime-owned field present in a consumer
 * supplied record for `resource`, or null when the record contains none.
 */
export function findSystemFieldWrite(
  relations: readonly DatafnRelationSchema[] | undefined,
  resource: string,
  record: Record<string, unknown>,
): string | null {
  if (!(ANCESTOR_INACTIVE_FIELD in record)) return null;
  return resourceRequiresAncestorInactive(relations, resource) ? ANCESTOR_INACTIVE_FIELD : null;
}
