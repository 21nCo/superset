/**
 * Select token parsing and materialization
 */

import type { DatafnSchema, DatafnRelationSchema } from "../../core-types.js";
import {
  endpointIncludes,
  endpointList,
  findRelationMatch,
  firstEndpoint,
  parseSelectToken,
  relationKeyFor,
  relationTargetEndpoint,
  relationFkFieldForManyOne,
  resolveEndpointResource,
  resourceNameFromId,
  stripNullsForNonNullableFields,
  type DatafnRelationEndpoint,
  type DatafnRelationMatch,
} from "@datafn/core";
import type { DataStore } from "../store.js";

export type { SelectToken } from "@datafn/core";

export { parseSelectToken };

type QueryMetadata = {
  includeAncestorInactive?: boolean;
};

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
  match: DatafnRelationMatch,
  metadata?: QueryMetadata,
): Record<string, unknown>[] {
  if (
    metadata?.includeAncestorInactive === true ||
    !relationInheritsInactiveToTarget(match.relation, match.direction === "forward")
  ) {
    return records;
  }
  return records.filter((record) => record.isAncestorInactive !== true);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function applyOmitToArrayValue(
  value: unknown,
  omit: string[] | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applyOmitToArrayValue(item, omit));
  }
  if (isPlainRecord(value)) {
    return applyOmit(value, omit);
  }
  return value;
}

/**
 * Apply omit to a record, removing specified fields (but never id)
 */
