/**
 * Pull implementation - incremental updates since cursor using change tracking
 */

import type { DatafnErrorCode, DatafnSchema } from "../../core-types.js";
import type { Adapter } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService, type ChangeEntry } from "./change-tracking.js";
import { isPrivateShareableResource, resolveAccessLevel } from "../../validation/authz.js";
import {
  canonicalizeActorPrincipal,
  resolveEffectivePrincipals,
} from "../auth/principal-resolver.js";

const GLOBAL_PERMISSIONS_RESOURCE = "__datafn_permissions_global";
const PRINCIPAL_MEMBERSHIPS_RESOURCE = "__datafn_principal_memberships";
const PRINCIPAL_HIERARCHY_RESOURCE = "__datafn_principal_hierarchy";
const ACTOR_FEED_CURSOR_KEY = "__datafn_actor_feed__";

const ACTOR_FEED_RESOURCES = [
  GLOBAL_PERMISSIONS_RESOURCE,
  PRINCIPAL_MEMBERSHIPS_RESOURCE,
  PRINCIPAL_HIERARCHY_RESOURCE,
] as const;

export interface ActorFeedEntry {
  serverSeq: number;
  type:
    | "permission_granted"
    | "permission_revoked"
    | "membership_added"
    | "membership_removed"
    | "hierarchy_changed";
  principalId?: string;
  resourceType?: string;
  resourceId?: string | null;
}

// Global-cursor pull (TV-SYNC-004)
export interface PullRequestGlobalCursor {
  clientId: string;
  cursor: string;
  limit?: number;
  actorId?: string;
}

