/**
 * Offline aggregation logic
 */

import type { DatafnSchema, DatafnTemporalConfig } from "@datafn/core";
import {
  stripNullsForNonNullableFields,
  evaluateFilter as coreEvaluateFilter,
  calculateAggregation,
  getTemporalGroups,
  resolveTemporalBucketValue,
} from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import { expandRelation } from "./relations.js";

/**
 * Execute aggregate query locally
 */
export async function executeAggregateQuery(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  temporal?: DatafnTemporalConfig,
): Promise<{ groups: Record<string, unknown>[]; nextCursor: null }> {
  // 1. Fetch all records
  // We assume filter is already applied? No, query executor applies filters.
  // But query executor calls THIS function instead of normal flow?
  // Yes, spec says: "Check if query has groupBy: If yes: call executeAggregateQuery".
  // So we need to fetch and filter here.
  // But filtering logic is in `client/src/offline/query.ts` (implied, not yet existing).
  // Actually, standard `executeLocalQuery` logic does filtering.
  // We should reuse filter logic.
  // Let's assume caller passes filtered records?
  // Or we fetch all and filter.
  // Reusing filter logic is better.
  // I will accept `records` as argument?
  // Spec says: "executeAggregateQuery(storage, schema, query)".
  // "Fetch all records... Apply filters...".
  // So I need to implement filtering here or import it.
  
  // To avoid duplication, `offline/query.ts` should handle fetching and filtering, then pass `records` to `executeAggregateQuery`?
  // Spec: "If yes: call executeAggregateQuery".
  // "executeAggregateQuery" steps include "Fetch all records... Apply filters".
  // Okay, I will import `filterRecords` helper from query module if available, or duplicate simple filter logic.
  // Client filters are usually simple (sift).
  
  const resource = query.resource as string;
  let records = await storage.listRecords(resource);
  
  // Apply filters
  if (query.filters) {
      // Need filter logic.
      // I'll define a simple evaluator or import if possible.
      // `sift` is common but I should use custom logic matching server?
      // "OFFLINE-001: Local DFQL expansion" implies matching semantics.
      // server uses `evaluateFilter`.
      // Can I share `evaluateFilter` code? It's in `server/src`. Client cannot import server code.
      // I need a client-side `evaluateFilter`.
      // For now, I will implement a basic one here or stub it.
      // Spec requirement "OFFLINE-002" says "support groupBy... filtering grouped rows deterministically".
      // It doesn't explicitly demand full filter parity but implied.
      // I will assume `evaluateFilter` is available or implement a basic one.
      
      records = records.filter(r => coreEvaluateFilter(r, query.filters as Record<string, unknown>));
  }

  // 2. Group By
  const groupBy = Array.isArray(query.groupBy) ? (query.groupBy as string[]) : [];
  const temporalGroups = getTemporalGroups(query, temporal);
  const groups = new Map<string, Record<string, unknown>[]>();
  
  for (const record of records) {
      // Resolve group key
      const keyParts = [];
      for (const field of groupBy) {
          // Handle dot paths?
          // Simple field access for now.
          keyParts.push(record[field]);
      }
      for (const group of temporalGroups) {
          keyParts.push(resolveTemporalBucketValue(record, group));
      }
      const groupKey = JSON.stringify(keyParts); // Collision-safe key (DUP-10)
      
      if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(record);
  }

  // 3. Aggregations
  const results = [];
  const aggregations = query.aggregations as Record<string, Record<string, unknown>>;
  
  for (const [, rows] of groups.entries()) {
      const result: Record<string, unknown> = {};
      
      // LOW-022: group key is JSON.stringify(keyParts) — splitting with "::" is not
      // meaningful. Restore typed group-key values directly from the first row's fields.
      groupBy.forEach((field) => {
          result[field] = rows[0][field];
      });
      for (const group of temporalGroups) {
          result[group.alias] = resolveTemporalBucketValue(rows[0], group);
      }
      
      // Compute aggregations using shared core implementation
      if (aggregations) {
          for (const [alias, def] of Object.entries(aggregations)) {
              const op = def.op as string;
              const field = def.field as string;
              result[alias] = calculateAggregation(op, field, rows);
          }
      }
      
      results.push(result);
  }

  // 4. Having
  if (query.having) {
      // Filter results
      const having = query.having as Record<string, unknown>;
      // Reuse evaluateFilter
      const filteredResults = results.filter(r => coreEvaluateFilter(r, having));
      // Reassign
      results.length = 0;
      results.push(...filteredResults);
  }

  // 5. Sort (Deterministic)
  // Default sort by group keys
  results.sort((a, b) => {
      for (const field of groupBy) {
          const va = a[field] as any;
          const vb = b[field] as any;
          if (va < vb) return -1;
          if (va > vb) return 1;
      }
      for (const group of temporalGroups) {
          const va = a[group.alias] as any;
          const vb = b[group.alias] as any;
          if (va < vb) return -1;
          if (va > vb) return 1;
      }
      return 0;
  });

  const resourceSchema = schema.resources.find((entry) => entry.name === resource);
  return {
    groups: results.map((row) => {
      const groupValues = Object.fromEntries(groupBy
        .filter((field) => !Object.prototype.hasOwnProperty.call(aggregations ?? {}, field))
        .map((field) => [field, row[field]]));
      const normalized = stripNullsForNonNullableFields(groupValues, resourceSchema);
      const output = { ...row };
      for (const field of Object.keys(groupValues)) {
        if (!Object.prototype.hasOwnProperty.call(normalized, field)) delete output[field];
      }
      return output;
    }),
    nextCursor: null, // Pagination not fully implemented for local aggregation in this phase
  };
}
