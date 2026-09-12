import type { Adapter } from "@superfunctions/db";
import {
  ANCESTOR_INACTIVE_FIELD,
  getAncestorInactiveResources,
  type DatafnSchema,
} from "@datafn/core";
import type { DatafnLogger } from "../../logger.js";
import { resolveAuthoritativeAncestorInactive } from "./ancestor-state.js";

const DEFAULT_BATCH_SIZE = 500;

/** Locale-independent ordering so persisted cursors resume identically on any host. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Resumable position within a namespace sweep. */
export interface AncestorInactiveCursor {
  resource: string;
  afterId: string | null;
}

export interface RecomputeAncestorInactiveOptions {
  namespace: string;
  batchSize?: number;
  /** Maximum ancestor nodes visited per row; exceeding the bound fails explicitly. */
  maxGraphNodes?: number;
  cursor?: AncestorInactiveCursor | null;
  dryRun?: boolean;
  logger?: DatafnLogger;
}

export interface RecomputeAncestorInactiveResult {
  scanned: number;
  updated: number;
  /** Mismatches not written because their compare-and-set lost a race. */
  skipped: number;
  /** Null once every dependent resource in the namespace has been visited. */
  nextCursor: AncestorInactiveCursor | null;
}

/**
 * Ordered list of resources that own the runtime-maintained
 * `isAncestorInactive` field for `schema`.
 */
export function ancestorInactiveResources(schema: DatafnSchema): string[] {
  return [...getAncestorInactiveResources(schema.relations)].sort(compareCodePoints);
}

/**
 * Recomputes `isAncestorInactive` for one batch of records in `namespace`,
 * resolving each record against the current state of its parents. Rows are
 * visited in ascending id order per resource so the sweep is deterministic and
 * resumable via `nextCursor`. Ancestor flags are derived from primary state,
 * with bounded traversal and explicit cycle/malformed-link errors. Quiesce
 * ancestor/link mutations during repair; compare-and-set guards only the
 * derived value on each row, not an atomic snapshot of the entire graph.
 */
export async function recomputeAncestorInactive(
  adapter: Adapter,
  schema: DatafnSchema,
  options: RecomputeAncestorInactiveOptions,
): Promise<RecomputeAncestorInactiveResult> {
  const { namespace, dryRun = false, logger } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxGraphNodes = options.maxGraphNodes ?? 10000;
  for (const value of [batchSize, maxGraphNodes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Ancestor repair: limits must be positive safe integers");
  }
  const resources = ancestorInactiveResources(schema);
  if (resources.length === 0) return { scanned: 0, updated: 0, skipped: 0, nextCursor: null };

  let cursor: AncestorInactiveCursor = options.cursor ?? { resource: resources[0]!, afterId: null };
  let resourceIndex = resources.indexOf(cursor.resource);
  if (resourceIndex === -1) {
    throw new Error(`recomputeAncestorInactive: unknown cursor resource "${cursor.resource}"`);
  }

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let remaining = batchSize;

  while (remaining > 0) {
    const resource = resources[resourceIndex]!;
    const requested = remaining;
    const rows = await adapter.findMany<Record<string, unknown>>({
      model: resource,
      where: cursor.afterId === null
        ? []
        : [{ field: "id", operator: "gt", value: cursor.afterId }],
      orderBy: [{ field: "id", direction: "asc" }],
      limit: requested,
      namespace,
    });

    for (const row of rows) {
      const id = row.id;
      if (typeof id !== "string" || id.length === 0) throw new Error("Ancestor repair: malformed record identifier");
      scanned += 1;
      const next = await resolveAuthoritativeAncestorInactive(adapter, schema, resource, row, namespace, maxGraphNodes);
      const previous = row[ANCESTOR_INACTIVE_FIELD];
      if (previous !== next) {
        if (dryRun) {
          updated += 1;
        } else {
          const affected = await adapter.updateMany({
            model: resource,
            where: [
              { field: "id", operator: "eq", value: id },
              {
                field: ANCESTOR_INACTIVE_FIELD,
                operator: "eq",
                value: previous ?? null,
              },
            ],
            data: { [ANCESTOR_INACTIVE_FIELD]: next },
            namespace,
          });
          updated += affected > 0 ? 1 : 0;
          skipped += affected > 0 ? 0 : 1;
        }
      }
      cursor = { resource, afterId: id };
    }
    remaining -= rows.length;

    if (rows.length < requested) {
      resourceIndex += 1;
      if (resourceIndex >= resources.length) {
        logger?.info("datafn.ancestorInactive.recompute.complete", { namespace, scanned, updated, skipped, dryRun });
        return { scanned, updated, skipped, nextCursor: null };
      }
      cursor = { resource: resources[resourceIndex]!, afterId: null };
    }
  }

  return { scanned, updated, skipped, nextCursor: cursor };
}

export interface RecomputeAncestorInactiveAllResult {
  scanned: number;
  updated: number;
  /** Mismatches not written because their compare-and-set lost a race. */
  skipped: number;
  sweeps: number;
  /** False when `maxSweeps` was reached while the last sweep changed or skipped rows. */
  converged: boolean;
}

/**
 * Runs full namespace sweeps of {@link recomputeAncestorInactive} until a
 * sweep produces no updates or skipped writes, verifying the prior sweep.
 * Bounded by `maxSweeps`; check `converged`
 * and rerun if it is false. Dry runs perform a single sweep.
 */
export async function recomputeAncestorInactiveAll(
  adapter: Adapter,
  schema: DatafnSchema,
  options: Omit<RecomputeAncestorInactiveOptions, "cursor"> & { maxSweeps?: number },
): Promise<RecomputeAncestorInactiveAllResult> {
  const maxSweeps = options.maxSweeps ?? 32;
  if (!Number.isSafeInteger(maxSweeps) || maxSweeps < 1) throw new Error("Ancestor repair: maxSweeps must be a positive safe integer");
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let sweeps = 0;
  let converged = false;
  while (sweeps < maxSweeps) {
    sweeps += 1;
    let sweepUpdated = 0;
    let sweepSkipped = 0;
    let cursor: AncestorInactiveCursor | null = null;
    do {
      const result = await recomputeAncestorInactive(adapter, schema, { ...options, cursor });
      scanned += result.scanned;
      sweepUpdated += result.updated;
      sweepSkipped += result.skipped;
      cursor = result.nextCursor;
    } while (cursor !== null);
    updated += sweepUpdated;
    skipped += sweepSkipped;
    if (sweepUpdated === 0 && sweepSkipped === 0) {
      converged = true;
      break;
    }
    if (options.dryRun) break;
  }
  if (!converged) {
    options.logger?.warn("datafn.ancestorInactive.recompute.notConverged", {
      namespace: options.namespace,
      sweeps,
      updated,
      skipped,
      dryRun: options.dryRun === true,
    });
  }
  return { scanned, updated, skipped, sweeps, converged };
}
