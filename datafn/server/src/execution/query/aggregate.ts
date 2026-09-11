import { evaluateFilter } from "./filters.js";
import { parseSortTerms } from "./sort.js";
import {
  calculateAggregation,
  findRelationMatch,
  firstEndpoint,
  getTemporalGroups,
  relationTargetEndpoint,
  relationFkFieldForManyOne,
  resolveEndpointResource,
  resolveTemporalBucketValue,
  resourceNameFromId,
  type DatafnTemporalConfig,
} from "@datafn/core";
import { applyLimitOffset, applyCursorAfter, computeNextCursor } from "./pagination.js";

/**
 * Execute an aggregate query using in-memory grouping and aggregation
 */
export function executeAggregateQuery(
  query: Record<string, unknown>,
  records: Record<string, unknown>[],
  schema: { resources: readonly { name: string; fields: readonly { name: string; nullable?: boolean }[] }[]; relations?: readonly unknown[] },
  store: { getRecord: (resource: string, id: string) => Record<string, unknown> | null | undefined },
  temporal?: DatafnTemporalConfig,
): { groups: Record<string, unknown>[]; nextCursor: unknown | null } {
  // EXE-013: Cache resource schema lookup (called per record otherwise)
  const resourceSchema = schema.resources.find((r) => r.name === query.resource);

  // 1. Filter
  let filtered = records;

  if (query.filters) {
    filtered = records.filter((record) =>
      evaluateFilter(
        record,
        query.filters as any,
        query.resource as string,
        schema,
        store,
      ),
    );
  }

  // 2. Group
  const groupBy = Array.isArray(query.groupBy) ? (query.groupBy as string[]) : [];
  const temporalGroups = getTemporalGroups(query, temporal);
  const groups = new Map<string, Record<string, unknown>[]>();

  for (const record of filtered) {
    const keyParts = groupBy.map((field) => {
      // Resolve field value (support dot path)
      const val = resolveValue(
        record,
        field,
        schema,
        store,
        query.resource as string,
        resourceSchema,
      );
      return val; // Composite key component
    });
    for (const group of temporalGroups) {
      keyParts.push(resolveTemporalBucketValue(record, group));
    }
    const key = JSON.stringify(keyParts); // Structured key avoids collision when values contain separator chars

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  // 3. Aggregate
  const aggregations = (query.aggregations as Record<string, { op: string; field: string }>) || {};
  let results: Record<string, unknown>[] = [];

  for (const [, groupRecords] of groups.entries()) {
    const row: Record<string, unknown> = {};

    // Add group keys to row — re-resolve from sample record to preserve types
    groupBy.forEach((field) => {
      const sample = groupRecords[0];
      const val = resolveValue(
        sample,
        field,
        schema,
        store,
        query.resource as string,
        resourceSchema,
      );
      // Cleared non-nullable fields normalize to absent; keep that contract
      // in group rows instead of materializing an undefined key.
      if (val !== undefined) {
        row[field] = val;
      }
    });
    for (const group of temporalGroups) {
      row[group.alias] = resolveTemporalBucketValue(groupRecords[0], group);
    }

    // Calculate aggregations
    for (const [alias, def] of Object.entries(aggregations)) {
      const { op, field } = def as { op: string; field: string };
      row[alias] = calculateAggregation(op, field, groupRecords);
    }

    results.push(row);
  }

  // 4. Having
  if (query.having) {
    results = results.filter((row) =>
      evaluateFilter(
        row,
        query.having as Record<string, unknown>,
        query.resource as string,
        schema as Parameters<typeof evaluateFilter>[3],
        store as Parameters<typeof evaluateFilter>[4],
      ),
    );
  }

  // 5. Order
  const sort = query.sort as string[] | undefined;
  // If no sort provided, default to group keys ASC
  const effectiveSort = sort || [
    ...groupBy.map(k => `${k}:asc`),
    ...temporalGroups.map((group) => `${group.alias}:asc`),
  ];
  
  const sortTerms = parseSortTerms(effectiveSort);
  results = orderGroupedResults(results, sortTerms);

  // 6. Pagination (Cursor/Limit/Offset)
  // Apply cursor.after if present
  if (query.cursor && (query.cursor as any).after) {
    results = applyCursorAfter(results, (query.cursor as any).after, sortTerms);
  }
  
  // Apply limit/offset
  // Fetch limit + 1 for nextCursor check
  const limit = typeof query.limit === "number" ? query.limit : undefined;
  const offset = typeof query.offset === "number" ? query.offset : undefined;
  
  // Apply Limit+Offset
  const paginated = applyLimitOffset(results, limit ? limit + 1 : undefined, offset);
  
  // Compute nextCursor
  const nextCursor = computeNextCursor(paginated, sortTerms, limit);
  
  // Slice to limit
  if (limit && paginated.length > limit) {
    paginated.length = limit;
  }

  return {
    groups: paginated.map((row) => {
      const output = { ...row };
      for (const field of groupBy) {
        // Never normalize an aggregation alias as if it were a source field.
        if (Object.prototype.hasOwnProperty.call(aggregations, field)) continue;
        const definition = resourceSchema?.fields.find((entry) => entry.name === field);
        if (definition && definition.nullable !== true && output[field] === null) {
          delete output[field];
        }
      }
      return output;
    }),
    nextCursor,
  };
}

function orderGroupedResults(groups: Record<string, unknown>[], sortTerms: Array<{ field: string; direction: string }>): Record<string, unknown>[] {
  const compareUnknown = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === "number" && typeof b === "number") {
      return a < b ? -1 : 1;
    }
    const aText = String(a);
    const bText = String(b);
    return aText < bText ? -1 : aText > bText ? 1 : 0;
  };

  // LOW-019: Use spread to avoid mutating the input array
  return [...groups].sort((a, b) => {
    for (const term of sortTerms) {
      const field = term.field;
      const direction = term.direction === "asc" ? 1 : -1;
      
      const valA = a[field];
      const valB = b[field];
      const cmp = compareUnknown(valA, valB);
      if (cmp < 0) return -1 * direction;
      if (cmp > 0) return 1 * direction;
    }
    return 0;
  });
}

