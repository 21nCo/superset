/**
 * Offline query executor
 */

import type {
  DatafnRelationDirection,
  DatafnRelationSchema,
  DatafnSchema,
  DatafnTemporalConfig,
} from "@datafn/core";
import {
  endpointList,
  evaluateFilter as coreEvaluateFilter,
  findRelationMatch,
  firstEndpoint,
  getJoinStoreKey,
  parseSortTerms,
  relationTargetEndpoint,
  resolveEndpointResource,
  resourceNameFromId,
  sortRecords,
  type SchemaIndex,
  normalizeFilterOps,
  hasTemporalGrouping,
  normalizeTemporalQuery,
  relationFkFieldForManyOne,
  relationFkFieldForOneMany,
  stripNullsForNonNullableFields,
  TIMEZONE_CHANGE_RESOURCE_NAME,
} from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import { materializeSelect } from "./relations.js";
import { executeAggregateQuery } from "./aggregate.js";
import { createClientTemporalConfig } from "../temporalConfig.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasImpossibleEmptyInFilter(filter: unknown): boolean {
  if (!isPlainRecord(filter)) return false;
  if (Array.isArray(filter.$and)) {
    return filter.$and.some(hasImpossibleEmptyInFilter);
  }
  if (Array.isArray(filter.$or)) {
    return filter.$or.length === 0 || filter.$or.every(hasImpossibleEmptyInFilter);
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") continue;
    if (!isPlainRecord(value)) continue;
    const inValue = value.$in ?? value.in;
    if (Array.isArray(inValue) && inValue.length === 0) return true;
  }
  return false;
}

function relationQuerySelectTokens(relationName: string, select: unknown): string[] {
  const tokens = Array.isArray(select) && select.length > 0 ? select : ["*"];
  return tokens
    .filter((token): token is string => typeof token === "string")
    .map((token) => `${relationName}.${token}`);
}

function normalizeRelationQueryValue(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    return [value as Record<string, unknown>];
  }
  return [];
}

async function executeLocalRelationQuery(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
): Promise<{ data?: any[]; nextCursor?: any; count?: number }> {
  const resource = query.resource as string;
  const relationName = query.relation as string;
  const id = query.id as string;
  const record = await storage.getRecord(resource, id);
  if (!record) {
    return {
      data: [],
      nextCursor: null,
      ...(query.count === true ? { count: 0 } : {}),
    };
  }

  const materialized = await materializeSelect(
    storage,
    schema,
    resource,
    [record],
    relationQuerySelectTokens(relationName, query.select),
    query.metadata as Record<string, unknown> | undefined,
  );
  let data = normalizeRelationQueryValue(materialized[0]?.[relationName]);
  if (Array.isArray(query.sort)) {
    data = sortRecords(data, parseSortTerms(query.sort as string[]));
  }
  const count = query.count === true ? data.length : undefined;
  const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
  const limit = typeof query.limit === "number" && query.limit >= 0 ? query.limit : undefined;
  const paged = typeof limit === "number" ? data.slice(offset, offset + limit) : data.slice(offset);

  return {
    data: paged,
    nextCursor: null,
    ...(count !== undefined ? { count } : {}),
  };
}

/**
 * Execute a local query with index-aware routing (OFFQ-001)
 */