function applyOmit(
  record: Record<string, unknown>,
  omit: string[] | undefined,
): Record<string, unknown> {
  if (!omit || omit.length === 0) {
    return record;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // Never omit id
    if (key === "id" || !omit.includes(key)) {
      // Recursively apply omit to arrays of records
      if (Array.isArray(value)) {
        result[key] = value.map((item) => applyOmitToArrayValue(item, omit));
      } else if (
        isPlainRecord(value) &&
        key !== "$relation_metadata"
      ) {
        // Recursively apply omit to nested objects (except metadata)
        result[key] = applyOmit(value, omit);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Check if a token is a nested select traversal (e.g., "tasks.tags.*")
 */
function isNestedSelectToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length <= 1) {
    return false;
  }
  if (parts.length === 2) {
    const child = parts[1];
    return child !== "*" && child !== "**" && child !== "#" && child !== "*#";
  }
  return true;
}

function isMaterializedRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathFieldForHtree(relation: DatafnRelationSchema): string {
  return relation.pathField || "parentPath";
}

function hasHtreePath(
  record: Record<string, unknown>,
  relation: DatafnRelationSchema,
): boolean {
  return typeof record[pathFieldForHtree(relation)] === "string";
}

function htreePath(record: Record<string, unknown>, relation: DatafnRelationSchema): string {
  return (record[pathFieldForHtree(relation)] as string | undefined) || "";
}

function recordResourceName(
  schema: DatafnSchema,
  id: unknown,
  fallback: DatafnRelationEndpoint,
): string {
  return (
    resolveEndpointResource(fallback, id, schema) ??
    resourceNameFromId(id) ??
    firstEndpoint(fallback)
  );
}

function targetEndpointFor(match: DatafnRelationMatch): DatafnRelationEndpoint {
  return relationTargetEndpoint(match.relation, match.direction);
}

function materializeRelatedRecord(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  select: string[],
  schema: DatafnSchema,
  store: DataStore,
  omit?: string[],
  metadata?: QueryMetadata,
): Record<string, unknown> {
  const resource = recordResourceName(schema, record.id, targetEndpointFor(match));
  return materializeSelect(record, resource, select, schema, store, omit, metadata);
}

function htreeAncestors(
  record: Record<string, unknown>,
  resource: string,
  relation: DatafnRelationSchema,
  store: DataStore,
): Record<string, unknown>[] {
  const path = htreePath(record, relation);
  if (!path) return [];
  const allRecords = store.getRecords(resource);
  return path
    .split("-")
    .map((id) => allRecords.find((r) => r.id === id))
    .filter(isMaterializedRecord);
}

function htreeChildren(
  record: Record<string, unknown>,
  resource: string,
  relation: DatafnRelationSchema,
  store: DataStore,
  deep: boolean,
): Record<string, unknown>[] {
  const allRecords = store.getRecords(resource);
  const currentId = record.id as string;
  const currentPath = htreePath(record, relation);
  const prefix = currentPath ? `${currentPath}-${currentId}` : currentId;
  const records = allRecords.filter((candidate) => {
    const candidatePath = htreePath(candidate, relation);
    return deep
      ? candidatePath === prefix || candidatePath.startsWith(`${prefix}-`)
      : candidatePath === prefix;
  });
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
 * EXE-014: Compute FK fields to omit for a target resource, cached per (schema, targetResource) pair.
 * Avoids O(N) recomputation inside per-record loops.
 */
const _fkOmitCache = new WeakMap<DatafnSchema, Map<string, Set<string>>>();

function getFkFieldsToOmit(schema: DatafnSchema, targetResource: string): Set<string> {
  let perSchema = _fkOmitCache.get(schema);
  if (!perSchema) {
    perSchema = new Map();
    _fkOmitCache.set(schema, perSchema);
  }
  let cached = perSchema.get(targetResource);
  if (cached) return cached;

  cached = new Set<string>();
  if (schema.relations) {
    for (const rel of schema.relations) {
      if (endpointIncludes(rel.from, targetResource) && rel.type === "many-one") {
        const fkField = relationFkFieldForManyOne(rel);
        cached.add(fkField);
        if (Array.isArray(rel.to) && rel.to.length > 1) {
          cached.add(rel.fkResourceField || `${(rel.relation || "target").replace(/Id$/, "")}Resource`);
        }
      }
    }
  }
  perSchema.set(targetResource, cached);
  return cached;
}

/**
 * Materialize select tokens for a record
 */
export function materializeSelect(
  record: Record<string, unknown>,
  resource: string,
  select: string[] | undefined,
  schema: DatafnSchema,
  store: DataStore,
  omit?: string[],
  metadata?: QueryMetadata,
): Record<string, unknown> {
  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) return { id: record.id };

  // Persisted stores can hold null for non-nullable fields (nullable SQL
  // columns, replace clears). Expose them as undefined in query results.
  record = stripNullsForNonNullableFields(record, resourceSchema);

  // EXE-014: Use cached FK omit-set computation
  const fkFieldsToOmit = getFkFieldsToOmit(schema, resource);

  // Merge user-provided omit with auto-omitted FK fields
  const effectiveOmit = omit
    ? [...omit, ...Array.from(fkFieldsToOmit)]
    : Array.from(fkFieldsToOmit);

  // If select is omitted, return all schema-defined fields + id
  if (!select || select.length === 0) {
    const result: Record<string, unknown> = { id: record.id };
    for (const field of resourceSchema.fields) {
      if (record[field.name] !== undefined) {
        result[field.name] = record[field.name];
      }
    }
    return applyOmit(result, effectiveOmit);
  }

  const result: Record<string, unknown> = {};
  const includedFields = new Set<string>();

  // Process select tokens
  for (const token of select) {
    // Bare wildcard: include all schema-defined base fields (mirrors no-select path)
    if (token === "*") {
      result.id = record.id;
      includedFields.add("id");
      for (const field of resourceSchema.fields) {
        if (record[field.name] !== undefined) {
          result[field.name] = record[field.name];
          includedFields.add(field.name);
        }
      }
      continue;
    }

    // Handle nested select traversal (e.g., "tasks.tags.*")
    if (isNestedSelectToken(token)) {
      const parts = token.split(".");
      const firstRelation = parts[0];
      const restToken = parts.slice(1).join(".");

      const relation = findRelation(schema, resource, firstRelation);
      if (!relation) continue;

      // Check if we already have records for this relation
      const existingRecords = result[firstRelation];

      // Always expand from source records so successive nested tokens (e.g. items.id + items.title)
      // do not lose fields when earlier tokens projected only partial child objects.
      const intermediateRecords = expandRelationToRecords(
        record,
        relation,
        schema,
        store,
        resource,
        metadata,
      );

      if (!intermediateRecords) continue;

      // For each intermediate record, apply the rest of the select token
      if (Array.isArray(intermediateRecords)) {
        const targetEffectiveOmit = omit ? [...omit] : [];

        const newRecords = intermediateRecords.map((intermediateRecord) => {
          const nestedResult = materializeRelatedRecord(
            intermediateRecord,
            relation,
            [restToken],
            schema,
            store,
            omit,
            metadata,
          );

          // Merge with existing record if present
          let mergedRecord;
          if (existingRecords && Array.isArray(existingRecords)) {
            const existingRecord = existingRecords.find(
              (r: any) => r.id === intermediateRecord.id,
            );
            if (existingRecord && typeof existingRecord === "object") {
              mergedRecord = { ...existingRecord, ...nestedResult };
            } else {
              mergedRecord = nestedResult;
            }
          } else {
            mergedRecord = nestedResult;
          }

          return applyOmit(mergedRecord, targetEffectiveOmit);
        });
        result[firstRelation] = newRecords;
      } else {
        // Single record (many-one)
        const intermediateRecord = intermediateRecords as Record<string, unknown>;
        const nestedResult = materializeRelatedRecord(
          intermediateRecord,
          relation,
          [restToken],
          schema,
          store,
          omit,
          metadata,
        );

        // Merge with existing if present
        if (existingRecords && typeof existingRecords === "object") {
          result[firstRelation] = {
            ...existingRecords,
            ...nestedResult,
          } as Record<string, unknown>;
        } else {
          result[firstRelation] = nestedResult;
        }
      }
      includedFields.add(firstRelation);
      continue;
    }

    const parsed = parseSelectToken(token);

    const htreeRelation = findRelation(schema, resource, parsed.baseName);
    if (htreeRelation?.relation.type === "htree") {
      if (!hasHtreePath(record, htreeRelation.relation)) continue;
      if (parsed.baseName === "children") {
        if (parsed.directive === "*") {
          result[parsed.baseName] = filterAncestorInactiveRecords(
            htreeChildren(
              record,
              resource,
              htreeRelation.relation,
              store,
              false,
            ),
            htreeRelation,
            metadata,
          ).map((c) =>
            applyOmit(stripNullsForNonNullableFields(c, resourceSchema), omit),
          );
        } else if (parsed.directive === "**") {
          result[parsed.baseName] = filterAncestorInactiveRecords(
            htreeChildren(
              record,
              resource,
              htreeRelation.relation,
              store,
              true,
            ),
            htreeRelation,
            metadata,
          ).map((d) =>
            applyOmit(stripNullsForNonNullableFields(d, resourceSchema), omit),
          );
        }
        includedFields.add(parsed.baseName);
      } else if (parsed.baseName === "parent") {
        result[parsed.baseName] = htreeAncestors(
          record,
          resource,
          htreeRelation.relation,
          store,
        ).map((a) =>
          applyOmit(stripNullsForNonNullableFields(a, resourceSchema), omit),
        );
        includedFields.add(parsed.baseName);
      }
      continue;
    }

    // Base field (no directive)
    if (!parsed.directive) {
      // Check if it's a relation (ids-only token)
      const relation = findRelation(schema, resource, parsed.baseName);
      if (relation) {
        // ids-only relation token
        result[parsed.baseName] = getRelationIds(record, relation, store, resource, metadata);
        includedFields.add(parsed.baseName);
      } else {
        // Regular field
        result[parsed.baseName] = record[parsed.baseName];
        includedFields.add(parsed.baseName);
      }
      continue;
    }

    // Relation expansion
    const relation = findRelation(schema, resource, parsed.baseName);
    if (!relation) continue;

    if (parsed.directive === "*") {
      // Expand relation as records
      result[parsed.baseName] = expandRelation(
        record,
        relation,
        schema,
        store,
        false,
        omit, // Pass user's omit, not effectiveOmit (which has parent's FK fields)
        resource,
        metadata,
      );
    } else if (parsed.directive === "#") {
      // Emit join rows for many-many
      if (relation.relation.type === "many-many") {
        result[parsed.baseName] = getJoinRows(record, relation, schema, store);
      }
    } else if (parsed.directive === "*#") {
      // Expand relation with metadata for many-many
      if (relation.relation.type === "many-many") {
        result[parsed.baseName] = expandRelation(
          record,
          relation,
          schema,
          store,
          true,
          omit, // Pass user's omit, not effectiveOmit
          resource,
          metadata,
        );
      }
    }
  }

  // Always include id
  if (!includedFields.has("id")) {
    result.id = record.id;
  }

  return applyOmit(result, effectiveOmit);
}

/**
 * Find a relation by name for a given resource
 */
function findRelation(
  schema: DatafnSchema,
  resource: string,
  relationName: string,
): DatafnRelationMatch | null {
  return findRelationMatch(schema, resource, relationName) ?? null;
}

function getManyManyRows(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  resource: string,
  store: DataStore,
): Array<Record<string, unknown>> {
  const relation = match.relation;
  const recordId = record.id as string;
  if (match.direction === "forward") {
    const joinRows = store.getJoinRows(relationKeyFor(resource, relation));
    return joinRows.filter((j) => j.from === recordId);
  }

  return endpointList(relation.from).flatMap((fromResource) => {
    const joinRows = store.getJoinRows(relationKeyFor(fromResource, relation));
    return joinRows.filter((j) => j.to === recordId);
  });
}

/**
 * Get relation ids (for ids-only tokens)
 */
function getRelationIds(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  store: DataStore,
  resource: string,
  metadata?: QueryMetadata,
): unknown {
  const relation = match.relation;
  const isForward = match.direction === "forward";

  if (relation.type === "many-one") {
    if (isForward) {
      const fkField = relationFkFieldForManyOne(relation);
      const relatedId = record[fkField] as string | undefined;
      return relatedId || null;
    }
    const fkField = relationFkFieldForManyOne(relation);
    const records = endpointList(relation.from).flatMap((targetResource) =>
      store.findRecords(targetResource, fkField, record.id),
    );
    return filterAncestorInactiveRecords(records, match, metadata).map((r) => r.id);
  }

  if (relation.type === "many-many") {
    const sortedJoins = sortJoinRows(getManyManyRows(record, match, resource, store), relation);
    return sortedJoins.map((j) => (isForward ? j.to : j.from));
  }

  if (relation.type === "one-many") {
    if (!isForward) {
      const fkField = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
      return (record[fkField] as string | undefined) || null;
    }
    const fkField = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
    const relatedRecords = endpointList(relation.to).flatMap((targetResource) =>
      store.findRecords(targetResource, fkField, record.id),
    );
    const sorted = relatedRecords.sort((a, b) => {
      const aId = String(a.id || "");
      const bId = String(b.id || "");
      return aId.localeCompare(bId);
    });
    return filterAncestorInactiveRecords(sorted, match, metadata).map((r) => r.id);
  }

  if (relation.type === "htree") {
    if (relation.relation === "children") {
      return filterAncestorInactiveRecords(
        htreeChildren(record, firstEndpoint(targetEndpointFor(match)), relation, store, false),
        match,
        metadata,
      );
    }
    return htreeAncestors(record, firstEndpoint(targetEndpointFor(match)), relation, store);
  }

  return null;
}

/**
 * Expand a relation to records (without applying select filtering)
 * Used for nested select traversal
 */
function expandRelationToRecords(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  schema: DatafnSchema,
  store: DataStore,
  resource: string,
  metadata?: QueryMetadata,
): Record<string, unknown> | Record<string, unknown>[] | null {
  const relation = match.relation;
  const isForward = match.direction === "forward";
  const targetEndpoint = targetEndpointFor(match);

  if (relation.type === "many-one") {
    if (isForward) {
      const fkField = relationFkFieldForManyOne(relation);
      const relatedId = record[fkField] as string | undefined;
      if (!relatedId) return null;
      const relatedRecord = store.getRecord(recordResourceName(schema, relatedId, targetEndpoint), relatedId);
      return relatedRecord ?? null;
    }
    const fkField = relationFkFieldForManyOne(relation);
    const records = endpointList(targetEndpoint)
      .flatMap((targetResource) => store.findRecords(targetResource, fkField, record.id))
      .sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
    return filterAncestorInactiveRecords(records, match, metadata);
  }

  if (relation.type === "many-many") {
    const sortedJoins = sortJoinRows(getManyManyRows(record, match, resource, store), relation);

    return sortedJoins
      .map((join) => {
        const targetId = isForward ? join.to : join.from;
        return store.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId as string);
      })
      .filter(isMaterializedRecord);
  }

  if (relation.type === "one-many") {
    if (!isForward) {
      const fkField = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
      const relatedId = record[fkField] as string | undefined;
      if (!relatedId) return null;
      return store.getRecord(recordResourceName(schema, relatedId, targetEndpoint), relatedId);
    }
    const fkField = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
    const relatedRecords = endpointList(targetEndpoint).flatMap((targetResource) =>
      store.findRecords(targetResource, fkField, record.id),
    );
    const sorted = relatedRecords.sort((a, b) => {
      const aId = String(a.id || "");
      const bId = String(b.id || "");
      return aId.localeCompare(bId);
    });
    return filterAncestorInactiveRecords(sorted, match, metadata);
  }

  return null;
}

/**
 * Expand a relation to related records
 */
function expandRelation(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  schema: DatafnSchema,
  store: DataStore,
  includeMetadata: boolean,
  omit?: string[],
  resource?: string,
  metadata?: QueryMetadata,
): unknown {
  const relation = match.relation;
  const isForward = match.direction === "forward";
  const currentResource = resource ?? firstEndpoint(match.direction === "forward" ? relation.from : relation.to);
  const targetEndpoint = targetEndpointFor(match);

  if (relation.type === "many-one") {
    const records = expandRelationToRecords(record, match, schema, store, currentResource, metadata);
    if (!records) return isForward ? null : [];
    if (Array.isArray(records)) {
      return records.map((relatedRecord) =>
        materializeRelatedRecord(relatedRecord, match, ["*"], schema, store, omit, metadata),
      );
    }
    return materializeRelatedRecord(records, match, ["*"], schema, store, omit, metadata);
  }

  if (relation.type === "many-many") {
    const sortedJoins = sortJoinRows(getManyManyRows(record, match, currentResource, store), relation);

    if (!includeMetadata) {
      return sortedJoins
        .map((join) => {
          const targetId = isForward ? join.to : join.from;
          const relatedRecord = store.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId as string);
          if (!relatedRecord) return null;
          if (filterAncestorInactiveRecords([relatedRecord], match, metadata).length === 0) return null;
          return materializeRelatedRecord(relatedRecord, match, ["*"], schema, store, omit, metadata);
        })
        .filter(isMaterializedRecord);
    } else {
      return sortedJoins
        .map((join) => {
          const targetId = isForward ? join.to : join.from;
          const relatedRecord = store.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId as string);
          if (!relatedRecord) return null;
          if (filterAncestorInactiveRecords([relatedRecord], match, metadata).length === 0) return null;
          const result = materializeRelatedRecord(relatedRecord, match, ["*"], schema, store, omit, metadata);

          const relationMetadata: Record<string, unknown> = {};
          if (relation.metadata) {
            for (const metaField of relation.metadata) {
              if (join[metaField.name] !== undefined) {
                relationMetadata[metaField.name] = join[metaField.name];
              }
            }
          }
          result.$relation_metadata = relationMetadata;

          return applyOmit(result, omit);
        })
        .filter(isMaterializedRecord);
    }
  }

  // one-many: inverse of many-one
  if (relation.type === "one-many") {
    const records = expandRelationToRecords(record, match, schema, store, currentResource, metadata);
    if (!records) return isForward ? [] : null;
    const list = Array.isArray(records) ? records : [records];
    const materialized = list.map((relatedRecord) =>
      materializeRelatedRecord(relatedRecord, match, ["*"], schema, store, omit, metadata),
    );
    return isForward ? materialized : materialized[0] ?? null;
  }

  return null;
}