export interface PullResultGlobalCursor {
  ok: boolean;
  changes: Array<{
    serverSeq: number;
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
    reason?: "revoked" | "grant_backfill";
  }>;
  nextCursor: string | null;
  actorFeed?: ActorFeedEntry[];
  error?: {
    code: DatafnErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Canonical per-table cursor pull (TV-SYNC-003)
export interface PullRequestCanonical {
  clientId: string;
  cursors: Record<string, string>;
  limit?: number;
  includeJoins?: boolean;
  actorId?: string;
}

export interface PullResultCanonical {
  ok: boolean;
  records: Record<string, Array<Record<string, unknown>>>;
  merged?: Record<string, Array<Record<string, unknown>>>; // partial records applied via mergeRecord (FIX-A)
  deleted: Record<string, string[]>;
  joins?: Record<string, {
    upsert: Array<Record<string, unknown>>;
    delete: Array<{ from: string; to: string }>;
  }>;
  cursors: Record<string, string>;
  actorFeed?: ActorFeedEntry[];
  hasMore?: boolean; // CLIENT-PULL-001: true when changes were truncated
  error?: {
    code: DatafnErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Union type for request detection
export type PullRequest = PullRequestGlobalCursor | PullRequestCanonical;
export type PullResult = PullResultGlobalCursor | PullResultCanonical;

type PermissionGrantRecord = {
  resourceType: string;
  resourceNs: string;
  resourceId: string | null;
  principalId: string;
  level: string;
  grantKind?: string;
  revokedAt?: number | null;
};

type MembershipRecord = {
  actorId: string;
  principalId: string;
  revokedAt?: number | null;
};

type VisibilityChange = {
  serverSeq: number;
  resource: string;
  id: string;
  op: "upsert" | "delete";
  record: Record<string, unknown> | null;
  reason: "revoked" | "grant_backfill";
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isGrantActive(row: Record<string, unknown>): boolean {
  return row.revokedAt === undefined || row.revokedAt === null;
}

function isGlobalCursorPull(request: PullRequest): request is PullRequestGlobalCursor {
  return "cursor" in request && typeof (request as PullRequestGlobalCursor).cursor === "string";
}

function isFeedResource(resource: string): boolean {
  return ACTOR_FEED_RESOURCES.includes(resource as (typeof ACTOR_FEED_RESOURCES)[number]);
}

function isDataResourceKey(resource: string): boolean {
  return !resource.startsWith("join_") && !resource.startsWith("__datafn_");
}

function validateCursor(cursor: string): boolean {
  return /^\d+$/.test(cursor);
}

function parsePermissionGrantRecord(value: unknown): PermissionGrantRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const resourceType = normalizeNonEmptyString(row.resourceType);
  const resourceNs = normalizeNonEmptyString(row.resourceNs);
  const principalId = normalizeNonEmptyString(row.principalId);
  const level = normalizeNonEmptyString(row.level);
  if (!resourceType || !resourceNs || !principalId || !level) {
    return null;
  }
  const resourceId = row.resourceId === null
    ? null
    : normalizeNonEmptyString(row.resourceId);
  if (row.resourceId !== null && !resourceId) {
    return null;
  }
  return {
    resourceType,
    resourceNs,
    resourceId,
    principalId,
    level,
    grantKind: normalizeNonEmptyString(row.grantKind) ?? undefined,
    revokedAt: typeof row.revokedAt === "number" ? row.revokedAt : null,
  };
}

function parseMembershipRecord(value: unknown): MembershipRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const actorId = normalizeNonEmptyString(row.actorId);
  const principalId = normalizeNonEmptyString(row.principalId);
  if (!actorId || !principalId) {
    return null;
  }
  return {
    actorId,
    principalId,
    revokedAt: typeof row.revokedAt === "number" ? row.revokedAt : null,
  };
}

async function resolveActorPrincipals(
  db: Adapter,
  namespace: string,
  actorId: string,
): Promise<string[]> {
  const resolved = await resolveEffectivePrincipals({
    namespace,
    actorId,
    store: {
      getDirectMemberships: async ({ namespace: actorNs, actorId: actor }) => {
        const rows = await db.findMany({
          model: PRINCIPAL_MEMBERSHIPS_RESOURCE,
          where: [{ field: "actorId", operator: "eq", value: actor }],
          namespace: actorNs,
        });
        return rows
          .map((row) => row as Record<string, unknown>)
          .filter((row) => isGrantActive(row))
          .map((row) => normalizeNonEmptyString(row.principalId))
          .filter((value): value is string => value !== null);
      },
      getHierarchyParents: async ({ namespace: actorNs, principalIds }) => {
        const edges: Array<{ principalId: string; parentPrincipalId: string }> = [];
        for (const principalId of principalIds) {
          const rows = await db.findMany({
            model: PRINCIPAL_HIERARCHY_RESOURCE,
            where: [{ field: "principalId", operator: "eq", value: principalId }],
            namespace: actorNs,
          });
          for (const row of rows) {
            const edge = row as Record<string, unknown>;
            if (!isGrantActive(edge)) {
              continue;
            }
            const p = normalizeNonEmptyString(edge.principalId);
            const parent = normalizeNonEmptyString(edge.parentPrincipalId);
            if (p && parent) {
              edges.push({ principalId: p, parentPrincipalId: parent });
            }
          }
        }
        return edges;
      },
    },
  });
  return resolved.effectivePrincipals;
}

async function hasActorRecordAccess(
  db: Adapter,
  schema: DatafnSchema,
  resource: string,
  recordId: string,
  actorId: string | undefined,
  namespace: string,
): Promise<boolean> {
  if (!isPrivateShareableResource(schema, resource)) {
    return true;
  }
  if (!actorId) {
    return false;
  }
  const level = await resolveAccessLevel(
    db,
    schema,
    resource,
    recordId,
    actorId,
    namespace,
  );
  return !!level;
}

async function materializeGrantBackfill(
  db: Adapter,
  schema: DatafnSchema,
  actorId: string,
  grant: PermissionGrantRecord,
  requestedResources: Set<string> | null,
  serverSeq: number,
): Promise<VisibilityChange[]> {
  if (requestedResources && !requestedResources.has(grant.resourceType)) {
    return [];
  }

  const out: VisibilityChange[] = [];
  const grantNamespace = grant.resourceNs;

  if (grant.resourceId) {
    const record = await db.findOne({
      model: grant.resourceType,
      where: [{ field: "id", operator: "eq", value: grant.resourceId }],
      namespace: grantNamespace,
    });
    if (record && await hasActorRecordAccess(db, schema, grant.resourceType, grant.resourceId, actorId, grantNamespace)) {
      out.push({
        serverSeq,
        resource: grant.resourceType,
        id: grant.resourceId,
        op: "upsert",
        record: record as Record<string, unknown>,
        reason: "grant_backfill",
      });
    }
    return out;
  }

  const rows = await db.findMany({
    model: grant.resourceType,
    where: [],
    orderBy: [{ field: "id", direction: "asc" }],
    namespace: grantNamespace,
  });

  for (const row of rows) {
    const recordId = normalizeNonEmptyString(row.id);
    if (!recordId) {
      continue;
    }
    if (!await hasActorRecordAccess(db, schema, grant.resourceType, recordId, actorId, grantNamespace)) {
      continue;
    }
    out.push({
      serverSeq,
      resource: grant.resourceType,
      id: recordId,
      op: "upsert",
      record: row as Record<string, unknown>,
      reason: "grant_backfill",
    });
  }

  return out;
}

async function materializeRevokeTombstones(
  db: Adapter,
  schema: DatafnSchema,
  actorId: string,
  grant: PermissionGrantRecord,
  requestedResources: Set<string> | null,
  serverSeq: number,
): Promise<VisibilityChange[]> {
  if (requestedResources && !requestedResources.has(grant.resourceType)) {
    return [];
  }

  const out: VisibilityChange[] = [];
  const grantNamespace = grant.resourceNs;

  if (grant.resourceId) {
    const stillVisible = await hasActorRecordAccess(
      db,
      schema,
      grant.resourceType,
      grant.resourceId,
      actorId,
      grantNamespace,
    );
    if (!stillVisible) {
      out.push({
        serverSeq,
        resource: grant.resourceType,
        id: grant.resourceId,
        op: "delete",
        record: null,
        reason: "revoked",
      });
    }
    return out;
  }

  const rows = await db.findMany({
    model: grant.resourceType,
    where: [],
    orderBy: [{ field: "id", direction: "asc" }],
    namespace: grantNamespace,
  });

  for (const row of rows) {
    const recordId = normalizeNonEmptyString(row.id);
    if (!recordId) {
      continue;
    }
    const stillVisible = await hasActorRecordAccess(
      db,
      schema,
      grant.resourceType,
      recordId,
      actorId,
      grantNamespace,
    );
    if (!stillVisible) {
      out.push({
        serverSeq,
        resource: grant.resourceType,
        id: recordId,
        op: "delete",
        record: null,
        reason: "revoked",
      });
    }
  }

  return out;
}

async function getPermissionRecordForDelete(
  changeTracking: ChangeTrackingService,
  change: ChangeEntry,
): Promise<PermissionGrantRecord | null> {
  const prior = await changeTracking.getLatestChangeForRecord({
    resource: GLOBAL_PERMISSIONS_RESOURCE,
    id: change.id,
    atOrBeforeSeq: change.serverSeq - 1,
  });
  if (!prior) {
    return null;
  }
  return parsePermissionGrantRecord(prior.record);
}

async function getMembershipRecordForDelete(
  changeTracking: ChangeTrackingService,
  change: ChangeEntry,
): Promise<MembershipRecord | null> {
  const prior = await changeTracking.getLatestChangeForRecord({
    resource: PRINCIPAL_MEMBERSHIPS_RESOURCE,
    id: change.id,
    atOrBeforeSeq: change.serverSeq - 1,
  });
  if (!prior) {
    return null;
  }
  return parseMembershipRecord(prior.record);
}

async function listActivePrincipalGrants(
  db: Adapter,
  namespace: string,
  principalId: string,
): Promise<PermissionGrantRecord[]> {
  const rows = await db.findMany({
    model: GLOBAL_PERMISSIONS_RESOURCE,
    where: [{ field: "principalId", operator: "eq", value: principalId }],
    namespace,
  });
  return rows
    .map((row) => parsePermissionGrantRecord(row))
    .filter((grant): grant is PermissionGrantRecord => !!grant)
    .filter((grant) => grant.revokedAt === null || grant.revokedAt === undefined);
}

function finalizeVisibilityChanges(changes: VisibilityChange[]): VisibilityChange[] {
  const sorted = [...changes].sort((a, b) => {
    if (a.serverSeq !== b.serverSeq) {
      return a.serverSeq - b.serverSeq;
    }
    const resourceCmp = a.resource.localeCompare(b.resource);
    if (resourceCmp !== 0) {
      return resourceCmp;
    }
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) {
      return idCmp;
    }
    // Apply upsert before delete so delete deterministically wins on exact tie
    if (a.op === b.op) {
      return 0;
    }
    return a.op === "upsert" ? -1 : 1;
  });

  const deduped = new Map<string, VisibilityChange>();
  for (const change of sorted) {
    deduped.set(`${change.resource}:${change.id}`, change);
  }

  return Array.from(deduped.values()).sort((a, b) => {
    if (a.serverSeq !== b.serverSeq) {
      return a.serverSeq - b.serverSeq;
    }
    const resourceCmp = a.resource.localeCompare(b.resource);
    if (resourceCmp !== 0) {
      return resourceCmp;
    }
    return a.id.localeCompare(b.id);
  });
}

async function buildActorFeedEffects(params: {
  actorId: string;
  schema: DatafnSchema;
  db: Adapter;
  namespace: string;
  changeTracking: ChangeTrackingService;
  feedChanges: ChangeEntry[];
  requestedResources: Set<string> | null;
}): Promise<{
  actorFeed: ActorFeedEntry[];
  visibilityChanges: VisibilityChange[];
  latestFeedSeq: number;
}> {
  const actorPrincipal = canonicalizeActorPrincipal(params.actorId);
  const currentPrincipals = new Set(
    await resolveActorPrincipals(params.db, params.namespace, params.actorId),
  );
  currentPrincipals.add(actorPrincipal);

  const actorFeed: ActorFeedEntry[] = [];
  const visibilityChanges: VisibilityChange[] = [];
  const actorMembershipPrincipals = new Set<string>();
  let latestFeedSeq = 0;

  const orderedFeed = [...params.feedChanges].sort(
    (a, b) => a.serverSeq - b.serverSeq,
  );

  for (const change of orderedFeed) {
    latestFeedSeq = Math.max(latestFeedSeq, change.serverSeq);

    if (change.resource === GLOBAL_PERMISSIONS_RESOURCE) {
      const permission = change.record
        ? parsePermissionGrantRecord(change.record)
        : await getPermissionRecordForDelete(params.changeTracking, change);
      if (!permission) {
        continue;
      }

      const relevantPrincipal =
        permission.principalId === actorPrincipal ||
        currentPrincipals.has(permission.principalId) ||
        actorMembershipPrincipals.has(permission.principalId);
      if (!relevantPrincipal) {
        continue;
      }

      actorFeed.push({
        serverSeq: change.serverSeq,
        type: change.op === "delete" ? "permission_revoked" : "permission_granted",
        principalId: permission.principalId,
        resourceType: permission.resourceType,
        resourceId: permission.resourceId,
      });

      if (change.op === "delete") {
        visibilityChanges.push(
          ...(await materializeRevokeTombstones(
            params.db,
            params.schema,
            params.actorId,
            permission,
            params.requestedResources,
            change.serverSeq,
          )),
        );
      } else {
        visibilityChanges.push(
          ...(await materializeGrantBackfill(
            params.db,
            params.schema,
            params.actorId,
            permission,
            params.requestedResources,
            change.serverSeq,
          )),
        );
      }
      continue;
    }

    if (change.resource === PRINCIPAL_MEMBERSHIPS_RESOURCE) {
      const membership = change.record
        ? parseMembershipRecord(change.record)
        : await getMembershipRecordForDelete(params.changeTracking, change);
      if (!membership || membership.actorId !== params.actorId) {
        continue;
      }

      actorMembershipPrincipals.add(membership.principalId);
      actorFeed.push({
        serverSeq: change.serverSeq,
        type: change.op === "delete" ? "membership_removed" : "membership_added",
        principalId: membership.principalId,
      });

      const grants = await listActivePrincipalGrants(
        params.db,
        params.namespace,
        membership.principalId,
      );

      for (const grant of grants) {
        if (change.op === "delete") {
          visibilityChanges.push(
            ...(await materializeRevokeTombstones(
              params.db,
              params.schema,
              params.actorId,
              grant,
              params.requestedResources,
              change.serverSeq,
            )),
          );
        } else {
          visibilityChanges.push(
            ...(await materializeGrantBackfill(
              params.db,
              params.schema,
              params.actorId,
              grant,
              params.requestedResources,
              change.serverSeq,
            )),
          );
        }
      }
      continue;
    }

    if (change.resource === PRINCIPAL_HIERARCHY_RESOURCE) {
      const row = (change.record ?? {}) as Record<string, unknown>;
      const principalId = normalizeNonEmptyString(row.principalId);
      const parentPrincipalId = normalizeNonEmptyString(row.parentPrincipalId);
      if (
        !principalId ||
        !parentPrincipalId ||
        (!currentPrincipals.has(principalId) && !currentPrincipals.has(parentPrincipalId))
      ) {
        continue;
      }

      actorFeed.push({
        serverSeq: change.serverSeq,
        type: "hierarchy_changed",
        principalId,
      });
    }
  }

  return {
    actorFeed,
    visibilityChanges: finalizeVisibilityChanges(visibilityChanges),
    latestFeedSeq,
  };
}

function compareCanonicalChangeEntries(
  a: { resource: string; change: ChangeEntry },
  b: { resource: string; change: ChangeEntry },
): number {
  if (a.change.serverSeq !== b.change.serverSeq) {
    return a.change.serverSeq - b.change.serverSeq;
  }
  const resourceCmp = a.resource.localeCompare(b.resource);
  if (resourceCmp !== 0) {
    return resourceCmp;
  }
  return a.change.id.localeCompare(b.change.id);
}

/**
 * PERF-002: Deterministic bounded k-way merge for canonical pull windows.
 * Avoids materializing a globally flattened/sorted array.
 */
export function mergeCanonicalChangeStreamsBounded(
  streams: Array<{ resource: string; changes: ChangeEntry[] }>,
  limit: number,
): {
  merged: Array<{ resource: string; change: ChangeEntry }>;
  latestCursorPerResource: Record<string, number>;
  hasMore: boolean;
  peakWindow: number;
} {
  const heads = streams
    .filter((stream) => stream.changes.length > 0)
    .map((stream) => ({ resource: stream.resource, changes: stream.changes, index: 0 }));

  const merged: Array<{ resource: string; change: ChangeEntry }> = [];
  const latestCursorPerResource: Record<string, number> = Object.create(null);
  let peakWindow = heads.length;

  while (heads.length > 0 && merged.length < limit) {
    let bestIdx = 0;
    for (let idx = 1; idx < heads.length; idx++) {
      const candidate = {
        resource: heads[idx].resource,
        change: heads[idx].changes[heads[idx].index],
      };
      const best = {
        resource: heads[bestIdx].resource,
        change: heads[bestIdx].changes[heads[bestIdx].index],
      };
      if (compareCanonicalChangeEntries(candidate, best) < 0) {
        bestIdx = idx;
      }
    }

    const selected = heads[bestIdx];
    const change = selected.changes[selected.index];
    merged.push({ resource: selected.resource, change });
    latestCursorPerResource[selected.resource] = Math.max(
      latestCursorPerResource[selected.resource] || 0,
      change.serverSeq,
    );

    selected.index += 1;
    if (selected.index >= selected.changes.length) {
      heads.splice(bestIdx, 1);
    }
    peakWindow = Math.max(peakWindow, heads.length + merged.length);
  }

  return {
    merged,
    latestCursorPerResource,
    hasMore: heads.length > 0,
    peakWindow,
  };
}

export async function executePull(
  request: PullRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxPullLimit?: number,
): Promise<PullResult> {
  // Validate clientId (common to both protocols)
  if (!request.clientId || typeof request.clientId !== "string") {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: clientId must be string",
        details: { path: "clientId" },
      },
    } as PullResultGlobalCursor;
  }