export async function executeLocalQuery(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  _schemaIndex?: SchemaIndex,
  temporal?: DatafnTemporalConfig,
): Promise<{ data?: any[]; groups?: any[]; nextCursor?: any }> {
  const timezoneChanges = await storage.listRecords(TIMEZONE_CHANGE_RESOURCE_NAME);
  const temporalConfig = createClientTemporalConfig(temporal, timezoneChanges);
  query = normalizeTemporalQuery(query, temporalConfig);
  if (typeof query.relation === "string" && typeof query.id === "string") {
    return executeLocalRelationQuery(storage, schema, query);
  }
  if (hasImpossibleEmptyInFilter(query.filters)) {
    if (query.groupBy || hasTemporalGrouping(query)) {
      return { groups: [], nextCursor: null };
    }
    return {
      data: [],
      nextCursor: null,
      ...(query.count === true ? { count: 0 } : {}),
    };
  }
  // Check for aggregation
  if (query.groupBy || hasTemporalGrouping(query)) {
    return executeAggregateQuery(storage, schema, query, temporalConfig);
  }

  const resource = query.resource as string;
  let records: Record<string, unknown>[] = [];
  let usedIndexedPath = false;
  // CLI-012: tracks whether the index fetch fully satisfied all filter conditions
  let filterFullySatisfied = false;

  const relationSeedIds = query.filters
    ? await resolveRelationSeedIds(
        storage,
        schema,
        resource,
        normalizeFilterOps(query.filters as Record<string, unknown>),
      )
    : null;

  if (relationSeedIds) {
    records = (
      await Promise.all(
        relationSeedIds.map((id) => storage.getRecord(resource, id)),
      )
    ).filter((record): record is Record<string, unknown> => Boolean(record));
    usedIndexedPath = true;
  }

  // Planning step: detect index-aware routing opportunities (OFFQ-001)
  if (query.filters) {
    const filters = query.filters as Record<string, unknown>;
    
    // Case 1: id eq → use getRecord
    if (!usedIndexedPath && filters.id && typeof filters.id === "object") {
      const idFilter = filters.id as Record<string, unknown>;
      if (idFilter.eq !== undefined) {
        const record = await storage.getRecord(resource, idFilter.eq as string);
        records = record ? [record] : [];
        usedIndexedPath = true;
        // Filter fully satisfied only when id eq is the sole filter condition
        if (Object.keys(filters).length === 1) {
          filterFullySatisfied = true;
        }
      }
    }
    
    // Case 2: single-field indexed eq → use findRecords
    if (!usedIndexedPath) {
      const singleFieldEq = detectSingleFieldEq(filters);
      if (singleFieldEq) {
        const { field, value } = singleFieldEq;
        // findRecords will use index if available, else fall back to scan
        records = await storage.findRecords(resource, field, value);
        usedIndexedPath = true;
        // detectSingleFieldEq guarantees exactly one key — fully satisfied
        filterFullySatisfied = true;
      }
    }
  }

  // Scan path with deterministic ordering
  if (!usedIndexedPath) {
    records = await storage.listRecords(resource);
  }

  // Filters and sorting intentionally run against the stored representation
  // so local results match the server (e.g. $eq: null matches the persisted
  // NULL that a replace-clear wrote). Persisted nulls are normalized to the
  // read contract at the result boundary below.
  const localResourceSchema = schema.resources.find((r) => r.name === resource);

  // Apply filters only when not fully satisfied by the indexed path (CLI-012)
  if (query.filters && !filterFullySatisfied) {
    const normalized = normalizeFilterOps(query.filters as Record<string, unknown>);
    const filtered = [];
    for (const record of records) {
      if (await applyFilter(storage, schema, resource, record, normalized)) {
        filtered.push(record);
      }
    }
    records = filtered;
  }

  // Sort using shared core utilities
  if (query.sort) {
    const terms = parseSortTerms(query.sort as string[]);
    records = sortRecords(records, terms);
  } else if (!usedIndexedPath) {
    // Deterministic ordering: stable sort by id:asc when scan path is used
    records = sortRecords(records, [{ field: "id", direction: "asc" }]);
  }

  // Pagination
  if (query.limit || query.offset) {
    const offset = (query.offset as number) || 0;
    const limit = (query.limit as number) || records.length;
    records = records.slice(offset, offset + limit);
  }

  // Select / Expansion
  if (query.select) {
    // materializeSelect normalizes persisted nulls per record already.
    records = await materializeSelect(
      storage,
      schema,
      resource,
      records,
      query.select as string[],
      query.metadata as Record<string, unknown> | undefined,
    );
  } else {
    // No select token: normalize once at the boundary so cleared non-nullable
    // fields read as absent, same as the server's materialized output.
    records = records.map((record) =>
      stripNullsForNonNullableFields(record, localResourceSchema),
    );
  }

  return {
    data: records,
    nextCursor: null,
  };
}

