/**
 * Push implementation - upload local mutations with change tracking
 */

import type { DatafnSchema } from "../../core-types.js";
import {
  coerceDateFieldsToEpoch,
  findSystemFieldWrite,
  normalizeRelationFkRecord,
  resolveCapabilities,
} from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import {
  isRetryableMutationResult,
  type IdempotencyStore,
  type MutationResult,
} from "../idempotency.js";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService, recordChangeWithRetry } from "./change-tracking.js";
import {
  applyInactivePropagation,
  applyRelationDeletePolicies,
  collectInactivePropagationSeeds,
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  extractJoinDeltas,
  extractJoinDeltasFromDB,
  extractRelationRecordDeltasFromDB,
} from "../mutation/relations.js";
import { executeSchemaAwareMerge } from "../mutation/merge-decision.js";
import { stripReadonlyCapabilityFields } from "../mutation/execute.js";
import {
  executeShare,
  executeUnshare,
  getFailedShareCompensation,
  getPermissionsTable,
  syncDatafnPermissionGrantAfterCommit,
} from "../mutation/share.js";
import type { DatafnLogger } from "../../logger.js";
import type { DatafnMultiRegionRuntimeConfig } from "../../plugins/multi-region.js";
import { validateShareableOperationAccess } from "../../validation/authz.js";
import {
  deferFailedShareCompensation,
  discardPermissionDirectorySync,
  drainPermissionDirectorySync,
  enqueuePermissionDirectorySync,
  enqueuePermissionDirectorySyncDurably,
  ensurePermissionDirectoryOutbox,
} from "../mutation/permission-directory-outbox.js";

export interface PushRequest {
  clientId: string;
  mutations: Array<Record<string, unknown>>;
}

export interface PushResult {
  ok: boolean;
  applied: string[]; // mutationIds that were applied
  errors: Array<{
    mutationId: string;
    code: string;
    message: string;
    path: string;
    retryable?: boolean;
  }>;
  cursor: string;
  cursorBefore?: string; // global seq before this push started; absent on early-exit error paths
  cursors?: Record<string, string>; // per-resource max serverSeq after this push
}

function formatUnknownError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error && error.cause ? `\ncause: ${formatUnknownError(error.cause)}` : "";
  return `${error.stack || error.message}${cause}`;
}

function applyDateCoercion(
  schema: DatafnSchema,
  resource: string,
  data: Record<string, unknown>,
  logger?: DatafnLogger,
): Record<string, unknown> {
  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef || !resourceDef.fields) {
    logger?.warn("Resource not found in schema — skipping date coercion", {
      operation: "applyDateCoercion",
      resource,
    });
    return data;
  }
  return coerceDateFieldsToEpoch({ ...data }, resourceDef.fields);
}

function hasSimpleCapability(
  resolvedCapabilities: unknown[],
  capability: "timestamps" | "audit" | "trash" | "archivable",
): boolean {
  return resolvedCapabilities.some((entry) => entry === capability);
}

function resolveCapabilitiesForResource(
  schema: DatafnSchema,
  resourceName: string,
): unknown[] {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) return [];
  return resolveCapabilities(schema.capabilities as any, resource.capabilities as any);
}

function injectCapabilityFieldsOnInsert(
  record: Record<string, unknown>,
  resolvedCapabilities: unknown[],
  actorId?: string,
): Record<string, unknown> {
  const next = { ...record };
  const now = Date.now();

  if (hasSimpleCapability(resolvedCapabilities, "timestamps")) {
    next.createdAt = now;
    next.updatedAt = now;
  }
  if (hasSimpleCapability(resolvedCapabilities, "audit")) {
    next.createdBy = actorId ?? null;
    next.updatedBy = actorId ?? null;
  }

  return next;
}

function injectCapabilityFieldsOnUpdate(
  record: Record<string, unknown>,
  resolvedCapabilities: unknown[],
  actorId?: string,
): Record<string, unknown> {
  const next = { ...record };

  if (hasSimpleCapability(resolvedCapabilities, "timestamps")) {
    next.updatedAt = Date.now();
  }
  if (hasSimpleCapability(resolvedCapabilities, "audit")) {
    next.updatedBy = actorId ?? null;
  }

  return next;
}

function isConflictError(error: unknown, seen = new WeakSet<object>()): boolean {
  const value = error as { cause?: unknown; code?: unknown; message?: unknown };
  if (value && typeof value === "object") {
    if (seen.has(value)) return false;
    seen.add(value);
  }
  const code = String(value?.code || "");
  const message = String(value?.message || "").toLowerCase();
  if (
    code === "23505" ||
    code === "UNIQUE_VIOLATION" ||
    code === "ER_DUP_ENTRY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    message.includes("unique") ||
    message.includes("duplicate") ||
    message.includes("already exists") ||
    message.includes("conflict")
  ) {
    return true;
  }
  return value?.cause ? isConflictError(value.cause, seen) : false;
}

