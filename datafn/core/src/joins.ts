/**
 * Shared join store key utilities.
 *
 * These functions provide the single canonical derivation of join store names
 * used by both client and server across all sync operations.
 */

import type { DatafnRelationSchema } from "./types.js";
import { endpointList, firstEndpoint } from "./relation-endpoints.js";

function getRelationKeyName(relation: DatafnRelationSchema, to: string): string {
  return relation.relation ?? relation.inverse ?? relation.joinTable ?? `to_${to}`;
}

/**
 * Derive the logical join store key used by clients and change tracking.
 * Format: join_{fromResource}_{relationName}_{toResource}
 */
export function getJoinStoreKey(
  from: string,
  relation: string,
  to: string,
): string {
  return `join_${from}_${relation}_${to}`;
}

/**
 * Derive the actual DB table name for a join table.
 * Format: __datafn_join_{fromResource}_{relationName}
 * Can be overridden by relation.joinTable in schema.
 */
export function getJoinTableName(
  from: string,
  relation: string,
  joinTable?: string,
): string {
  return joinTable || `__datafn_join_${from}_${relation}`;
}

export function getRelationName(relation: DatafnRelationSchema): string {
  return relation.relation ?? relation.inverse ?? relation.joinTable ?? `to_${firstEndpoint(relation.to)}`;
}

export function getRelationJoinTableName(
  relation: DatafnRelationSchema,
  fromResource?: string,
): string {
  if (relation.joinTable) return relation.joinTable;
  const relationName = getRelationName(relation);
  const from = endpointList(relation.from).length > 1
    ? firstEndpoint(relation.from)
    : (fromResource ?? firstEndpoint(relation.from));
  return getJoinTableName(from, relationName);
}

/**
 * Enumerate all logical join store keys for a schema's many-many relations.
 * Handles multi-resource from/to arrays.
 * Useful for building cursor maps, reconcile payloads, and similar operations.
 *
 * @param relations - Array of relation schema definitions
 * @param resourceFilter - Optional set of resource names; if provided, only
 *   joins whose `from` resource is in this set are included.
 */
export function enumerateJoinStoreKeys(
  relations: readonly DatafnRelationSchema[],
  resourceFilter?: Set<string>,
): string[] {
  const keys: string[] = [];
  for (const rel of relations) {
    if (rel.type !== "many-many") continue;
    const froms = Array.isArray(rel.from) ? rel.from : [rel.from];
    const tos = Array.isArray(rel.to) ? rel.to : [rel.to];
    for (const f of froms) {
      if (resourceFilter && !resourceFilter.has(f)) continue;
      for (const t of tos) {
        keys.push(getJoinStoreKey(f, getRelationKeyName(rel, t), t));
      }
    }
  }
  return keys;
}

/** Resolve logical join cursors against trusted relation metadata, never by prefix. */
export function resolveJoinStoreResources(relations: readonly DatafnRelationSchema[]): Map<string, string[]> {
  const resources = new Map<string, string[]>();
  for (const rel of relations) {
    if (rel.type !== "many-many") continue;
    for (const from of endpointList(rel.from)) for (const to of endpointList(rel.to)) {
      const key = getJoinStoreKey(from, getRelationKeyName(rel, to), to);
      resources.set(key, [...new Set([...(resources.get(key) ?? []), from, to])]);
    }
  }
  return resources;
}