/** Wrap core evaluateFilter to add field-path context to error messages. */
async function applyFilter(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  filters: Record<string, unknown>,
  path = "filters",
): Promise<boolean> {
  for (const [key, value] of Object.entries(filters)) {
    const fieldPath = `${path}.${key}`;
    try {
      if (key === "$and" && Array.isArray(value)) {
        for (const sub of value as Record<string, unknown>[]) {
          if (!(await applyFilter(storage, schema, resource, record, sub, path))) {
            return false;
          }
        }
        continue;
      }
      if (key === "$or" && Array.isArray(value)) {
        let matched = false;
        for (const sub of value as Record<string, unknown>[]) {
          try {
            if (await applyFilter(storage, schema, resource, record, sub, path)) {
              matched = true;
              break;
            }
          } catch { /* continue */ }
        }
        if (!matched) {
          // Re-run to surface errors from all branches
          for (const sub of value as Record<string, unknown>[]) {
            await applyFilter(storage, schema, resource, record, sub, path);
          }
          return false;
        }
        continue;
      }
      if (
        isPlainRecord(value) &&
        ("$any" in value || "$all" in value || "$none" in value) &&
        findRelationMatch(schema, resource, key)
      ) {
        if (
          !(await evaluateRelationQuantifierFilter(
            storage,
            schema,
            resource,
            record,
            key,
            value,
            fieldPath,
          ))
        ) {
          return false;
        }
        continue;
      }
      if (isRelationPathFilter(schema, resource, record, key)) {
        const relationMatched = await evaluateRelationPathFilter(
          storage,
          schema,
          resource,
          record,
          key,
          value,
          fieldPath,
        );
        if (!relationMatched) return false;
        continue;
      }
      if (!coreEvaluateFilter(record, { [key]: value })) return false;
    } catch (err: any) {
      if (err && (err.code === "DFQL_UNSUPPORTED" || err.code === "DFQL_INVALID")) {
        throw { ...err, message: `${err.message}: ${fieldPath}` };
      }
      throw err;
    }
  }
  return true;
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

function filterValueIds(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (!isPlainRecord(value)) return null;
  const eq = value.$eq ?? value.eq;
  if (typeof eq === "string") return [eq];
  const inValue = value.$in ?? value.in;
  if (Array.isArray(inValue) && inValue.every((item) => typeof item === "string")) {
    return inValue as string[];
  }
  return null;
}

function extractRelationIdFilter(
  relationName: string,
  value: unknown,
): { relationName: string; ids: string[] } | null {
  if (!isPlainRecord(value)) return null;
  const anyFilter = value.$any;
  if (!isPlainRecord(anyFilter)) return null;
  const ids = filterValueIds(anyFilter.id);
  return ids ? { relationName, ids } : null;
}

function findRelationIdFilter(
  filters: Record<string, unknown>,
): { relationName: string; ids: string[] } | null {
  for (const [key, value] of Object.entries(filters)) {
    if (key === "$and" && Array.isArray(value)) {
      for (const sub of value) {
        if (isPlainRecord(sub)) {
          const result = findRelationIdFilter(sub);
          if (result) return result;
        }
      }
      continue;
    }
    if (key.includes(".")) {
      const [relationName, ...rest] = key.split(".");
      if (rest.join(".") === "id") {
        const ids = filterValueIds(value);
        if (ids) return { relationName, ids };
      }
      continue;
    }
    const result = extractRelationIdFilter(key, value);
    if (result) return result;
  }
  return null;
}

async function resolveManyManyRelationSeedIds(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  relationName: string,
  ids: string[],
  relation: DatafnRelationSchema,
  direction: DatafnRelationDirection,
): Promise<string[]> {
  const values = new Set<string>();
  const targetEndpoint = relationTargetEndpoint(relation, direction);
  if (direction === "forward") {
    for (const id of ids) {
      const targetResource = recordResourceName(schema, id, targetEndpoint);
      const joinStore = getJoinStoreKey(resource, relationName, targetResource);
      const rows = await storage.getJoinRowsInverse(joinStore, id);
      rows.forEach((row) => {
        if (typeof row.from === "string") values.add(row.from);
      });
    }
    return [...values];
  }

  for (const id of ids) {
    const sourceResource =
      resolveEndpointResource(relation.from, id, schema) ?? resourceNameFromId(id);
    const fromResources = sourceResource ? [sourceResource] : endpointList(relation.from);
    for (const fromResource of fromResources) {
      const joinStore = getJoinStoreKey(fromResource, relationName, resource);
      const rows = await storage.getJoinRows(joinStore, id);
      rows.forEach((row) => {
        if (typeof row.to === "string") values.add(row.to);
      });
    }
  }
  return [...values];
}

async function resolveRelationSeedIds(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  filters: Record<string, unknown>,
): Promise<string[] | null> {
  const relationFilter = findRelationIdFilter(filters);
  if (!relationFilter) return null;
  const match = findRelationMatch(schema, resource, relationFilter.relationName);
  if (!match) return null;
  if (match.relation.type === "many-many") {
    return resolveManyManyRelationSeedIds(
      storage,
      schema,
      resource,
      match.relation.relation || relationFilter.relationName,
      relationFilter.ids,
      match.relation,
      match.direction,
    );
  }
  return null;
}

async function getRelatedRecords(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  relationName: string,
): Promise<Record<string, unknown>[]> {
  const match = findRelationMatch(schema, resource, relationName);
  if (!match) return [];
  const { relation, direction } = match;
  const isForward = direction === "forward";
  const targetEndpoint = relationTargetEndpoint(relation, direction);

  if (relation.type === "many-one") {
    if (isForward) {
      const fk = relationFkFieldForManyOne(relation);
      const targetId = record[fk];
      if (typeof targetId !== "string") return [];
      const target = await storage.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId);
      return target ? [target] : [];
    }
    const fk = relationFkFieldForManyOne(relation);
    const records = [];
    for (const targetResource of endpointList(targetEndpoint)) {
      records.push(...await storage.findRecords(targetResource, fk, record.id));
    }
    return records;
  }

  if (relation.type === "one-many") {
    if (isForward) {
      const fk = relation.fkField || relation.foreignKey || relation.inverse || `${resource}Id`;
      const records = [];
      for (const targetResource of endpointList(targetEndpoint)) {
        records.push(...await storage.findRecords(targetResource, fk, record.id));
      }
      return records;
    }
    const fk = relationFkFieldForOneMany(relation);
    const targetId = record[fk];
    if (typeof targetId !== "string") return [];
    const target = await storage.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId);
    return target ? [target] : [];
  }

  if (relation.type === "many-many") {
    const targetRecords = [];
    const relationKey = relation.relation || relationName;
    if (isForward) {
      for (const targetResource of endpointList(targetEndpoint)) {
        const joinStore = getJoinStoreKey(resource, relationKey, targetResource);
        const rows = await storage.getJoinRows(joinStore, record.id as string);
        for (const row of rows) {
          if (typeof row.to !== "string") continue;
          const target = await storage.getRecord(recordResourceName(schema, row.to, targetEndpoint), row.to);
          if (target) targetRecords.push(target);
        }
      }
      return targetRecords;
    }

    for (const fromResource of endpointList(relation.from)) {
      const joinStore = getJoinStoreKey(fromResource, relationKey, resource);
      const rows = await storage.getJoinRowsInverse(joinStore, record.id as string);
      for (const row of rows) {
        if (typeof row.from !== "string") continue;
        const target = await storage.getRecord(recordResourceName(schema, row.from, targetEndpoint), row.from);
        if (target) targetRecords.push(target);
      }
    }
    return targetRecords;
  }

  return [];
}