function isNumberLikeString(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date) return valuesEqual(left.getTime(), right);
  if (right instanceof Date) return valuesEqual(left, right.getTime());
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "string" && isNumberLikeString(right)) {
    return left === Number(right);
  }
  if (typeof left === "string" && typeof right === "number" && isNumberLikeString(left)) {
    return Number(left) === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    const rightKeys = new Set(Object.keys(rightRecord));
    if (leftEntries.length !== rightKeys.size) return false;
    return leftEntries.every(([key, value]) => rightKeys.has(key) && valuesEqual(value, rightRecord[key]));
  }
  return false;
}

function providedFieldsMatchExisting(
  existing: Record<string, unknown>,
  provided: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(provided)) {
    if (value === undefined) continue;
    if (!providedValueMatchesExisting(existing[key], value)) return false;
  }
  return true;
}

function providedValueMatchesExisting(existingValue: unknown, providedValue: unknown): boolean {
  if (Array.isArray(existingValue) && Array.isArray(providedValue)) {
    if (providedValue.length <= existingValue.length) {
      return providedValue.every((item, index) => valuesEqual(existingValue[index], item));
    }
  }
  return valuesEqual(existingValue, providedValue);
}

function hasTrashCapability(resolvedCapabilities: unknown[]): boolean {
  return resolvedCapabilities.some((entry) => entry === "trash");
}

function hasArchivableCapability(resolvedCapabilities: unknown[]): boolean {
  return resolvedCapabilities.some((entry) => entry === "archivable");
}

/**
 * Execute push operation - apply mutations with change tracking
 */