  if (isGlobalCursorPull(request)) {
    return executePullGlobalCursor(request, schema, db, namespace, sequenceStore);
  }
  return executePullCanonical(
    request as PullRequestCanonical,
    schema,
    db,
    namespace,
    sequenceStore,
    maxPullLimit,
  );
}

async function executePullGlobalCursor(
  request: PullRequestGlobalCursor,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
): Promise<PullResultGlobalCursor> {
  if (typeof request.cursor !== "string" || !validateCursor(request.cursor)) {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: cursor must be an integer string",
        details: { path: "cursor" },
      },
    };
  }

  const limit = request.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: limit must be a positive integer",
        details: { path: "limit" },
      },
    };
  }

  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);
  const sinceSeq = parseInt(request.cursor, 10);
  const rawChanges = await changeTracking.getGlobalChanges({
    sinceSeq,
    limit,
  });

  const actorId = normalizeNonEmptyString((request as { actorId?: string }).actorId) ?? undefined;

  const visibleChanges: Array<{
    serverSeq: number;
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
    reason?: "revoked" | "grant_backfill";
  }> = [];

  const feedChanges: ChangeEntry[] = [];
  for (const change of rawChanges) {
    if (isFeedResource(change.resource)) {
      feedChanges.push(change);
      continue;
    }

    if (
      isDataResourceKey(change.resource) &&
      isPrivateShareableResource(schema, change.resource)
    ) {
      if (!actorId) {
        continue;
      }
      if (change.op === "delete") {
        // keep deletes for private resources to clear stale local state deterministically
        visibleChanges.push({
          serverSeq: change.serverSeq,
          resource: change.resource,
          id: change.id,
          op: "delete",
          record: null,
        });
        continue;
      }
      const visible = await hasActorRecordAccess(
        db,
        schema,
        change.resource,
        change.id,
        actorId,
        namespace,
      );
      if (!visible) {
        continue;
      }
    }

    visibleChanges.push({
      serverSeq: change.serverSeq,
      resource: change.resource,
      id: change.id,
      op: change.op === "delete" ? "delete" : "upsert",
      record: change.op === "delete" ? null : change.record,
    });
  }

  let actorFeed: ActorFeedEntry[] | undefined;
  if (actorId) {
    const feedEffects = await buildActorFeedEffects({
      actorId,
      schema,
      db,
      namespace,
      changeTracking,
      feedChanges,
      requestedResources: null,
    });
    if (feedEffects.actorFeed.length > 0) {
      actorFeed = feedEffects.actorFeed;
    }
    for (const synthetic of feedEffects.visibilityChanges) {
      visibleChanges.push({
        serverSeq: synthetic.serverSeq,
        resource: synthetic.resource,
        id: synthetic.id,
        op: synthetic.op,
        record: synthetic.record,
        reason: synthetic.reason,
      });
    }
  }

  visibleChanges.sort((a, b) => {
    if (a.serverSeq !== b.serverSeq) {
      return a.serverSeq - b.serverSeq;
    }
    const resourceCmp = a.resource.localeCompare(b.resource);
    if (resourceCmp !== 0) {
      return resourceCmp;
    }
    return a.id.localeCompare(b.id);
  });

  let nextCursor: string | null = null;
  if (rawChanges.length > 0) {
    nextCursor = String(rawChanges[rawChanges.length - 1].serverSeq);
  }

  return {
    ok: true,
    changes: visibleChanges,
    nextCursor,
    actorFeed,
  };
}

