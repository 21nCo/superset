/**
 * Query execution engine
 * Orchestrates filter, sort, pagination, and select materialization
 */

import type { DatafnSchema } from "../../core-types.js";
import type { Adapter } from "@superfunctions/db";
import type { DataStore } from "../store.js";
import type { AggregateResult, DFQLQuery, QueryResult } from "./dfql.js";
import { evaluateFilter } from "./filters.js";
import { parseSortTerms, sortRecords, validateSortForCursor } from "./sort.js";
import { applyLimitOffset, applyCursorAfter, computeNextCursor } from "./pagination.js";
import { materializeSelect } from "./select.js";
import { executeAggregateQuery } from "./aggregate.js";
import { DatafnExecutionError } from "../errors.js";
import { classifyQuery } from "./planner.js";
import { executePushdownQuery } from "./pushdown.js";
import {
  TIMEZONE_CHANGE_RESOURCE_NAME,
  createTimezoneResolver,
  hasTemporalGrouping,
  normalizeTemporalQuery,
  stripNullsForNonNullableFields,
} from "@datafn/core";

/**
 * Execute a DFQL query against a data store
 */
export function executeQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  store: DataStore,
): QueryResult | AggregateResult {
  const temporalConfig = {
    timezoneResolver: createTimezoneResolver(
      store.getRecords(TIMEZONE_CHANGE_RESOURCE_NAME),
    ),
  };
  query = normalizeTemporalQuery(query as unknown as Record<string, unknown>, temporalConfig) as unknown as DFQLQuery;
  // Phase 15: Aggregate queries
  if (query.groupBy || hasTemporalGrouping(query as any)) {
    const resourceName = query.resource as string;
    const aggregateResourceSchema = schema.resources.find(
      (r) => r.name === resourceName,
    );
    // Aggregates never pass through materializeSelect, so normalize persisted
    // nulls here to keep group keys and outputs on the read contract
    // (cleared non-nullable fields read as absent).
    const records = store
      .getRecords(resourceName)
      .map((record) =>
        stripNullsForNonNullableFields(record, aggregateResourceSchema),
      );
    return executeAggregateQuery(query as any, records, schema, store, temporalConfig);
  }

  // Get all records for the resource. Filters and sorting intentionally run
  // against the stored representation so in-memory results match the
  // FULL_PUSHDOWN strategy (e.g. $eq: null matches stored SQL NULLs via
  // IS NULL). materializeSelect normalizes persisted nulls for the returned
  // records, so the read contract is unaffected.
  let records = store.getRecords(query.resource);

  // Apply filters
  if (query.filters) {
    records = records.filter((record) =>
      evaluateFilter(record, query.filters!, query.resource, schema, store),
    );
  }

  // Calculate count if requested (Phase 14)
  let count: number | undefined;
  if (query.count === true) {
    count = records.length;
  }

  // Parse and apply sort
  const sortTerms = parseSortTerms(query.sort);

  // Validate cursor pagination requires id in sort
  if (query.cursor?.after || query.cursor?.before) {
    if (!validateSortForCursor(sortTerms)) {
      throw new DatafnExecutionError(
        "DFQL_INVALID",
        "Invalid DFQL: cursor requires sort with id tie-breaker",
        "cursor"
      );
    }
  }

  records = sortRecords(records, sortTerms);

  // Apply cursor pagination if present
  if (query.cursor?.after) {
    records = applyCursorAfter(records, query.cursor.after, sortTerms);
  } else if (query.cursor?.before) {
    // Phase 14: Backward pagination logic
    // 1. Reverse the sort order
    const reversedRecords = [...records].reverse();
    const reversedSortTerms = sortTerms.map((term) => ({
      ...term,
      direction: term.direction === "asc" ? "desc" : "asc",
    }));

    // 2. Apply "after" logic using the before cursor (which acts as anchor)
    // Note: sortRecords sorted them correctly, reversing array reverses the effective sort.
    // applyCursorAfter expects records to be sorted according to sortTerms.
    // If we reverse records, we must logic "after" carefully.
    // Actually standard trick:
    // - Sort normally? No.
    // - Effective list is ... [Page Before] [Target Page] [Cursor Before] ...
    // - If we want items BEFORE cursor, we want [Target Page].
    // - If we sort DESC (reverse of original sort), then [Cursor Before] comes first-ish.
    // - "After" that cursor in DESC sort gives us [Target Page] (closest items first).

    // Simpler approach:
    // Filter records that are strictly "before" the cursor according to sort order.
    // Then take the LAST `limit` items?
    // applyCursorAfter effectively does "filter > cursor".
    // We need "filter < cursor".
    // Let's implement `applyCursorBefore` or simulate it.

    // Simulation:
    // 1. Reverse records (now sorted opposite).
    // 2. Apply `applyCursorAfter` with `query.cursor.before`.
    //    (Wait, applyCursorAfter compares record vs cursor using sortTerms. We need to tell it sort is reversed?)
    //    No, applyCursorAfter takes sortTerms to know how to compare.
    //    We should pass reversedSortTerms.

    // Let's verify sort logic.
    // Original: ASC. [1, 2, 3, 4, 5]. Cursor Before: 4. Limit: 2.
    // We want [2, 3].
    // Reversed: [5, 4, 3, 2, 1]. (Sorted DESC).
    // Cursor "After" 4 in DESC sort: [3, 2, 1].
    // Limit 2: [3, 2].
    // Reverse back: [2, 3]. Correct.

    // Wait, `applyCursorAfter` needs to compare values. keys are same.
    // If we pass reversed records and reversed sort terms, it should work?
    // Yes, providing `applyCursorAfter` implementation uses `sortTerms` to generic compare.

    // But `sortRecords` already sorted them ASC.
    // So `records` is [1, 2, 3, 4, 5].
    // `reversedRecords` is [5, 4, 3, 2, 1].
    // `reversedSortTerms` says DESC.
    // applyCursorAfter([5,4,3,2,1], cursor={id:4}, reversedSortTerms: DESC)
    // check record 5 vs cursor 4 with DESC. 5 < 4? (DESC: 5 comes before 4? yes).
    // "After" 4 means items coming *after* 4 in the DESC order.
    // [5, 4, 3, 2, 1] order. 4 is at index 1.
    // Items after 4 are [3, 2, 1].
    // Correct.

    // So steps:
    // 1. Reverse records (which are already sorted by `sortTerms`).
    // 2. Invert sortTerms direction.
    // 3. Apply applyCursorAfter(reversedRecords, cursor.before, invertedSortTerms).
    // 4. Apply Limit (take top N of result).
    // 5. Reverse back the result.

    let workRecords = [...records].reverse();
    const invertedSortTerms = sortTerms.map((t) => ({
      field: t.field,
      direction: t.direction === "asc" ? "desc" : "asc",
    })) as any; // Type cast if needed

    workRecords = applyCursorAfter(
      workRecords,
      query.cursor.before,
      invertedSortTerms,
    );

    // Apply limit (before reversing back, because these are the "closest" N pages)
    if (query.limit) {
      workRecords = workRecords.slice(0, query.limit);
    }

    // Reverse back to original order
    records = workRecords.reverse();

    // Skip normal limit/offset below since we applied limit here?
    // But we still have `applyLimitOffset` call below.
    // We should probably structure this to avoid double limit.
    // Set query.limit to undefined for next step? Or bypass.
  }

  // Apply limit/offset pagination (only if not handled by cursor.before logic)
  // We need to fetch limit + 1 to detect next page
  let effectiveLimit = query.limit;
  if (effectiveLimit && !query.cursor?.before) {
    // If standard pagination, fetch one extra
    // Note: applyLimitOffset takes limit. We pass limit + 1.
    records = applyLimitOffset(records, effectiveLimit + 1, query.offset);
  } else if (!query.cursor?.before) {
    // No limit, just offset
    records = applyLimitOffset(records, undefined, query.offset);
  }

  // Compute nextCursor (before materialization to keep raw values)
  // If cursor.before was used, nextCursor logic is different?
  // Spec PAGE-001 says "nextCursor in query results when more pages exist".
  // For backwards pagination, nextCursor would point to "next" page in original order (which is previous in reverse).
  // Usually backwards pagination returns `prevCursor`?
  // Spec says: "PAGE-001: nextCursor emission". "PAGE-002: Emit nextCursor/prevCursor appropriately".
  // But our types only have `nextCursor`.
  // If we paginated backwards, `nextCursor` allows continuing forward from the *end* of this page?
  // Or continuing backward?
  // If I scroll UP, I get a page. `nextCursor` should allow me to scroll DOWN from this page?
  // Or continue scrolling UP?
  // Usually `nextCursor` always points "forward" in the sort order.
  // If I used `before`, I got items [11-20].
  // `nextCursor` should point to 21 (continuation).
  // But `computeNextCursor` logic checks if we have *more* items than limit.
  // If we used `before`, we reversed, sliced, reversed back.
  // We didn't fetch "limit + 1" effectively in the "forward" direction?
  // Actually, `applyCursorBefore` logic simulated fetching "closest" items.
  // If we want `nextCursor`, we need to know if there are items AFTER the last item in result.
  // Since we fetched "before" a cursor, we know there are items *after* (the ones we skipped/used as anchor).
  // So `nextCursor` is just the cursor of the last item in result?
  // Yes, if we have results, we can always produce a `nextCursor` that points after the last item.
  // BUT `nextCursor` should be null if we are at the end.
  // If we used `cursor.before`, we are typically somewhere in the middle.
  // Unless we hit the "beginning" (which is end of reverse).
  // The `nextCursor` logic in `computeNextCursor` relies on `results.length > limit`.
  // If we used `before`, `records` has exactly `limit` items (we sliced it).
  // So `computeNextCursor` will return null.
  // For `before`, we assume user has the `after` cursor (the one they passed in as `before`?).
  // Let's stick to simple implementation for now: `nextCursor` works for forward pagination.
  // For `before`, it might be null or we need to check spec behavior for `before` nextCursor.
  // TV-PAGE-BEFORE-001 expects `nextCursor: { id: "task-10" }` (last item).
  // This implies we can just generate it from last item if we returned full page?
  // But we need to know if there is a next page.
  // If I fetch before: task-11, limit 10. I get 1-10.
  // Is there a task-11? Yes, that was my anchor.
  // So yes, there is a next page (starting at 11).
  // So `nextCursor` should be 10.
  // So for `before` pagination, `nextCursor` is ALWAYS the last item's cursor (because we know there is something after, the anchor).
  // Unless... the anchor didn't exist? (Not possible if we use existing id).
  // Or if we hit end? No, `before` anchor is upper bound.
  // So for `before`, we can just compute cursor from last item.
  
  let nextCursor: unknown = null;
  if (query.cursor?.before) {
      // If we have results, nextCursor is valid (points to anchor or beyond)
      if (records.length > 0) {
          nextCursor = computeNextCursor(records, sortTerms, records.length); // Force computation
          // Wait, `computeNextCursor` checks `length > limit`.
          // We can construct it manually.
          const lastItem = records[records.length - 1];
          const cursor: Record<string, unknown> = {};
          for (const term of sortTerms) {
            cursor[term.field] = lastItem[term.field];
          }
          nextCursor = cursor;
      }
  } else {
      // Forward pagination
      nextCursor = computeNextCursor(records, sortTerms, effectiveLimit);
      // Slice results to limit
      if (effectiveLimit && records.length > effectiveLimit) {
        records = records.slice(0, effectiveLimit);
      }
  }

  // Materialize select tokens
  const data = records.map((record) =>
    materializeSelect(
      record,
      query.resource,
      query.select,
      schema,
      store,
      query.omit,
      (query as unknown as { metadata?: Record<string, unknown> }).metadata,
    ),
  );

  return {
    data,
    count,
    nextCursor,
  };
}