function resolveValue(
  record: Record<string, unknown>,
  path: string,
  schema: { resources: readonly { name: string; fields: readonly { name: string; nullable?: boolean }[] }[]; relations?: readonly unknown[] },
  store: { getRecord: (resource: string, id: string) => Record<string, unknown> | null | undefined },
  resourceName: string,
  precomputedResource?: { name: string; fields: readonly { name: string; nullable?: boolean }[] }, // EXE-013: pre-computed to avoid per-record O(n) lookup
): unknown {
  if (!path.includes(".")) {
    return record[path];
  }

  // Dot path resolution
  const parts = path.split(".");

  // EXE-013: Use pre-computed resource schema when available
  const resource = precomputedResource ?? schema.resources.find((r) => r.name === resourceName);
  const baseName = parts[0];
  const isField = resource?.fields.some((f) => f.name === baseName);
  
  if (isField) {
      // Nested object traversal
      let current: unknown = record;
      for (const part of parts) {
          if (current === null || current === undefined) return undefined;
          if (typeof current !== "object") return undefined;
          current = (current as Record<string, unknown>)[part];
      }
      return current;
  }

  let currentRecord: Record<string, unknown> = record;
  let currentResource = resourceName;

  for (let i = 0; i < parts.length - 1; i++) {
    const relName = parts[i];
    const match = findRelationMatch(schema as any, currentResource, relName);

    if (!match) return undefined; // Invalid path or not loaded

    const rel = match.relation as Record<string, unknown>;
    const isForward = match.direction === "forward";

    if (rel.type === "many-one" && isForward) {
      const fk = relationFkFieldForManyOne(match.relation as any);
      const targetId = currentRecord[fk];
      if (!targetId) return null;
      const targetEndpoint = relationTargetEndpoint(match.relation as any, match.direction);
      const targetResource =
        resolveEndpointResource(targetEndpoint, targetId, schema) ??
        resourceNameFromId(targetId) ??
        firstEndpoint(targetEndpoint);
      const target = store.getRecord(targetResource, targetId as string);
      if (!target) return null;
      currentRecord = target;
      currentResource = targetResource;
    } else {
      return undefined; // Not supported
    }
  }

  const lastField = parts[parts.length - 1];
  return currentRecord[lastField];
}

// calculateAggregation is imported from @datafn/core above.
