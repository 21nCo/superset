/**
 * Offline Relation Operations
 * 
 * Handles relation expansion and mutation operations in offline mode.
 */
import type { DatafnSchema, DatafnRelationSchema } from "@datafn/core";
import {
  endpointList,
  findRelationMatch,
  firstEndpoint,
  relationFkFieldForManyOne,
  getJoinStoreKey,
  relationTargetEndpoint,
  resolveEndpointResource,
  resourceNameFromId,
  stripNullsForNonNullableFields,
} from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";

// NormalizedRelation, normalizeRelationPayload, and findRelationBidirectional
// are canonical in @datafn/core and are re-exported here for convenience.
export type { NormalizedRelation } from "@datafn/core";
export { normalizeRelationPayload } from "@datafn/core";

type QueryMetadata = {
  includeAncestorInactive?: boolean;
};

function pathFieldForHtree(relation: DatafnRelationSchema): string {
  return relation.pathField || "parentPath";
}

function relationInheritsInactiveToTarget(
  relation: DatafnRelationSchema,
  isForward: boolean,
): boolean {
  if (relation.inheritsInactive !== true) return false;
  if (relation.type === "htree") return isForward;
  if (relation.type === "many-one") return !isForward;
  if (relation.type === "one-many") return isForward;
  return false;
}

function filterAncestorInactiveRecords(
  records: Record<string, unknown>[],
  relation: DatafnRelationSchema,
  isForward: boolean,
  metadata?: QueryMetadata,
): Record<string, unknown>[] {
  if (
    metadata?.includeAncestorInactive === true ||
    !relationInheritsInactiveToTarget(relation, isForward)
  ) {
    return records;
  }
  return records.filter((record) => record.isAncestorInactive !== true);
}

function recordResourceName(
  schema: DatafnSchema,
  id: unknown,
  fallback: string | readonly string[],
): string {
  return (
    resolveEndpointResource(fallback, id, schema) ??
    resourceNameFromId(id) ??
    firstEndpoint(fallback)
  );
}

async function materializeMixedRecords(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  endpoint: string | readonly string[],
  records: Record<string, unknown>[],
  select: string[],
  metadata?: QueryMetadata,
): Promise<Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const resource = recordResourceName(schema, record.id, endpoint);
    const group = groups.get(resource) ?? [];
    group.push(record);
    groups.set(resource, group);
  }

  const byId = new Map<unknown, Record<string, unknown>>();
  for (const [resource, group] of groups.entries()) {
    const materialized = await materializeSelect(
      storage,
      schema,
      resource,
      group,
      select,
      metadata,
    );
    materialized.forEach((record) => byId.set(record.id, record));
  }

  return records
    .map((record) => byId.get(record.id))
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function htreePath(record: Record<string, unknown>, relation: DatafnRelationSchema): string {
  const value = record[pathFieldForHtree(relation)];
  if (Array.isArray(value)) return value.filter(Boolean).join("-");
  return (value as string | undefined) || "";
}

