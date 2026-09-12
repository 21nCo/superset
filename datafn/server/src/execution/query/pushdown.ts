/**
 * Full and partial push-down query execution (Phase 02/03)
 *
 * FULL_PUSHDOWN:    executes DFQL entirely via the adapter's `findMany`,
 *                  bypassing DbDataStore.  Covers SCALE-002/005/006/007.
 * PARTIAL_PUSHDOWN: pushes filters/sort/limit to adapter for the primary
 *                  resource, then loads related records on demand and
 *                  runs in-memory relation expansion via materializeSelect.
 *                  Covers SCALE-003.
 */

import type { DatafnSchema } from "../../core-types.js";
import {
  endpointIncludes,
  resolveCapabilities,
  getCapabilityFields,
  stripNullsForNonNullableFields,
} from "@datafn/core";
import type { CapabilityEntry, ShareableCapability } from "@datafn/core";
import type { Adapter, WhereClause } from "@superfunctions/db";
import type { DFQLQuery, QueryResult } from "./dfql.js";
import { convertDfqlFilters, convertDfqlSort } from "./planner.js";
import { parseSortTerms, validateSortForCursor } from "./sort.js";
import { computeNextCursor, applyCursorAfter } from "./pagination.js";
import { materializeSelect } from "./select.js";
import { DbDataStore } from "../db-store.js";
import { DatafnExecutionError } from "../errors.js";

export interface QueryMetadata {
  includeTrashed?: boolean;
  includeArchived?: boolean;
  includeAncestorInactive?: boolean;
  shareableAccessIds?: string[];
  hasShareableScopeAccess?: boolean;
  accessMode?: "namespace" | "sharedWithMe";
  namespaceFilter?: string[];
  /**
   * PERF-001 diagnostics: optional runtime ACL index catalog and enforcement flag.
   * Intended for startup/benchmark diagnostics and smoke checks.
   */
  aclIndexCatalog?: string[];
  enforceAclIndexCatalog?: boolean;
}

type QueryWithMetadata = DFQLQuery & {
  metadata?: QueryMetadata;
};

const REQUIRED_ACL_INDEXES = [
  "__datafn_permissions_global_resource_record_idx",
  "__datafn_permissions_global_scope_idx",
  "__datafn_principal_hierarchy_namespace_principal_parent_idx",
  "__datafn_principal_memberships_namespace_actor_principal_idx",
  "idx_perm_principal",
  "idx_perm_resource_ns_principal",
] as const;

export interface AclIndexCoverageResult {
  usesIndex: boolean;
  requiredIndexes: string[];
  missingIndexes: string[];
}

function isShareableCapability(entry: CapabilityEntry): entry is ShareableCapability {
  return typeof entry === "object" && entry !== null && "shareable" in entry;
}

function normalizeIndexNames(indexes: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const index of indexes) {
    if (typeof index !== "string") {
      continue;
    }
    const trimmed = index.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  return Array.from(normalized).sort((a, b) => a.localeCompare(b));
}

export function getRequiredAclIndexes(): string[] {
  return normalizeIndexNames(REQUIRED_ACL_INDEXES);
}

export function evaluateAclIndexCoverage(
  indexCatalog: readonly string[],
): AclIndexCoverageResult {
  const available = new Set(normalizeIndexNames(indexCatalog));
  const required = getRequiredAclIndexes();
  const missingIndexes = required.filter((indexName) => !available.has(indexName));
  return {
    usesIndex: missingIndexes.length === 0,
    requiredIndexes: required,
    missingIndexes,
  };
}

export function assertRequiredAclIndexes(indexCatalog: readonly string[]): void {
  const diagnostics = evaluateAclIndexCoverage(indexCatalog);
  if (diagnostics.usesIndex) {
    return;
  }
  throw new DatafnExecutionError(
    "INTERNAL",
    "Required ACL index missing",
    "db.indexes",
    {
      missingIndexes: diagnostics.missingIndexes,
      requiredIndexes: diagnostics.requiredIndexes,
    },
  );
}

