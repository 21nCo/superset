import type { Adapter } from "@superfunctions/db";
import {
  ANCESTOR_INACTIVE_FIELD,
  getAncestorInactiveResources,
  type DatafnSchema,
} from "@datafn/core";
import type { DatafnLogger } from "../../logger.js";
import { resolveAncestorInactive } from "../mutation/relations.js";

const DEFAULT_BATCH_SIZE = 500;

/** Resumable position within a namespace sweep. */
export interface AncestorInactiveCursor {
  resource: string;
  afterId: string | null;
}

export interface RecomputeAncestorInactiveOptions {
  namespace: string;
  batchSize?: number;
  cursor?: AncestorInactiveCursor | null;
  dryRun?: boolean;
  logger?: DatafnLogger;
}

export interface RecomputeAncestorInactiveResult {
  scanned: number;
  updated: number;
  /** Null once every dependent resource in the namespace has been visited. */
  nextCursor: AncestorInactiveCursor | null;
}

/**
 * Ordered list of resources that own the runtime-maintained
 * `isAncestorInactive` field for `schema`.
 */
export function ancestorInactiveResources(schema: DatafnSchema): string[] {
  return [...getAncestorInactiveResources(schema.relations)].sort((a, b) => a.localeCompare(b));
}

/**
 * Recomputes `isAncestorInactive` for one batch of records in `namespace`,
 * resolving each record against the current state of its parents. Rows are
 * visited in ascending id order per resource so the sweep is deterministic and
 * resumable via `nextCursor`. Because a record is resolved from its parents'
 * stored values, deep hierarchies with stale intermediate rows may need more
 * than one full sweep to converge; use {@link recomputeAncestorInactiveAll}
 * for a converging run.
 */
export async function recomputeAncestorInactive(
  adapter: Adapter,
  schema: DatafnSchema,
  options: RecomputeAncestorInactiveOptions,
): Promise<RecomputeAncestorInactiveResult> {
  const { namespace, dryRun = false, logger } = options;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const resources = ancestorInactiveResources(schema);
  if (resources.length === 0) return { scanned: 0, updated: 0, nextCursor: null };

  let cursor: AncestorInactiveCursor = options.cursor ?? { resource: resources[0]!, afterId: null };
  let resourceIndex = resources.indexOf(cursor.resource);
  if (resourceIndex === -1) {
    throw new Error(`recomputeAncestorInactive: unknown cursor resource "${cursor.resource}"`);
  }

  let scanned = 0;
  let updated = 0;
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
      if (typeof id !== "string") continue;
      scanned += 1;
      const next = await resolveAncestorInactive(adapter, schema, resource, row, namespace);
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
        }
      }
      cursor = { resource, afterId: id };
    }
    remaining -= rows.length;

    if (rows.length < requested) {
      resourceIndex += 1;
      if (resourceIndex >= resources.length) {
        logger?.info("datafn.ancestorInactive.recompute.complete", { namespace, scanned, updated, dryRun });
        return { scanned, updated, nextCursor: null };
      }
      cursor = { resource: resources[resourceIndex]!, afterId: null };
    }
  }

  return { scanned, updated, nextCursor: cursor };
}

export interface RecomputeAncestorInactiveAllResult {
  scanned: number;
  updated: number;
  sweeps: number;
  /** False when `maxSweeps` was reached while the last sweep still changed rows. */
  converged: boolean;
}

/**
 * Runs full namespace sweeps of {@link recomputeAncestorInactive} until a
 * sweep produces no updates, so inherited inactivity converges through
 * arbitrarily deep hierarchies. Bounded by `maxSweeps`; check `converged`
 * and rerun if it is false. Dry runs perform a single sweep.
 */
export async function recomputeAncestorInactiveAll(
  adapter: Adapter,
  schema: DatafnSchema,
  options: Omit<RecomputeAncestorInactiveOptions, "cursor"> & { maxSweeps?: number },
): Promise<RecomputeAncestorInactiveAllResult> {
  const maxSweeps = Math.max(1, options.maxSweeps ?? 32);
  let scanned = 0;
  let updated = 0;
  let sweeps = 0;
  let converged = false;
  while (sweeps < maxSweeps) {
    sweeps += 1;
    let sweepUpdated = 0;
    let cursor: AncestorInactiveCursor | null = null;
    do {
      const result = await recomputeAncestorInactive(adapter, schema, { ...options, cursor });
      scanned += result.scanned;
      sweepUpdated += result.updated;
      cursor = result.nextCursor;
    } while (cursor !== null);
    updated += sweepUpdated;
    if (sweepUpdated === 0) {
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
      dryRun: options.dryRun === true,
    });
  }
  return { scanned, updated, sweeps, converged };
}