async function evaluateRelatedRecords(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  relatedRecords: Record<string, unknown>[],
  targetEndpoint: string | readonly string[],
  filter: Record<string, unknown>,
  mode: "$any" | "$all" | "$none",
): Promise<boolean> {
  if (mode === "$all" && relatedRecords.length === 0) return false;
  if (mode === "$none" && relatedRecords.length === 0) return true;
  let matchedCount = 0;
  for (const relatedRecord of relatedRecords) {
    const relatedResource = recordResourceName(schema, relatedRecord.id, targetEndpoint);
    if (
      await applyFilter(
        storage,
        schema,
        relatedResource,
        relatedRecord,
        normalizeFilterOps(filter),
      )
    ) {
      matchedCount += 1;
      if (mode === "$any") return true;
      if (mode === "$none") return false;
    } else if (mode === "$all") {
      return false;
    }
  }
  return mode === "$all" ? matchedCount === relatedRecords.length : mode === "$none";
}

async function evaluateRelationQuantifierFilter(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  relationName: string,
  ops: Record<string, unknown>,
  path: string,
): Promise<boolean> {
  const match = findRelationMatch(schema, resource, relationName);
  if (!match) return false;
  const relatedRecords = await getRelatedRecords(storage, schema, resource, record, relationName);
  const targetEndpoint = relationTargetEndpoint(match.relation, match.direction);
  for (const mode of ["$any", "$all", "$none"] as const) {
    if (!(mode in ops)) continue;
    if (!isPlainRecord(ops[mode])) {
      throw {
        code: "DFQL_INVALID",
        message: `${mode} requires object filter: ${path}.${mode}`,
      };
    }
    if (
      !(await evaluateRelatedRecords(
        storage,
        schema,
        relatedRecords,
        targetEndpoint,
        ops[mode] as Record<string, unknown>,
        mode,
      ))
    ) {
      return false;
    }
  }
  return true;
}