function sortHtreeRecords(
  records: Record<string, unknown>[],
  relation: DatafnRelationSchema,
  deep: boolean,
): Record<string, unknown>[] {
  return records.sort((a, b) => {
    const aOrder = typeof a.sortOrder === "number" ? a.sortOrder : undefined;
    const bOrder = typeof b.sortOrder === "number" ? b.sortOrder : undefined;
    if (aOrder !== undefined || bOrder !== undefined) {
      if (aOrder === undefined) return 1;
      if (bOrder === undefined) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    if (!deep) return String(a.id || "").localeCompare(String(b.id || ""));
    const aPath = htreePath(a, relation);
    const bPath = htreePath(b, relation);
    const aLen = aPath ? aPath.split("-").length : 0;
    const bLen = bPath ? bPath.split("-").length : 0;
    if (aLen !== bLen) return aLen - bLen;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

/**
 * Expand a relation for a record with sub-selection
 */
export async function expandRelation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  relationName: string,
  subSelect: string[],
  metadata?: QueryMetadata,
): Promise<unknown> {
  const match = findRelationMatch(schema, resource, relationName);

  if (!match) {
    return null;
  }

  const { relation, direction } = match;
  const isForward = direction === "forward";
  const targetEndpoint = relationTargetEndpoint(relation, direction);

  // Check for metadata request (# or *#)
  const wantsMetadata = subSelect.some(
    (s) => s === "#" || s === "*#" || s === "#*",
  );
  const wantsExpansion = subSelect.length > 0;

  // 1. Fetch related IDs or Join Rows
  let targetIds: string[] = [];
  let joinRows: Record<string, unknown>[] = [];

  if (relation.type === "htree") {
    const targetResource = firstEndpoint(targetEndpoint);
    const path = htreePath(record, relation);
    let targets: Record<string, unknown>[] = [];

    if (isForward) {
      const currentId = record.id as string;
      const prefix = path ? `${path}-${currentId}` : currentId;
      const deep = subSelect.includes("**");
      targets = sortHtreeRecords(
        (await storage.listRecords(targetResource)).filter((candidate) => {
          const candidatePath = htreePath(candidate, relation);
          return deep
            ? candidatePath === prefix || candidatePath.startsWith(`${prefix}-`)
            : candidatePath === prefix;
        }),
        relation,
        deep,
      );
      targets = filterAncestorInactiveRecords(
        targets,
        relation,
        isForward,
        metadata,
      );
    } else {
      const ancestorIds = path ? path.split("-") : [];
      for (const ancestorId of ancestorIds) {
        const ancestor = await storage.getRecord(targetResource, ancestorId);
        if (ancestor) targets.push(ancestor);
      }
    }

    if (!wantsExpansion) {
      return targets.map((target) => target.id);
    }

    const select = subSelect.filter((token) => token !== "**");
    return materializeSelect(
      storage,
      schema,
      targetResource,
      targets,
      select.length > 0 ? select : ["*"],
      metadata,
    );
  } else if (relation.type === "many-one") {
    if (isForward) {
      const fk = relation.fkField || relation.foreignKey || `${relationName}Id`;
      const val = record[fk] as string;
      if (val) targetIds.push(val);
    } else {
      const fk = relationFkFieldForManyOne(relation);
      for (const targetResource of endpointList(targetEndpoint)) {
        const records = await storage.findRecords(targetResource, fk, record.id);
        targetIds.push(...records.map((r) => r.id as string));
      }
    }
  } else if (relation.type === "one-many") {
    const fk = relation.fkField || relation.foreignKey || relation.inverse || `${resource}Id`;
    if (isForward) {
      for (const targetResource of endpointList(targetEndpoint)) {
        const records = await storage.findRecords(targetResource, fk, record.id);
        targetIds.push(...records.map((r) => r.id as string));
      }
    } else {
      const val = record[fk] as string;
      if (val) targetIds.push(val);
    }
  } else if (relation.type === "many-many") {
    const relationName = relation.relation || "rel";
    const storesToQuery: string[] = [];

    if (isForward) {
      for (const t of endpointList(relation.to)) {
        storesToQuery.push(getJoinStoreKey(resource, relationName, t));
      }
    } else {
      for (const f of endpointList(relation.from)) {
        storesToQuery.push(getJoinStoreKey(f, relationName, resource));
      }
    }

    const allRows: Record<string, unknown>[] = [];
    for (const storeName of storesToQuery) {
      try {
        const rows = isForward
          ? await storage.getJoinRows(storeName, record.id as string)
          : await storage.getJoinRowsInverse(storeName, record.id as string);
        allRows.push(...rows);
      } catch {
      }
    }

    joinRows = allRows;
    targetIds = allRows.map((r) =>
      isForward ? (r.to as string) : (r.from as string),
    );
  }

  // 2. Return based on request type
  if (!wantsExpansion && relation.type !== "many-many") {
    // Just IDs for many-one?
    // "rel" -> ID or IDs.
    if (relation.type === "many-one" && isForward) return targetIds[0] || null;
    return targetIds;
  }

  if (relation.type === "many-many") {
    if (!wantsExpansion) {
      return targetIds;
    }
    if (wantsMetadata && !subSelect.some((s) => s !== "#")) {
      // Only metadata (#)
      return joinRows;
    }
    // If we want expansion, we need to fetch records
  }

  // 3. Fetch records
	  const targets = [];
  for (const id of targetIds) {
    const recordResource = recordResourceName(schema, id, targetEndpoint);
    const r = await storage.getRecord(recordResource, id);
    if (r) targets.push(r);
  }
  const filteredTargets = filterAncestorInactiveRecords(
    targets,
    relation,
    isForward,
    metadata,
  );

  // 4. Attach metadata if needed (many-many *#)
  if (relation.type === "many-many" && wantsMetadata) {
    // Merge metadata
    const merged = filteredTargets.map((target) => {
      // Find matching join row
      const match = joinRows.find((row) =>
        isForward ? row.to === target.id : row.from === target.id,
      );
      return { ...target, ...(match || {}) };
    });
    return materializeMixedRecords(
      storage,
      schema,
      targetEndpoint,
      merged,
      subSelect,
      metadata,
    );
  }

  const result = await materializeMixedRecords(
    storage,
    schema,
    targetEndpoint,
    filteredTargets,
    subSelect,
    metadata,
  );

  if (relation.type === "many-one" && isForward) {
    return result[0] || null;
  }
  return result;
}

/**
 * Materialize selection for a list of records
 * Handles nested expansion
 */
export async function materializeSelect(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  records: Record<string, unknown>[],
  select: string[],
  metadata?: QueryMetadata,
): Promise<Record<string, unknown>[]> {
  // Group tokens
  const expansions = new Map<string, string[]>();
  const baseFields = new Set<string>();

  for (const token of select) {
    if (token === "*" || token === "#" || token === "*#" || token === "#*") {
      baseFields.add("*"); // Keep all fields
      // # implies metadata, which is already merged if we are here?
      // Yes, expandRelation merges it.
      continue;
    }

    if (token.includes(".")) {
      const [base, ...rest] = token.split(".");
      if (!expansions.has(base)) expansions.set(base, []);
      expansions.get(base)!.push(rest.join("."));
    } else {
      // Check if it's a relation (ids only request)
      // We will handle it in expansions with empty subSelect if it is relation.
      // But we need to know if it is a relation or field.
      // We can defer check.
      baseFields.add(token);
    }
  }

  const resourceSchema = schema.resources.find((r) => r.name === resource);
  const results = [];
  for (const record of records) {
    // Persisted stores can hold null for non-nullable fields (nullable SQL
    // columns, replace clears). Expose them as undefined in query results.
    const source = stripNullsForNonNullableFields(record, resourceSchema);
    const result: Record<string, unknown> = {};

    // Copy fields
    if (baseFields.has("*")) {
      Object.assign(result, source);
    }
    if (!baseFields.has("*")) {
      result.id = source.id;
    }
    for (const key of baseFields) {
      if (key === "*") continue;
      if (findRelationMatch(schema, resource, key)) {
        result[key] = await expandRelation(
          storage,
          schema,
          resource,
          source,
          key,
          [],
          metadata,
        );
      } else if (!baseFields.has("*") && key in source) {
        result[key] = source[key];
      }
    }

    // Process expansions
    for (const [key, subSelect] of expansions.entries()) {
      result[key] = await expandRelation(
        storage,
        schema,
        resource,
        source,
        key,
        subSelect,
        metadata,
      );
    }

    results.push(result);
  }

  return results;
}