function mergeAutoFilters(
  existingFilters: Record<string, unknown> | undefined,
  autoFilters: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (autoFilters.length === 0) {
    return existingFilters;
  }
  if (!existingFilters || Object.keys(existingFilters).length === 0) {
    return autoFilters.length === 1 ? autoFilters[0] : { $and: autoFilters };
  }
  if (
    Array.isArray(existingFilters.$and) &&
    Object.keys(existingFilters).length === 1
  ) {
    return {
      $and: [...(existingFilters.$and as Record<string, unknown>[]), ...autoFilters],
    };
  }
  return { $and: [existingFilters, ...autoFilters] };
}

export function injectCapabilityAutoFilters(
  query: QueryWithMetadata,
  schema: DatafnSchema,
): QueryWithMetadata {
  const resource = schema.resources.find((r) => r.name === query.resource);
  if (!resource) {
    return query;
  }

  const resolvedCapabilities = resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );
  const metadata = query.metadata ?? {};
  const autoFilters: Record<string, unknown>[] = [];

  if (
    resolvedCapabilities.some((capability: unknown) => capability === "trash") &&
    metadata.includeTrashed !== true
  ) {
    autoFilters.push({ trashedAt: { $is_null: true } });
  }

  if (
    resolvedCapabilities.some((capability: unknown) => capability === "archivable") &&
    metadata.includeArchived !== true
  ) {
    autoFilters.push({ isArchived: { $ne: true } });
  }

  if (
    metadata.includeAncestorInactive !== true &&
    schema.relations?.some((relation) => {
      if (relation.inheritsInactive !== true) return false;
      const dependentEndpoint = relation.type === "many-one" ? relation.from : relation.to;
      return endpointIncludes(dependentEndpoint, query.resource);
    })
  ) {
    autoFilters.push({ isAncestorInactive: { $ne: true } });
  }

  const shareableCapability = resolvedCapabilities.find(isShareableCapability);
  if (
    shareableCapability?.shareable.default === "private" &&
    metadata.accessMode !== "sharedWithMe"
  ) {
    if (metadata.hasShareableScopeAccess === true) {
      // Scope grants already authorize the full namespace resource set.
    } else {
    const accessIds = Array.isArray(metadata.shareableAccessIds)
      ? metadata.shareableAccessIds
      : [];
      if (accessIds.length === 0) {
        autoFilters.push({ id: { $in: ["__datafn_no_access__"] } });
      } else {
        autoFilters.push({ id: { $in: accessIds } });
      }
    }
  }

  if (autoFilters.length === 0) {
    return query;
  }

  const existingFilters =
    query.filters &&
    typeof query.filters === "object" &&
    !Array.isArray(query.filters)
      ? (query.filters as Record<string, unknown>)
      : undefined;

  return {
    ...query,
    filters: mergeAutoFilters(existingFilters, autoFilters),
  };
}

/**
 * Execute a DFQL query classified as FULL_PUSHDOWN directly against the adapter.
 *
 * - Base filters, sort, limit, and offset are pushed to `db.findMany()`
 * - Cursor pagination is applied in-memory on the already-sorted result set
 * - Simple field projection (no relation expansion — FULL_PUSHDOWN only)
 * - Optional count via `db.count()` with the same where clauses
 */
export async function executePushdownQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
): Promise<QueryResult> {
  const { records, nextCursor, count } = await pushdownCore(
    query,
    schema,
    db,
    namespace,
  );

  // Simple field projection (no relation expansion)
  const data = records.map((record) =>
    projectFieldsPushdown(
      record,
      query.resource,
      schema,
      query.select,
      query.omit,
    ),
  );

  return { data, count, nextCursor };
}

// ---------------------------------------------------------------------------
// Partial push-down (Phase 03)
// ---------------------------------------------------------------------------

/**
 * Execute a DFQL query classified as PARTIAL_PUSHDOWN.
 *
 * - Filters, sort, and pagination that apply only to the primary resource
 *   are pushed to `db.findMany()` (same as FULL_PUSHDOWN core)
 * - The resulting primary records are then used to create a targeted
 *   DbDataStore via `forPushdownResult()`, which loads only the related
 *   records referenced by the select list
 * - Relation expansion and final projection are handled by `materializeSelect`
 *
 * Covers SCALE-003: partial push-down for queries with relations.
 */