function isRelationPathFilter(
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (!key.includes(".")) return false;
  const [relationName] = key.split(".");
  if (!findRelationMatch(schema, resource, relationName)) return false;
  if (record[relationName] !== undefined && record[relationName] !== null) {
    return false;
  }
  return true;
}

async function evaluateRelationPathFilter(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string,
): Promise<boolean> {
  const [relationName, ...rest] = key.split(".");
  const match = findRelationMatch(schema, resource, relationName);
  if (!match) return false;
  const relatedRecords = await getRelatedRecords(storage, schema, resource, record, relationName);
  if (relatedRecords.length === 0) return false;
  const subPath = rest.join(".");
  if (!subPath) return false;
  const subFilter: Record<string, unknown> = { [subPath]: value };
  const targetEndpoint = relationTargetEndpoint(match.relation, match.direction);
  for (const relatedRecord of relatedRecords) {
    const relatedResource = recordResourceName(schema, relatedRecord.id, targetEndpoint);
    if (
      await applyFilter(
        storage,
        schema,
        relatedResource,
        relatedRecord,
        normalizeFilterOps(subFilter),
        path,
      )
    ) {
      return true;
    }
  }
  return false;
}

// normalizeFilterOps is imported from @datafn/core above.

/**
 * Detect if filters contain a single-field eq that could use an index.
 * Returns null if not applicable, or { field, value } if applicable.
 */
function detectSingleFieldEq(
  filters: Record<string, unknown>,
): { field: string; value: unknown } | null {
  const keys = Object.keys(filters);
  
  // Only consider if exactly one field and it's not a logical operator
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key.startsWith("$")) return null;
  
  const val = filters[key];
  
  // Check for { field: { eq: value } } or { field: { $eq: value } }
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const ops = val as Record<string, unknown>;
    if (ops.eq !== undefined && Object.keys(ops).length === 1) {
      return { field: key, value: ops.eq };
    }
    if (ops.$eq !== undefined && Object.keys(ops).length === 1) {
      return { field: key, value: ops.$eq };
    }
  }
  
  return null;
}