async function executePullCanonical(
  request: PullRequestCanonical,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxPullLimit?: number,
): Promise<PullResultCanonical> {
  if (!request.cursors || typeof request.cursors !== "object") {
    return {
      ok: false,
      records: {},
      deleted: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: cursors must be an object",
        details: { path: "cursors" },
      },
    };
  }

  for (const [resource, cursor] of Object.entries(request.cursors)) {
    if (typeof cursor !== "string" || !validateCursor(cursor)) {
      return {
        ok: false,
        records: {},
        deleted: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: "Invalid DFQL: cursor must be an integer string",
          details: { path: `cursors.${resource}` },
        },
      };
    }
  }

  const requestLimit = request.limit ?? 200;
  if (!Number.isInteger(requestLimit) || requestLimit <= 0) {
    return {
      ok: false,
      records: {},
      deleted: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: limit must be a positive integer",
        details: { path: "limit" },
      },
    };
  }

  const effectiveMaxPullLimit = maxPullLimit && maxPullLimit > 0 ? maxPullLimit : 1000;
  const limit = Math.min(requestLimit, effectiveMaxPullLimit);

  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);
  const actorId = normalizeNonEmptyString((request as { actorId?: string }).actorId) ?? undefined;

  const requestedResourceKeys = Object.keys(request.cursors).filter(
    (resource) => resource !== ACTOR_FEED_CURSOR_KEY,
  );

  const records: Record<string, Array<Record<string, unknown>>> = Object.create(null);
  const merged: Record<string, Array<Record<string, unknown>>> = Object.create(null);
  const deleted: Record<string, string[]> = Object.create(null);
  const joins: Record<string, { upsert: Array<Record<string, unknown>>; delete: Array<{ from: string; to: string }> }> = Object.create(null);
  const cursors: Record<string, string> = Object.create(null);

  for (const resource of requestedResourceKeys) {
    if (!resource.startsWith("join_") && !resource.startsWith("__datafn_")) {
      records[resource] = [];
      deleted[resource] = [];
    }
    cursors[resource] = request.cursors[resource];
  }
  if (request.cursors[ACTOR_FEED_CURSOR_KEY] !== undefined) {
    cursors[ACTOR_FEED_CURSOR_KEY] = request.cursors[ACTOR_FEED_CURSOR_KEY];
  }

  const resourceEntries = requestedResourceKeys.filter(
    (resource) => resource !== ACTOR_FEED_CURSOR_KEY,
  ).map((resource) => [resource, request.cursors[resource]] as const);

  const allResourceChanges = await Promise.all(
    resourceEntries.map(async ([resource, cursor]) => {
      const sinceSeq = parseInt(cursor, 10);
      const changes = await changeTracking.getChangesSince({
        resource,
        sinceSeq,
        limit: limit + 1,
      });
      return { resource, changes };
    }),
  );
  const {
    merged: limitedChanges,
    latestCursorPerResource,
    hasMore: baseHasMore,
  } = mergeCanonicalChangeStreamsBounded(allResourceChanges, limit);

  for (const { resource, change } of limitedChanges) {
    if (resource.startsWith("join_")) {
      if (!joins[resource]) {
        joins[resource] = { upsert: [], delete: [] };
      }
      if ((change.op === "upsert" || change.op === "insert" || change.op === "replace") && change.record) {
        joins[resource].upsert.push(change.record);
      } else if (change.op === "delete") {
        const from = normalizeNonEmptyString((change.record as Record<string, unknown> | null)?.from)
          ?? change.id.split(":")[0];
        const to = normalizeNonEmptyString((change.record as Record<string, unknown> | null)?.to)
          ?? change.id.split(":")[1];
        joins[resource].delete.push({ from, to });
      }
      continue;
    }

    if (!isDataResourceKey(resource)) {
      continue;
    }

    const isPrivate = isPrivateShareableResource(schema, resource);
    if (isPrivate && !actorId) {
      continue;
    }

    if ((change.op === "merge") && change.record) {
      if (isPrivate) {
        const visible = await hasActorRecordAccess(
          db,
          schema,
          resource,
          change.id,
          actorId,
          namespace,
        );
        if (!visible) {
          continue;
        }
      }
      if (!merged[resource]) {
        merged[resource] = [];
      }
      merged[resource].push(change.record);
      continue;
    }

    if ((change.op === "insert" || change.op === "replace" || change.op === "upsert") && change.record) {
      if (isPrivate) {
        const visible = await hasActorRecordAccess(
          db,
          schema,
          resource,
          change.id,
          actorId,
          namespace,
        );
        if (!visible) {
          continue;
        }
      }
      records[resource].push(change.record);
      continue;
    }

    if (change.op === "delete") {
      deleted[resource].push(change.id);
    }
  }

  let actorFeed: ActorFeedEntry[] | undefined;
  let feedHasMore = false;
  if (actorId) {
    const requestedResources = new Set(
      requestedResourceKeys.filter((resource) => isDataResourceKey(resource)),
    );
    const actorFeedCursor = request.cursors[ACTOR_FEED_CURSOR_KEY]
      ?? Object.values(request.cursors).sort((a, b) => Number(a) - Number(b))[0]
      ?? "0";
    const feedChanges = await changeTracking.getChangesForResourcesSince({
      resources: [...ACTOR_FEED_RESOURCES],
      sinceSeq: parseInt(actorFeedCursor, 10),
      limit: limit + 1,
    });
    feedHasMore = feedChanges.length > limit;

    const feedEffects = await buildActorFeedEffects({
      actorId,
      schema,
      db,
      namespace,
      changeTracking,
      feedChanges: feedChanges.slice(0, limit),
      requestedResources,
    });

    if (feedEffects.actorFeed.length > 0) {
      actorFeed = feedEffects.actorFeed;
    }

    for (const synthetic of feedEffects.visibilityChanges) {
      if (!records[synthetic.resource]) {
        records[synthetic.resource] = [];
      }
      if (!deleted[synthetic.resource]) {
        deleted[synthetic.resource] = [];
      }
      if (synthetic.op === "upsert" && synthetic.record) {
        records[synthetic.resource].push(synthetic.record);
      } else if (synthetic.op === "delete") {
        deleted[synthetic.resource].push(synthetic.id);
      }
    }

    if (feedEffects.latestFeedSeq > 0) {
      cursors[ACTOR_FEED_CURSOR_KEY] = String(feedEffects.latestFeedSeq);
    }
  }

  for (const [resource, latestSeq] of Object.entries(latestCursorPerResource)) {
    cursors[resource] = String(latestSeq);
  }

  for (const resource of Object.keys(records)) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const record of records[resource]) {
      const id = normalizeNonEmptyString(record.id);
      if (!id) {
        continue;
      }
      byId.set(id, { ...record, id });
    }
    records[resource] = Array.from(byId.values()).sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );
  }

  for (const resource of Object.keys(merged)) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const record of merged[resource]) {
      const id = normalizeNonEmptyString(record.id);
      if (!id) {
        continue;
      }
      const existing = byId.get(id) ?? { id };
      byId.set(id, { ...existing, ...record, id });
    }
    merged[resource] = Array.from(byId.values()).sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );
  }

  for (const resource of Object.keys(deleted)) {
    deleted[resource] = Array.from(new Set(deleted[resource])).sort((a, b) =>
      a.localeCompare(b),
    );
  }

  for (const resource of Object.keys(joins)) {
    joins[resource].upsert.sort((a, b) =>
      String(a.id ?? `${a.from}:${a.to}`).localeCompare(
        String(b.id ?? `${b.from}:${b.to}`),
      ),
    );
    joins[resource].delete.sort((a, b) => {
      const aKey = `${a.from}:${a.to}`;
      const bKey = `${b.from}:${b.to}`;
      return aKey.localeCompare(bKey);
    });
  }

  const result: PullResultCanonical = {
    ok: true,
    records,
    deleted,
    cursors,
    hasMore: baseHasMore || feedHasMore,
  };

  if (Object.keys(merged).length > 0) {
    result.merged = merged;
  }

  if (request.includeJoins && Object.keys(joins).length > 0) {
    result.joins = joins;
  }

  if (actorFeed && actorFeed.length > 0) {
    result.actorFeed = actorFeed;
  }

  return result;
}