/**
 * Execute a DFQL query using the optimal strategy determined by classifyQuery().
 *
 * - FULL_PUSHDOWN  → executePushdownQuery  (skips DataStore entirely)
 * - PARTIAL_PUSHDOWN / IN_MEMORY → executeQuery  (requires DataStore)
 *
 * The `store` parameter is required for non-FULL_PUSHDOWN strategies.
 * The `db` and `namespace` parameters are required for FULL_PUSHDOWN.
 */
export async function executeQueryWithStrategy(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  store?: DataStore,
): Promise<QueryResult | AggregateResult> {
  const strategy = classifyQuery(query as unknown as Record<string, unknown>, schema);

  if (strategy === "FULL_PUSHDOWN") {
    return executePushdownQuery(query, schema, db, namespace);
  }

  if (!store) {
    throw new DatafnExecutionError(
      "INTERNAL",
      `DataStore is required for ${strategy} strategy but was not provided`,
      "$",
    );
  }

  return executeQuery(query, schema, store);
}

export function mergeSharedWithMeRows(
  perNamespaceRows: Array<{ namespace: string; data: Record<string, unknown>[] }>,
  query: Pick<DFQLQuery, "sort" | "limit" | "offset" | "count">,
): QueryResult {
  const merged: Record<string, unknown>[] = [];
  for (const entry of perNamespaceRows) {
    for (const record of entry.data) {
      merged.push({
        ...record,
        __ns:
          typeof record.__ns === "string" && record.__ns.length > 0
            ? record.__ns
            : entry.namespace,
      });
    }
  }

  let sorted: Record<string, unknown>[];
  if (query.sort && query.sort.length > 0) {
    sorted = sortRecords(merged, parseSortTerms(query.sort));
  } else {
    sorted = [...merged].sort((a, b) => {
      const nsA = typeof a.__ns === "string" ? a.__ns : "";
      const nsB = typeof b.__ns === "string" ? b.__ns : "";
      const nsCompare = nsA.localeCompare(nsB);
      if (nsCompare !== 0) {
        return nsCompare;
      }
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
  }

  const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
  const slicedByOffset = offset > 0 ? sorted.slice(offset) : sorted;
  const limited =
    typeof query.limit === "number" ? slicedByOffset.slice(0, query.limit) : slicedByOffset;

  return {
    data: limited,
    nextCursor: null,
    ...(query.count === true ? { count: sorted.length } : {}),
  };
}