export async function executePush(
  request: PushRequest,
  schema: DatafnSchema,
  db: Adapter,
  idempotencyStore: IdempotencyStore,
  namespace: string,
  sequenceStore?: SequenceStore,
  onChange?: (seq: number, namespace: string) => void,
  actorId?: string,
  logger?: DatafnLogger,
  multiRegionRuntime?: DatafnMultiRegionRuntimeConfig | null,
): Promise<PushResult> {
  // Validate clientId at request level - this is a critical error
  if (!request.clientId || typeof request.clientId !== "string") {
    // Return error structure that handler will convert to error response
    return {
      ok: false,
      applied: [],
      errors: [
        {
          mutationId: "",
          code: "DFQL_INVALID",
          message: "Invalid DFQL: clientId must be string",
          path: "clientId",
          retryable: false,
        },
      ],
      cursor: "0",
    };
  }

  // Validate all mutations have matching clientId (SERVER-SYNC-CLIENTID-001)
  for (let i = 0; i < request.mutations.length; i++) {
    const mutation = request.mutations[i] as any;
    if (mutation.clientId && mutation.clientId !== request.clientId) {
      return {
        ok: false,
        applied: [],
        errors: [
          {
            mutationId: mutation.mutationId || "",
            code: "DFQL_INVALID",
            message: `Invalid DFQL: push.mutations[${i}].clientId must equal request.clientId`,
            path: `mutations[${i}].clientId`,
            retryable: false,
          },
        ],
        cursor: "0",
      };
    }
  }

  const applied: string[] = [];
  const errors: Array<{
    mutationId: string;
    code: string;
    message: string;
    path: string;
    retryable?: boolean;
  }> = [];

  // Create change tracking service with user/tenant namespace and optional sequence store
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore, onChange);
  // Capture the global sequence counter BEFORE any mutations are processed so the client
  // can determine whether foreign changes exist (cursorBefore == localCursor → no foreign changes)
  const cursorBeforeSeq = await changeTracking.getCurrentServerSeq();
  let latestSeq = 0;
  // Track per-resource max serverSeq so the client can advance per-table cursors (FIX-B)
  const resourceSeqs: Record<string, number> = {};

  if (
    multiRegionRuntime &&
    request.mutations.some((mutation) =>
      mutation.operation === "share" || mutation.operation === "unshare"
    )
  ) {
    await ensurePermissionDirectoryOutbox(db);
  }

  // FIX-REL-011: Detect transaction support for atomic mutation units
  let hasTransaction =
    (db.capabilities?.transactions?.supported !== false) &&
    typeof db.transaction === "function";
  if (hasTransaction) {
    // Some adapters (notably drizzle+better-sqlite3) expose transaction support but
    // reject async callbacks. Probe once and downgrade to non-atomic mode when needed.
    try {
      await (db as any).transaction(() => Promise.resolve(undefined));
    } catch (error) {
      const txMsg = String((error as any)?.message || error).toLowerCase();
      if (
        txMsg.includes("cannot return a promise") ||
        txMsg.includes("not supported") ||
        txMsg.includes("not implemented")
      ) {
        hasTransaction = false;
      } else {
        throw error;
      }
    }
  }
  if (!hasTransaction) {
    logger?.warn("Push operating in non-atomic mode (adapter does not support transactions)", {
      operation: "push",
      namespace,
    });
  } else {
    await changeTracking.ensureReady();
  }

  type SequenceAllocationState = {
    initialBatchAllocated: boolean;
    pool: number[];
  };
  const sequenceAllocation: SequenceAllocationState = {
    initialBatchAllocated: false,
    pool: [],
  };
  async function takeNextServerSeq(
    allocation: SequenceAllocationState,
    targetChangeTracking = changeTracking,
  ): Promise<number> {
    if (allocation.pool.length === 0) {
      if (!allocation.initialBatchAllocated) {
        allocation.initialBatchAllocated = true;
        allocation.pool = await targetChangeTracking.getNextServerSeqBatch(
          Math.max(1, request.mutations.length),
        );
      } else {
        allocation.pool = await targetChangeTracking.getNextServerSeqBatch(1);
      }
    }
    return allocation.pool.shift()!;
  }

  // Pending change entries for a mutation that executed successfully
  type PendingChange = {
    resource: string;
    id: string;
    op: "insert" | "merge" | "replace" | "upsert" | "delete";
    record: Record<string, unknown> | null;
  };

  type ExecuteMutationResult =
    | { ok: true; changes: PendingChange[] }
    | { ok: false; code: string; message: string; path: string };

  async function collectPropagationChanges(
    targetDb: Adapter,
    seeds: Array<{ resource: string; id: string }>,
  ): Promise<PendingChange[]> {
    return (await applyInactivePropagation(targetDb, schema, seeds, namespace)).map((change) => ({
      resource: change.resource,
      id: change.id,
      op: change.op,
      record: change.record,
    }));
  }

  // Local dedup: track mutations processed in this batch (clientId:mutationId → ok)
  const batchLocalSeen = new Map<string, boolean>();

  /**
   * Execute a single push mutation's DB operation against a given adapter.
   */
  async function executeMutationOp(
    mut: any,
    targetDb: Adapter,
  ): Promise<ExecuteMutationResult> {
    const resolvedCapabilities = resolveCapabilitiesForResource(schema, mut.resource);
    if (
      (mut.operation === "insert" || mut.operation === "merge" || mut.operation === "replace") &&
      typeof mut.record === "object" &&
      mut.record !== null
    ) {
      const systemField = findSystemFieldWrite(schema.relations, mut.resource, mut.record);
      if (systemField) {
        return {
          ok: false,
          code: "DFQL_INVALID",
          message: `Field is read-only: ${systemField} on ${mut.resource}`,
          path: `record.${systemField}`,
        };
      }
    }
    switch (mut.operation) {
      case "insert": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        const normalizedData = normalizeRelationFkRecord(schema, mut.resource, coercedData);
        const strippedRecord = stripReadonlyCapabilityFields(normalizedData, resolvedCapabilities);
        const insertRecord = injectCapabilityFieldsOnInsert(
          strippedRecord,
          resolvedCapabilities,
          actorId,
        );
        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (
          existing &&
          providedFieldsMatchExisting(existing as Record<string, unknown>, {
            id: mut.id,
            ...strippedRecord,
          })
        ) {
          return { ok: true, changes: [] };
        }
        if (existing) {
          return {
            ok: false,
            code: "CONFLICT",
            message: "Record already exists",
            path: "id",
          };
        }
        try {
          await targetDb.create({ model: mut.resource, data: { id: mut.id, ...insertRecord }, namespace });
        } catch (error) {
          if (!isConflictError(error)) throw error;
          return {
            ok: false,
            code: "CONFLICT",
            message: "Record already exists",
            path: "id",
          };
        }
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "insert", record: { id: mut.id, ...insertRecord } },
            ...propagationChanges,
          ],
        };
      }
      case "merge": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        const normalizedData = normalizeRelationFkRecord(schema, mut.resource, coercedData);
        const strippedRecord = stripReadonlyCapabilityFields(normalizedData, resolvedCapabilities);
        const updateData = injectCapabilityFieldsOnUpdate(
          strippedRecord,
          resolvedCapabilities,
          actorId,
        );
        const createData = injectCapabilityFieldsOnInsert(
          strippedRecord,
          resolvedCapabilities,
          actorId,
        );
        const strictUpdateNotFound =
          targetDb.capabilities?.operations?.strictUpdateNotFound === true;
        const mergeResult = await executeSchemaAwareMerge({
          schema, resource: mut.resource, id: mut.id, delta: createData,
          update: async () => {
            const updated = await targetDb.update({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], data: updateData, namespace });
            if (strictUpdateNotFound && updated === undefined) {
              throw { name: "NotFoundError", message: "Record not found after update" };
            }
          },
          create: async (record) => {
            await targetDb.create({ model: mut.resource, data: record, namespace });
          },
          ...(strictUpdateNotFound
            ? {}
            : {
                findOne: async () => targetDb.findOne({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], namespace }),
              }),
        });
        if (mergeResult.ok) {
          const changeRecordData =
            mergeResult.mode === "create" ? createData : updateData;
          const propagationChanges = await collectPropagationChanges(
            targetDb,
            [{ resource: mut.resource, id: mut.id }],
          );
          return {
            ok: true,
            changes: [
              { resource: mut.resource, id: mut.id, op: "merge", record: { id: mut.id, ...changeRecordData } },
              ...propagationChanges,
            ],
          };
        }
        if (mergeResult.code === "NOT_FOUND") return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        logger?.error("Push merge failed", { error: String(mergeResult.error), operation: mut.operation, resource: mut.resource, id: mut.id });
        return { ok: false, code: "INTERNAL", message: "Internal error", path: "$" };
      }
      case "replace": {
        const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {}, logger);
        const normalizedData = normalizeRelationFkRecord(schema, mut.resource, coercedData);
        const strippedRecord = stripReadonlyCapabilityFields(normalizedData, resolvedCapabilities);
        const createData = injectCapabilityFieldsOnInsert(
          strippedRecord,
          resolvedCapabilities,
          actorId,
        );
        const updateData = injectCapabilityFieldsOnUpdate(
          strippedRecord,
          resolvedCapabilities,
          actorId,
        );
        const persistedRecord = await targetDb.upsert({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          create: { id: mut.id, ...createData },
          update: updateData,
          namespace,
          conflictTarget: "id",
        });
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            {
              resource: mut.resource,
              id: mut.id,
              op: "replace",
              record: { id: mut.id, ...(persistedRecord as Record<string, unknown>) },
            },
            ...propagationChanges,
          ],
        };
      }
      case "delete": {
        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (!existing) {
          return { ok: true, changes: [] };
        }
        const relationPolicyResult = await applyRelationDeletePolicies(
          targetDb,
          schema,
          mut.resource,
          mut.id,
          namespace,
        );
        if (!relationPolicyResult.ok) {
          return relationPolicyResult;
        }
        await targetDb.delete({ model: mut.resource, where: [{ field: "id", operator: "eq", value: mut.id }], namespace });
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          relationPolicyResult.changes
            .filter((change) => change.op === "merge")
            .map((change) => ({ resource: change.resource, id: change.id })),
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "delete", record: null },
            ...relationPolicyResult.changes,
            ...propagationChanges,
          ],
        };
      }
      case "trash": {
        if (!hasTrashCapability(resolvedCapabilities)) {
          return {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.trash",
            path: "operation",
          };
        }

        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (!existing) {
          return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        }

        const trashPayload = injectCapabilityFieldsOnUpdate(
          { trashedAt: Date.now(), trashedBy: actorId ?? null },
          resolvedCapabilities,
          actorId,
        );
        await targetDb.update({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          data: trashPayload,
          namespace,
        });
        const updated = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        const changeRecord = (updated as Record<string, unknown> | null) ?? {
          id: mut.id,
          ...(existing as Record<string, unknown>),
          ...trashPayload,
        };
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "merge", record: changeRecord },
            ...propagationChanges,
          ],
        };
      }
      case "restore": {
        if (!hasTrashCapability(resolvedCapabilities)) {
          return {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.restore",
            path: "operation",
          };
        }

        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (!existing) {
          return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        }

        const existingRecord = existing as Record<string, unknown>;
        const isCurrentlyTrashed =
          existingRecord.trashedAt !== null && existingRecord.trashedAt !== undefined;
        if (!isCurrentlyTrashed) {
          return { ok: true, changes: [] };
        }

        const restorePayload = injectCapabilityFieldsOnUpdate(
          { trashedAt: null, trashedBy: null },
          resolvedCapabilities,
          actorId,
        );
        await targetDb.update({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          data: restorePayload,
          namespace,
        });
        const updated = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        const changeRecord = (updated as Record<string, unknown> | null) ?? {
          id: mut.id,
          ...existingRecord,
          ...restorePayload,
        };
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "merge", record: changeRecord },
            ...propagationChanges,
          ],
        };
      }
      case "archive": {
        if (!hasArchivableCapability(resolvedCapabilities)) {
          return {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.archive",
            path: "operation",
          };
        }

        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (!existing) {
          return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        }

        const archivePayload = injectCapabilityFieldsOnUpdate(
          { isArchived: true },
          resolvedCapabilities,
          actorId,
        );
        await targetDb.update({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          data: archivePayload,
          namespace,
        });
        const updated = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        const changeRecord = (updated as Record<string, unknown> | null) ?? {
          id: mut.id,
          ...(existing as Record<string, unknown>),
          ...archivePayload,
        };
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "merge", record: changeRecord },
            ...propagationChanges,
          ],
        };
      }
      case "unarchive": {
        if (!hasArchivableCapability(resolvedCapabilities)) {
          return {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.unarchive",
            path: "operation",
          };
        }

        const existing = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        if (!existing) {
          return { ok: false, code: "NOT_FOUND", message: `Record not found: ${mut.id}`, path: "id" };
        }

        const unarchivePayload = injectCapabilityFieldsOnUpdate(
          { isArchived: false },
          resolvedCapabilities,
          actorId,
        );
        await targetDb.update({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          data: unarchivePayload,
          namespace,
        });
        const updated = await targetDb.findOne({
          model: mut.resource,
          where: [{ field: "id", operator: "eq", value: mut.id }],
          namespace,
        });
        const changeRecord = (updated as Record<string, unknown> | null) ?? {
          id: mut.id,
          ...(existing as Record<string, unknown>),
          ...unarchivePayload,
        };
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          [{ resource: mut.resource, id: mut.id }],
        );
        return {
          ok: true,
          changes: [
            { resource: mut.resource, id: mut.id, op: "merge", record: changeRecord },
            ...propagationChanges,
          ],
        };
      }
      case "share": {
        const shareResult = await executeShare(
          targetDb,
          mut as any,
          resolvedCapabilities,
          namespace,
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (!shareResult.ok) {
          return {
            ok: false,
            code: shareResult.code,
            message: shareResult.message,
            path: shareResult.path,
          };
        }
        return {
          ok: true,
          changes: [
            {
              resource: getPermissionsTable(mut.resource),
              id: String(shareResult.permissionRecord.id),
              op: "upsert",
              record: shareResult.permissionRecord,
            },
          ],
        };
      }
      case "unshare": {
        const unshareResult = await executeUnshare(
          targetDb,
          mut as any,
          resolvedCapabilities,
          namespace,
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (!unshareResult.ok) {
          return {
            ok: false,
            code: unshareResult.code,
            message: unshareResult.message,
            path: unshareResult.path,
          };
        }
        if (!unshareResult.deleted) {
          return { ok: true, changes: [] };
        }
        return {
          ok: true,
          changes: [
            {
              resource: getPermissionsTable(mut.resource),
              id: unshareResult.changeId,
              op: "delete",
              record: null,
            },
          ],
        };
      }
      case "relate": {
        // JSY-001: pass actorId for relation capability field injection parity with direct mutation path
        const result = await executeRelate(targetDb, schema, mut, namespace, actorId);
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message, path: result.path };
        }
        const changes: PendingChange[] = [];
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          collectInactivePropagationSeeds(mut, schema),
        );
        for (const delta of await extractRelationRecordDeltasFromDB(targetDb, mut, schema, namespace)) {
          changes.push({ resource: delta.resource, id: delta.id, op: delta.op, record: delta.record });
        }
        // JSY-002: read back persisted join rows to include server-injected capability fields
        for (const delta of await extractJoinDeltasFromDB(targetDb, mut, schema, namespace)) {
          changes.push({
            resource: delta.resource,
            id: delta.id,
            op: delta.op as "upsert" | "delete",
            record: delta.record,
          });
        }
        changes.push(...propagationChanges);
        return { ok: true, changes };
      }
      case "modifyRelation": {
        // JSY-001: pass actorId for relation capability field injection parity with direct mutation path
        const result = await executeModifyRelation(targetDb, schema, mut, namespace, actorId);
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message, path: result.path };
        }
        const changes: PendingChange[] = [];
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          collectInactivePropagationSeeds(mut, schema),
        );
        for (const delta of await extractRelationRecordDeltasFromDB(targetDb, mut, schema, namespace)) {
          changes.push({ resource: delta.resource, id: delta.id, op: delta.op, record: delta.record });
        }
        // JSY-002: read back persisted join rows to include server-injected capability fields
        for (const delta of await extractJoinDeltasFromDB(targetDb, mut, schema, namespace)) {
          changes.push({
            resource: delta.resource,
            id: delta.id,
            op: delta.op as "upsert" | "delete",
            record: delta.record,
          });
        }
        changes.push(...propagationChanges);
        return { ok: true, changes };
      }
      case "unrelate": {
        const result = await executeUnrelate(targetDb, schema, mut, namespace);
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message, path: result.path };
        }
        const changes: PendingChange[] = [];
        const propagationChanges = await collectPropagationChanges(
          targetDb,
          collectInactivePropagationSeeds(mut, schema),
        );
        for (const delta of await extractRelationRecordDeltasFromDB(targetDb, mut, schema, namespace)) {
          changes.push({ resource: delta.resource, id: delta.id, op: delta.op, record: delta.record });
        }
        for (const delta of extractJoinDeltas(mut, schema)) {
          changes.push({
            resource: delta.resource,
            id: delta.id,
            op: delta.op as "upsert" | "delete",
            record: delta.record,
          });
        }
        changes.push(...propagationChanges);
        return { ok: true, changes };
      }
      default:
        return { ok: false, code: "DFQL_UNSUPPORTED", message: `Unsupported DFQL feature: mutation.operation.${mut.operation}`, path: "operation" };
    }
  }

  /**
   * Record a mutation as failed in errors list and idempotency store.
   */
  async function recordMutationFailure(mut: any, code: string, message: string, path: string) {
    const retryable = code === "INTERNAL" ||
      code === "MUTATION_FAILED" ||
      code === "NOT_FOUND" ||
      (code === "CONFLICT" && path === "id" && mut.operation === "insert");
    errors.push({ mutationId: mut.mutationId, code, message, path, retryable });
    const failResult: MutationResult = {
      ok: false, mutationId: mut.mutationId, affectedIds: [],
      errors: [{ code, message, path, retryable }], deduped: false,
    };
    await idempotencyStore.set(mut.clientId, mut.mutationId, failResult);
    batchLocalSeen.set(`${mut.clientId}:${mut.mutationId}`, false);
  }

  /**
   * Record a mutation as successfully applied.
   */
  async function recordMutationSuccess(mut: any) {
    applied.push(mut.mutationId);
    const result: MutationResult = {
      ok: true, mutationId: mut.mutationId, affectedIds: [mut.id], errors: [], deduped: false,
    };
    await idempotencyStore.set(mut.clientId, mut.mutationId, result);
    batchLocalSeen.set(`${mut.clientId}:${mut.mutationId}`, true);
  }

  // ---- Process each mutation ----
  for (const mutation of request.mutations) {
    const mut = mutation as any;
    let permissionDirectoryTaskId: string | null = null;
    const reconcilePermissionDirectoryAfterSettlement = async (
      durableUnshare = false,
    ) => {
      if (!multiRegionRuntime) return;
      if (
        durableUnshare &&
        mut.operation === "unshare" &&
        !permissionDirectoryTaskId
      ) {
        try {
          permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
            db,
            mut,
            namespace,
            multiRegionRuntime.regionId,
          );
        } catch (error) {
          logger?.error("Push permission directory rollback repair could not be queued", {
            error: String(error),
            operation: mut.operation,
            resource: mut.resource,
          });
          return;
        }
      }
      if (permissionDirectoryTaskId) {
        try {
          await drainPermissionDirectorySync(
            db,
            permissionDirectoryTaskId,
            multiRegionRuntime,
            logger,
          );
        } catch (error) {
          // The database mutation and durable task have already committed.
          // Keep the client result stable and let scheduled draining retry.
          logger?.error("Push permission directory reconciliation deferred", {
            error: String(error),
            operation: mut.operation,
            resource: mut.resource,
            taskId: permissionDirectoryTaskId,
          });
        }
        return;
      }
      await syncDatafnPermissionGrantAfterCommit(
        db,
        mut,
        namespace,
        multiRegionRuntime,
      ).catch((error) => {
        logger?.error("Push permission directory reconciliation failed after commit", {
          error: String(error),
          operation: mut.operation,
          resource: mut.resource,
        });
      });
    };

    // Validate required fields
    if (!mut.clientId || !mut.mutationId) {
      errors.push({ mutationId: mut.mutationId || "", code: "DFQL_INVALID", message: "Invalid DFQL: missing clientId or mutationId", path: "$", retryable: false });
      continue;
    }

    const batchKey = `${mut.clientId}:${mut.mutationId}`;

    // Intra-batch dedup
    if (batchLocalSeen.has(batchKey)) {
      if (batchLocalSeen.get(batchKey)) applied.push(mut.mutationId);
      continue;
    }

    // Cross-batch dedup
    const cached = await idempotencyStore.get(mut.clientId, mut.mutationId);
    if (cached) {
      if (cached.ok) {
        applied.push(mut.mutationId);
        batchLocalSeen.set(batchKey, true);
        continue;
      } else if (
        cached.errors?.length &&
        !isRetryableMutationResult(cached)
      ) {
        errors.push({ mutationId: mut.mutationId, code: cached.errors[0].code, message: cached.errors[0].message, path: cached.errors[0].path || "$", retryable: false });
        batchLocalSeen.set(batchKey, false);
        continue;
      }
    }

    const shareableAuthz = await validateShareableOperationAccess({
      db,
      schema,
      resource: mut.resource,
      operation: mut.operation,
      id: typeof mut.id === "string" ? mut.id : undefined,
      actorId,
      namespace,
      requireActorForPrivate: true,
    });
    if (!shareableAuthz.ok) {
      await recordMutationFailure(
        mut,
        shareableAuthz.code,
        shareableAuthz.message,
        shareableAuthz.path,
      );
      continue;
    }

    if (multiRegionRuntime && mut.operation === "unshare") {
      try {
        // Directory invalidation happens before the permission-row delete.
        // Persist repair work on the settled outer adapter first so commit or
        // rollback can always converge from authoritative database state.
        permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
          db,
          mut,
          namespace,
          multiRegionRuntime.regionId,
          { pending: true },
        );
      } catch (error) {
        logger?.error("Push unshare durability prerequisite failed", {
          error: String(error),
          operation: mut.operation,
          resource: mut.resource,
        });
        await recordMutationFailure(
          mut,
          "INTERNAL",
          "Permission directory repair could not be persisted",
          "$",
        );
        continue;
      }
    }

    // FIX-REL-011: When transactions are supported, wrap operation + change tracking atomically
    if (hasTransaction) {
      let mutationSucceeded = false;
      // Sequence reservations made through a transaction-bound database store
      // are valid only if that transaction commits. Work on a copy and publish
      // the remaining pool after commit; rollback leaves the shared state
      // untouched. External primary stores may leave harmless gaps, but no
      // rolled-back reservation can leak into a later transaction.
      const txSequenceAllocation: SequenceAllocationState = {
        initialBatchAllocated: sequenceAllocation.initialBatchAllocated,
        pool: [...sequenceAllocation.pool],
      };
      let mutationLatestSeq = 0;
      const mutationResourceSeqs: Record<string, number> = {};
      const pendingChangeEvents: number[] = [];
      try {
        await (db as any).transaction(async (txDb: Adapter) => {
          // Execute operation inside transaction
          const opResult = await executeMutationOp(mut, txDb);
          if (!opResult.ok) {
            // Signal failure without aborting transaction (we handle it below)
            throw { __opFailed: true, ...opResult };
          }
          if (multiRegionRuntime && mut.operation === "share") {
            permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
              txDb,
              mut,
              namespace,
              multiRegionRuntime.regionId,
            );
          }

          // Build and record changes inside the same transaction
          const changes = opResult.changes;
          // Change notifications describe committed state, so suppress the
          // transaction-bound service callback and publish only after commit.
          const txChangeTracking = changeTracking.withDb(txDb, false);
          for (const change of changes) {
            const seq = await takeNextServerSeq(txSequenceAllocation, txChangeTracking);
            mutationLatestSeq = Math.max(mutationLatestSeq, seq);
            mutationResourceSeqs[change.resource] = Math.max(
              mutationResourceSeqs[change.resource] || 0,
              seq,
            );
            // FIX-REL-002: retry within transaction
            await recordChangeWithRetry(txChangeTracking, {
              serverSeq: seq, resource: change.resource, id: change.id, op: change.op, record: change.record,
            }, 2, logger);
            pendingChangeEvents.push(seq);
          }
        });
        sequenceAllocation.initialBatchAllocated = txSequenceAllocation.initialBatchAllocated;
        sequenceAllocation.pool = txSequenceAllocation.pool;
        latestSeq = Math.max(latestSeq, mutationLatestSeq);
        for (const [resource, seq] of Object.entries(mutationResourceSeqs)) {
          resourceSeqs[resource] = Math.max(resourceSeqs[resource] || 0, seq);
        }
        for (const seq of pendingChangeEvents) {
          try {
            onChange?.(seq, namespace);
          } catch (error) {
            // The transaction has already committed; notification failures
            // must not report the durable mutation as rolled back.
            logger?.error("Push change notification failed", {
              error: String(error),
              operation: "push.onChange",
              resource: mut.resource,
            });
          }
        }
        mutationSucceeded = true;
      } catch (err: any) {
        if (err?.__opFailed) {
          await recordMutationFailure(mut, err.code, err.message, err.path);
        } else {
          logger?.error("Push atomic mutation failed", { error: formatUnknownError(err), operation: "push.transaction", resource: mut.resource });
          await recordMutationFailure(mut, "MUTATION_FAILED", "Mutation failed", `mutations[${mut.mutationId}]`);
        }
        if (mut.operation === "unshare") {
          await reconcilePermissionDirectoryAfterSettlement(true);
        }
      }

      if (mutationSucceeded) {
        await reconcilePermissionDirectoryAfterSettlement(true);
        await recordMutationSuccess(mut);
      }
    } else {
      // Non-transaction path: execute operation, then record changes separately (best-effort)
      let opResult: ExecuteMutationResult;
      let failedShareCompensationDeferred = false;
      try {
        if (multiRegionRuntime && mut.operation === "share") {
          // With no transaction available, persist the reconciliation task
          // before the grant. A task for a failed operation safely drains as
          // a no-op; a committed grant can never lose its only retry record.
          permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
            db,
            mut,
            namespace,
            multiRegionRuntime.regionId,
            { pending: true },
          );
        }
        opResult = await executeMutationOp(mut, db);
      } catch (error) {
        const failedShareCompensation = getFailedShareCompensation(error);
        if (
          failedShareCompensation &&
          permissionDirectoryTaskId &&
          multiRegionRuntime
        ) {
          permissionDirectoryTaskId = await deferFailedShareCompensation(
            db,
            permissionDirectoryTaskId,
            mut,
            failedShareCompensation.snapshot,
            failedShareCompensation.error,
            namespace,
            multiRegionRuntime.regionId,
          );
          failedShareCompensationDeferred = true;
        }
        logger?.error("Push operation failed", { error: String(error), operation: mut.operation, resource: mut.resource, id: mut.id });
        opResult = {
          ok: false,
          code: "MUTATION_FAILED",
          message: "Mutation failed",
          path: `mutations[${mut.mutationId}]`,
        };
      }

      if (opResult.ok) {
        // Record changes (non-atomic — best-effort with retry)
        const changes = opResult.changes;
        let changeTrackingFailed = false;
        try {
          for (const change of changes) {
            const seq = await takeNextServerSeq(sequenceAllocation);
            latestSeq = Math.max(latestSeq, seq);
            resourceSeqs[change.resource] = Math.max(resourceSeqs[change.resource] || 0, seq);
            await recordChangeWithRetry(changeTracking, {
              serverSeq: seq, resource: change.resource, id: change.id, op: change.op, record: change.record,
            }, 2, logger);
          }
        } catch (error) {
          logger?.error("Change tracking failed in push after retries", { error: String(error), operation: "push.changeTracking" });
          changeTrackingFailed = true;
        }

        await reconcilePermissionDirectoryAfterSettlement(true);
        if (changeTrackingFailed) {
          await recordMutationFailure(mut, "INTERNAL", "Change tracking failed", "$");
        } else {
          await recordMutationSuccess(mut);
        }
      } else {
        if (mut.operation === "share" && !failedShareCompensationDeferred) {
          if (permissionDirectoryTaskId) {
            const discarded = await discardPermissionDirectorySync(
              db,
              permissionDirectoryTaskId,
            )
              .catch((error) => {
                logger?.error("Push failed-share directory task could not be discarded", {
                  error: String(error),
                  operation: mut.operation,
                  resource: mut.resource,
                  taskId: permissionDirectoryTaskId,
                });
                return false;
              });
            permissionDirectoryTaskId = discarded || !multiRegionRuntime
              ? null
              : await enqueuePermissionDirectorySyncDurably(
                  db,
                  mut,
                  namespace,
                  multiRegionRuntime.regionId,
                );
            if (permissionDirectoryTaskId) {
              await reconcilePermissionDirectoryAfterSettlement();
            }
          }
        } else {
          await reconcilePermissionDirectoryAfterSettlement(
            mut.operation === "unshare",
          );
        }
        await recordMutationFailure(mut, opResult.code, opResult.message, opResult.path);
      }
    }
  }

  // Retrieve latest cursor if not updated during loop (e.g. all deduped or empty)
  if (latestSeq === 0) {
    latestSeq = await changeTracking.getCurrentServerSeq();
  }

  // Build per-resource cursors map for client to advance per-table cursors (FIX-B)
  const cursors: Record<string, string> = {};
  for (const [resource, seq] of Object.entries(resourceSeqs)) {
    cursors[resource] = String(seq);
  }

  return {
    ok: errors.length === 0,
    applied,
    errors,
    cursor: String(latestSeq),
    cursorBefore: String(cursorBeforeSeq),
    cursors,
  };
}