/**
 * Get join rows for a many-many relation
 */
function getJoinRows(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  schema: DatafnSchema,
  store: DataStore,
): unknown[] {
  const relation = match.relation;
  const resource = recordResourceName(
    schema,
    record.id,
    match.direction === "forward" ? relation.from : relation.to,
  );
  const sorted = sortJoinRows(getManyManyRows(record, match, resource, store), relation);

  // Return join rows with from, to, and metadata
  return sorted.map((join) => {
    const result: Record<string, unknown> = {
      from: join.from,
      to: join.to,
    };

    if (relation.metadata) {
      for (const metaField of relation.metadata) {
        if (join[metaField.name] !== undefined) {
          result[metaField.name] = join[metaField.name];
        }
      }
    }

    return result;
  });
}

/**
 * Sort join rows by order metadata (if present) then by to
 */
function sortJoinRows(
  joins: Array<Record<string, unknown>>,
  relation: DatafnRelationSchema,
): Array<Record<string, unknown>> {
  const hasOrderMetadata = relation.metadata?.some(
    (m) => m.name === "order" && m.type === "number",
  );

  return [...joins].sort((a, b) => {
    if (hasOrderMetadata) {
      const aOrder = a.order as number;
      const bOrder = b.order as number;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
    }

    // Tie-break by to
    const aTo = String(a.to || "");
    const bTo = String(b.to || "");
    return aTo.localeCompare(bTo);
  });
}