export async function executePartialPushdownQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  actorId?: string,
): Promise<QueryResult> {
  // 1. Execute the push-down core (same as FULL_PUSHDOWN up to trimming)
  const { records, nextCursor, count } = await pushdownCore(
    query,
    schema,
    db,
    namespace,
  );

  // 2. Build a targeted DataStore from the already-fetched primary records.
  //    forPushdownResult() only loads related records that the select list
  //    actually needs, avoiding full table scans.
  const store = await DbDataStore.forPushdownResult(
    db,
    records,
    query.resource,
    { select: query.select },
    schema,
    namespace,
    undefined,
    actorId,
  );

  // 3. Materialize select (relation expansion + field projection)
  const data = records.map((record) =>
    materializeSelect(
      record,
      query.resource,
      query.select,
      schema,
      store,
      query.omit,
      query.metadata,
    ),
  );

  return { data, count, nextCursor };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Shared push-down core: converts filters, pushes sort/limit/cursor to the
 * adapter, applies in-memory cursor slicing, and optionally fetches count.
 *
 * Both FULL_PUSHDOWN and PARTIAL_PUSHDOWN use this logic for the primary
 * resource fetch; they differ only in how the result set is projected.
 */
async function pushdownCore(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
): Promise<{
  records: Record<string, unknown>[];
  nextCursor: Record<string, unknown> | null;
  count: number | undefined;
}> {
  const queryWithAutoFilters = injectCapabilityAutoFilters(
    query as QueryWithMetadata,
    schema,
  );
  const metadata =
    queryWithAutoFilters.metadata &&
    typeof queryWithAutoFilters.metadata === "object"
      ? (queryWithAutoFilters.metadata as QueryMetadata)
      : undefined;

  if (
    metadata?.accessMode === "sharedWithMe" &&
    (metadata.enforceAclIndexCatalog === true || Array.isArray(metadata.aclIndexCatalog))
  ) {
    assertRequiredAclIndexes(metadata.aclIndexCatalog ?? []);
  }

  // 1. Convert filters and sort -------------------------------------------
  const whereClauses: WhereClause[] = queryWithAutoFilters.filters
    ? ((convertDfqlFilters(
        queryWithAutoFilters.filters,
        queryWithAutoFilters.resource,
        schema,
      ) ?? []) as WhereClause[])
    : [];

  const orderBy = convertDfqlSort(queryWithAutoFilters.sort);
  const sortTerms = parseSortTerms(queryWithAutoFilters.sort);

  // 2. Cursor validation ---------------------------------------------------
  const hasCursor =
    queryWithAutoFilters.cursor?.after != null ||
    queryWithAutoFilters.cursor?.before != null;

  if (hasCursor && !validateSortForCursor(sortTerms)) {
    throw new DatafnExecutionError(
      "DFQL_INVALID",
      "Invalid DFQL: cursor requires sort with id tie-breaker",
      "cursor",
    );
  }

  // 3. Push limit/offset to adapter
  // For cursor queries, apply cursor trimming in-memory against the full
  // sorted row set; applying limit at adapter level can truncate rows that
  // should appear on later pages (TV-PUSHDOWN-008).
  const pushdownLimit =
    !hasCursor && queryWithAutoFilters.limit != null
      ? queryWithAutoFilters.limit + 1 // +1 to detect next page
      : undefined;
  // Offset only applies to non-cursor queries (cursor handles position)
  const pushdownOffset = !hasCursor ? queryWithAutoFilters.offset : undefined;

  // 4. Fetch from adapter -------------------------------------------------
  const rows: Record<string, unknown>[] = await db.findMany({
    model: query.resource,
    where: whereClauses,
    orderBy,
    limit: pushdownLimit,
    offset: pushdownOffset,
    namespace,
  });

  // 5. Cursor pagination (in-memory on already-sorted adapter results) ----
  let records = rows;

  if (queryWithAutoFilters.cursor?.after) {
    records = applyCursorAfter(records, queryWithAutoFilters.cursor.after, sortTerms);
  } else if (queryWithAutoFilters.cursor?.before) {
    const reversedRecords = [...records].reverse();
    const invertedSortTerms = sortTerms.map((t) => ({
      field: t.field,
      direction: (t.direction === "asc" ? "desc" : "asc") as "asc" | "desc",
    }));
    let workRecords = applyCursorAfter(
      reversedRecords,
      queryWithAutoFilters.cursor.before,
      invertedSortTerms,
    );
    if (queryWithAutoFilters.limit) {
      workRecords = workRecords.slice(0, queryWithAutoFilters.limit);
    }
    records = workRecords.reverse();
  }

  // 6. Compute nextCursor and trim to limit --------------------------------
  const effectiveLimit = queryWithAutoFilters.limit;
  let nextCursor: Record<string, unknown> | null = null;

  if (hasCursor) {
    if (queryWithAutoFilters.cursor?.after) {
      const sliceForCheck = effectiveLimit
        ? records.slice(0, effectiveLimit + 1)
        : records;
      nextCursor = computeNextCursor(sliceForCheck, sortTerms, effectiveLimit);
      if (effectiveLimit && records.length > effectiveLimit) {
        records = records.slice(0, effectiveLimit);
      }
    } else if (queryWithAutoFilters.cursor?.before && records.length > 0) {
      const lastItem = records[records.length - 1];
      const cursorObj: Record<string, unknown> = {};
      for (const term of sortTerms) {
        cursorObj[term.field] = lastItem[term.field];
      }
      nextCursor = cursorObj;
    }
  } else {
    nextCursor = computeNextCursor(records, sortTerms, effectiveLimit);
    if (effectiveLimit && records.length > effectiveLimit) {
      records = records.slice(0, effectiveLimit);
    }
  }

  // 7. Optional count -------------------------------------------------------
  let count: number | undefined;
  if (queryWithAutoFilters.count === true) {
    count = await db.count({
      model: queryWithAutoFilters.resource,
      where: whereClauses,
      namespace,
    });
  }

  return { records, nextCursor, count };
}

/**
 * Simple field projection for the FULL_PUSHDOWN path.
 * Returns only base schema fields — no relation expansion.
 */
function projectFieldsPushdown(
  record: Record<string, unknown>,
  resource: string,
  schema: DatafnSchema,
  select: string[] | undefined,
  omit: string[] | undefined,
): Record<string, unknown> {
  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) return { id: record.id };

  // Persisted stores can hold null for non-nullable fields (nullable SQL
  // columns, replace clears). Expose them as undefined in query results.
  record = stripNullsForNonNullableFields(record, resourceSchema);

  const resolvedCapabilities = resolveCapabilities(
    schema.capabilities as any,
    resourceSchema.capabilities as any,
  );
  const baseFields = new Set<string>(["id"]);
  for (const capabilityField of getCapabilityFields(resolvedCapabilities as any)) {
    baseFields.add(capabilityField.name);
  }
  for (const f of resourceSchema.fields) baseFields.add(f.name);

  const assignBaseFields = (target: Record<string, unknown>) => {
    for (const field of baseFields) {
      if (record[field] !== undefined) {
        target[field] = record[field];
      }
    }
  };

  let result: Record<string, unknown>;

  if (!select || select.length === 0) {
    // No select: return id + all schema-defined fields present in record
    result = {};
    assignBaseFields(result);
  } else if (select.includes("*")) {
    // Bare wildcard: all base fields + any additional explicit tokens
    result = {};
    assignBaseFields(result);
    for (const token of select) {
      if (token !== "*" && baseFields.has(token) && !(token in result)) {
        result[token] = record[token];
      }
    }
  } else {
    // Explicit field list: pick only requested base fields
    result = {};
    for (const token of select) {
      if (baseFields.has(token)) {
        result[token] = record[token];
      }
    }
  }

  // Apply omit (id is never omitted)
  if (omit && omit.length > 0) {
    for (const field of omit) {
      if (field !== "id") {
        delete result[field];
      }
    }
  }

  return result;
}
