/**
 * Mutation execution logic
 */

import type { DatafnSchema, DatafnPlugin } from "../../core-types.js";
import type { Adapter } from "@superfunctions/db";
import { randomUUID } from "crypto";
import { isRetryableMutationResult, type IdempotencyStore, type MutationResult } from "../idempotency.js";
import { type DFQLMutation, buildReplaceRecord } from "./dfql.js";
import { findSystemFieldWrite, normalizeRelationFkRecord, resolveCapabilities } from "@datafn/core";
import {
  applyInactivePropagation,
  applyRelationDeletePolicies,
  collectInactivePropagationSeeds,
  executeRelate,
  executeModifyRelation,
  executeUnrelate,
  extractJoinDeltas,
  extractRelationRecordDeltasFromDB,
} from "./relations.js";
import { executeSchemaAwareMerge } from "./merge-decision.js";
import {
  executeShare,
  executeUnshare,
  getFailedShareCompensation,
  getPermissionsTable,
  syncDatafnPermissionGrantAfterCommit,
  type FailedShareCompensation,
} from "./share.js";
import { getDatafnMultiRegionRuntimeConfig } from "../../plugins/multi-region.js";
import type { DatafnMultiRegionRuntimeConfig } from "../../plugins/multi-region.js";
import { ChangeTrackingService, recordChangeWithRetry, recordChangesWithRetry, type ChangeEntryInput } from "../sync/change-tracking.js";
import {
  applyRelationInheritanceForRelate,
  applyRelationInheritanceForShare,
  applyRelationInheritanceForUnrelate,
  applyRelationInheritanceForUnshare,
  collectRelationInheritanceTargetsForUnrelate,
  enforceRelateConsentForInheritance,
} from "../relations/inheritance.js";
import { evaluateGuard } from "./guards.js";
import type { DatafnLogger } from "../../logger.js";
import { validateShareableOperationAccess } from "../../validation/authz.js";
import type { SearchProvider } from "../../search-provider.js";
import {
  deferFailedShareCompensation,
  discardPermissionDirectorySync,
  drainPermissionDirectorySync,
  enqueuePermissionDirectorySync,
  enqueuePermissionDirectorySyncDurably,
  ensurePermissionDirectoryOutbox,
  markPermissionDirectorySyncReady,
} from "./permission-directory-outbox.js";

const FAILED_SHARE_COMPENSATION_RESULT = Symbol("failedShareCompensation");
type InternalMutationResult = MutationResult & {
  [FAILED_SHARE_COMPENSATION_RESULT]?: FailedShareCompensation;
};

const SEARCH_UPSERT_OPS = new Set(["insert", "merge", "replace", "trash", "restore", "archive", "unarchive"]);

async function tryUpdateSearchIndex(
  searchProvider: SearchProvider,
  mutation: DFQLMutation,
  db: Adapter,
  namespace: string | undefined,
  logger?: DatafnLogger,
  multiRegionRuntime?: DatafnMultiRegionRuntimeConfig | null,
): Promise<void> {
  const op = mutation.operation === "delete" ? "delete" : "upsert";
  const shouldIndex = op === "delete" || SEARCH_UPSERT_OPS.has(mutation.operation);
  if (!shouldIndex) return;
  try {
    const storedRecord =
      op === "upsert"
        ? await db.findOne({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            namespace,
          })
        : null;
    const record = storedRecord ?? { id: mutation.id, ...(mutation.record || {}) };
    await searchProvider.updateIndices({
      resource: mutation.resource,
      records: [{
        ...record,
        __ns: namespace,
        ...(multiRegionRuntime?.regionId ? { __region: multiRegionRuntime.regionId } : {}),
      }],
      operation: op,
    });
  } catch (e) {
    logger?.error("Search index update failed (non-fatal)", {
      error: String(e),
      operation: "search-index-update",
      resource: mutation.resource,
    });
  }
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
  return resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );
}

export function stripReadonlyCapabilityFields(
  record: Record<string, unknown>,
  resolvedCapabilities: unknown[],
): Record<string, unknown> {
  const stripped = { ...record };

  if (hasSimpleCapability(resolvedCapabilities, "timestamps")) {
    delete stripped.createdAt;
    delete stripped.updatedAt;
  }
  if (hasSimpleCapability(resolvedCapabilities, "audit")) {
    delete stripped.createdBy;
    delete stripped.updatedBy;
  }
  if (hasSimpleCapability(resolvedCapabilities, "trash")) {
    delete stripped.trashedAt;
    delete stripped.trashedBy;
  }

  return stripped;
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

function hasTrashCapability(resolvedCapabilities: unknown[]): boolean {
  return resolvedCapabilities.some((entry) => entry === "trash");
}

function hasArchivableCapability(resolvedCapabilities: unknown[]): boolean {
  return resolvedCapabilities.some((entry) => entry === "archivable");
}

function hasShareableCapability(resolvedCapabilities: unknown[]): boolean {
  return resolvedCapabilities.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "shareable" in (entry as Record<string, unknown>),
  );
}

/**
 * REL-011 / DI-002: Core operation execution (operation switch + change tracking).
 * Called within a transaction from the guarded path, or directly from the main path.
 * Does NOT include idempotency check/set, guard evaluation, or search index updates.
 */
async function executeMutationCore(
  mutation: DFQLMutation,
  db: Adapter,
  schema: DatafnSchema,
  namespace: string,
  effectiveMutationId: string,
  changeTracking: ChangeTrackingService,
  actorId?: string,
  logger?: DatafnLogger,
  multiRegionRuntime?: DatafnMultiRegionRuntimeConfig | null,
): Promise<MutationResult> {
  const resolvedCapabilities = resolveCapabilitiesForResource(schema, mutation.resource);
  let opResult:
    | { ok: true }
    | { ok: false; code: string; message: string; path: string };
  let resolvedRecord: Record<string, unknown> | undefined;
  let changeOverride:
    | {
        resource: string;
        id: string;
        op: "upsert" | "delete";
        record: Record<string, unknown> | null;
      }
    | undefined;
  let additionalChanges: Array<{
    resource: string;
    id: string;
    op: "merge" | "delete";
    record: Record<string, unknown> | null;
  }> = [];
  // EXE-008: flag to skip change tracking when deleting a non-existent record
  let skipChangeTracking = false;
  let failedShareCompensation: FailedShareCompensation | null = null;

  if (
    (mutation.operation === "insert" || mutation.operation === "merge" || mutation.operation === "replace") &&
    mutation.record
  ) {
    const systemField = findSystemFieldWrite(schema.relations, mutation.resource, mutation.record);
    if (systemField) {
      return {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [{
          code: "DFQL_INVALID",
          message: `Field is read-only: ${systemField} on ${mutation.resource}`,
          path: `record.${systemField}`,
          retryable: false,
        }],
        deduped: false,
      };
    }
  }

  try {
    switch (mutation.operation) {
      case "insert":
        try {
          const strippedRecord = stripReadonlyCapabilityFields(
            normalizeRelationFkRecord(schema, mutation.resource, mutation.record || {}),
            resolvedCapabilities,
          );
          const insertRecord = injectCapabilityFieldsOnInsert(
            strippedRecord,
            resolvedCapabilities,
            actorId,
          );
          await db.create({
            model: mutation.resource,
            data: { id: mutation.id, ...insertRecord },
            namespace,
          });
          resolvedRecord = insertRecord;
          additionalChanges.push(...await applyInactivePropagation(
            db,
            schema,
            [{ resource: mutation.resource, id: mutation.id }],
            namespace,
          ));
          opResult = { ok: true };
        } catch (error: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation insert failed", { error: String(error), operation: "insert", resource: mutation.resource });
          // EXE-005: Check error.code before message matching
          const code = error?.code;
          const msg = (error?.message || "").toLowerCase();
          if (
            code === "23505" || code === "UNIQUE_VIOLATION" || code === "ER_DUP_ENTRY" ||
            code === "SQLITE_CONSTRAINT_UNIQUE" ||
            msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists") || msg.includes("conflict")
          ) {
            opResult = { ok: false, code: "CONFLICT", message: "Record already exists", path: "id" };
          } else {
            opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
          }
        }
        break;

      case "merge":
        {
          const strippedRecord = stripReadonlyCapabilityFields(
            normalizeRelationFkRecord(schema, mutation.resource, mutation.record || {}),
            resolvedCapabilities,
          );
          const mergeData = injectCapabilityFieldsOnUpdate(
            strippedRecord,
            resolvedCapabilities,
            actorId,
          );
          const strictUpdateNotFound =
            db.capabilities?.operations?.strictUpdateNotFound === true;
          const mergeResult = await executeSchemaAwareMerge({
            schema,
            resource: mutation.resource,
            id: mutation.id,
            delta: mergeData,
            update: async () => {
              const updated = await db.update({
                model: mutation.resource,
                where: [{ field: "id", operator: "eq", value: mutation.id }],
                data: mergeData,
                namespace,
              });
              if (strictUpdateNotFound && updated === undefined) {
                throw { name: "NotFoundError", message: "Record not found after update" };
              }
            },
            create: async (record) => {
              await db.create({
                model: mutation.resource,
                data: record,
                namespace,
              });
            },
            ...(strictUpdateNotFound
              ? {}
              : {
                  findOne: async () =>
                    db.findOne({
                      model: mutation.resource,
                      where: [{ field: "id", operator: "eq", value: mutation.id }],
                      namespace,
                    }),
                }),
          });

          if (mergeResult.ok) {
            resolvedRecord = mergeData;
            additionalChanges.push(...await applyInactivePropagation(
              db,
              schema,
              [{ resource: mutation.resource, id: mutation.id }],
              namespace,
            ));
            opResult = { ok: true };
          } else {
            if (mergeResult.code === "INTERNAL") {
              logger?.error("Mutation merge failed", {
                error: String(mergeResult.error),
                operation: "merge",
                resource: mutation.resource,
              });
            }
            opResult = {
              ok: false,
              code: mergeResult.code,
              message: mergeResult.message,
              path: mergeResult.path,
            };
          }
        }
        break;

      case "replace":
        try {
          const existing = await db.findOne({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            namespace,
          });
          if (!existing) {
            opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
            break;
          }
          const strippedRecord = stripReadonlyCapabilityFields(
            normalizeRelationFkRecord(schema, mutation.resource, mutation.record || {}),
            resolvedCapabilities,
          );
          const updateRecord = injectCapabilityFieldsOnUpdate(
            strippedRecord,
            resolvedCapabilities,
            actorId,
          );
          const buildResult = buildReplaceRecord(
            schema,
            mutation.resource,
            existing,
            updateRecord,
            resolvedCapabilities,
          );
          if (!buildResult.ok) {
            opResult = { ok: false, code: buildResult.code, message: buildResult.message, path: buildResult.path };
            break;
          }
          await db.update({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            data: buildResult.record,
            namespace,
          });
          resolvedRecord = buildResult.record;
          additionalChanges.push(...await applyInactivePropagation(
            db,
            schema,
            [{ resource: mutation.resource, id: mutation.id }],
            namespace,
          ));
          opResult = { ok: true };
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation replace failed", { error: String(e), operation: "replace", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "delete": {
        // EXE-008: Check existence before change tracking (delete of non-existent is idempotent)
        const existingForDelete = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        if (!existingForDelete) {
          // Record didn't exist — skip change tracking (no-op delete)
          skipChangeTracking = true;
        } else {
          // Relation policies must run before the parent disappears. In
          // particular, a restrict result must leave the parent intact.
          const relationPolicyResult = await applyRelationDeletePolicies(
            db,
            schema,
            mutation.resource,
            mutation.id,
            namespace,
          );
          if (!relationPolicyResult.ok) {
            opResult = {
              ok: false,
              code: relationPolicyResult.code,
              message: relationPolicyResult.message,
              path: relationPolicyResult.path,
            };
            break;
          }
          await db.delete({
            model: mutation.resource,
            where: [{ field: "id", operator: "eq", value: mutation.id }],
            namespace,
          });
          additionalChanges = [
            ...relationPolicyResult.changes,
            ...await applyInactivePropagation(
              db,
              schema,
              relationPolicyResult.changes
                .filter((change) => change.op === "merge")
                .map((change) => ({ resource: change.resource, id: change.id })),
              namespace,
            ),
          ];
        }
        if (hasShareableCapability(resolvedCapabilities)) {
          const permissionRows = await db.findMany({
            model: getPermissionsTable(mutation.resource),
            where: [{ field: "resourceId", operator: "eq", value: mutation.id }],
            namespace,
          });
          for (const permissionRow of permissionRows) {
            await db.delete({
              model: getPermissionsTable(mutation.resource),
              where: [{ field: "id", operator: "eq", value: permissionRow.id }],
              namespace,
            });
          }
        }
        opResult = { ok: true };
        break;
      }

      case "trash": {
        if (!hasTrashCapability(resolvedCapabilities)) {
          opResult = {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.trash",
            path: "operation",
          };
          break;
        }

        const existing = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });

        if (!existing) {
          opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
          break;
        }

        const trashPayload = injectCapabilityFieldsOnUpdate(
          { trashedAt: Date.now(), trashedBy: actorId ?? null },
          resolvedCapabilities,
          actorId,
        );

        await db.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: trashPayload,
          namespace,
        });

        const updated = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        resolvedRecord = (updated as Record<string, unknown> | null) ?? {
          id: mutation.id,
          ...existing,
          ...trashPayload,
        };
        additionalChanges.push(...await applyInactivePropagation(
          db,
          schema,
          [{ resource: mutation.resource, id: mutation.id }],
          namespace,
        ));
        opResult = { ok: true };
        break;
      }

      case "restore": {
        if (!hasTrashCapability(resolvedCapabilities)) {
          opResult = {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.restore",
            path: "operation",
          };
          break;
        }

        const existing = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });

        if (!existing) {
          opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
          break;
        }

        const existingRecord = existing as Record<string, unknown>;
        const isCurrentlyTrashed =
          existingRecord.trashedAt !== null && existingRecord.trashedAt !== undefined;

        if (!isCurrentlyTrashed) {
          skipChangeTracking = true;
          opResult = { ok: true };
          break;
        }

        const restorePayload = injectCapabilityFieldsOnUpdate(
          { trashedAt: null, trashedBy: null },
          resolvedCapabilities,
          actorId,
        );

        await db.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: restorePayload,
          namespace,
        });

        const updated = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        resolvedRecord = (updated as Record<string, unknown> | null) ?? {
          id: mutation.id,
          ...existingRecord,
          ...restorePayload,
        };
        additionalChanges.push(...await applyInactivePropagation(
          db,
          schema,
          [{ resource: mutation.resource, id: mutation.id }],
          namespace,
        ));
        opResult = { ok: true };
        break;
      }

      case "archive": {
        if (!hasArchivableCapability(resolvedCapabilities)) {
          opResult = {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.archive",
            path: "operation",
          };
          break;
        }

        const existing = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });

        if (!existing) {
          opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
          break;
        }

        const archivePayload = injectCapabilityFieldsOnUpdate(
          { isArchived: true },
          resolvedCapabilities,
          actorId,
        );

        await db.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: archivePayload,
          namespace,
        });

        const updated = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        resolvedRecord = (updated as Record<string, unknown> | null) ?? {
          id: mutation.id,
          ...(existing as Record<string, unknown>),
          ...archivePayload,
        };
        additionalChanges.push(...await applyInactivePropagation(
          db,
          schema,
          [{ resource: mutation.resource, id: mutation.id }],
          namespace,
        ));
        opResult = { ok: true };
        break;
      }

      case "unarchive": {
        if (!hasArchivableCapability(resolvedCapabilities)) {
          opResult = {
            ok: false,
            code: "DFQL_UNSUPPORTED",
            message: "Unsupported DFQL feature: mutation.operation.unarchive",
            path: "operation",
          };
          break;
        }

        const existing = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });

        if (!existing) {
          opResult = { ok: false, code: "NOT_FOUND", message: `Record not found: ${mutation.id}`, path: "id" };
          break;
        }

        const unarchivePayload = injectCapabilityFieldsOnUpdate(
          { isArchived: false },
          resolvedCapabilities,
          actorId,
        );

        await db.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: unarchivePayload,
          namespace,
        });

        const updated = await db.findOne({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          namespace,
        });
        resolvedRecord = (updated as Record<string, unknown> | null) ?? {
          id: mutation.id,
          ...(existing as Record<string, unknown>),
          ...unarchivePayload,
        };
        additionalChanges.push(...await applyInactivePropagation(
          db,
          schema,
          [{ resource: mutation.resource, id: mutation.id }],
          namespace,
        ));
        opResult = { ok: true };
        break;
      }

      case "share": {
        const shareResult = await executeShare(
          db,
          mutation as any,
          resolvedCapabilities,
          namespace,
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (!shareResult.ok) {
          opResult = {
            ok: false,
            code: shareResult.code,
            message: shareResult.message,
            path: shareResult.path,
          };
          break;
        }
        changeOverride = {
          resource: getPermissionsTable(mutation.resource),
          id: String(shareResult.permissionRecord.id),
          op: "upsert",
          record: shareResult.permissionRecord,
        };
        const inheritanceShareResult = await applyRelationInheritanceForShare({
          db,
          schema,
          namespace,
          actorId,
          parentResource: mutation.resource,
          parentId:
            typeof shareResult.permissionRecord.resourceId === "string"
              ? shareResult.permissionRecord.resourceId
              : null,
          principalId: String(shareResult.permissionRecord.principalId ?? ""),
          level:
            (shareResult.permissionRecord.level as "viewer" | "editor" | "owner") ??
            "viewer",
        });
        if (!inheritanceShareResult.ok) {
          opResult = inheritanceShareResult;
          break;
        }
        opResult = { ok: true };
        break;
      }

      case "unshare": {
        const unshareResult = await executeUnshare(
          db,
          mutation as any,
          resolvedCapabilities,
          namespace,
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (!unshareResult.ok) {
          opResult = {
            ok: false,
            code: unshareResult.code,
            message: unshareResult.message,
            path: unshareResult.path,
          };
          break;
        }
        if (!unshareResult.deleted) {
          skipChangeTracking = true;
        } else {
          const inheritanceUnsharePrincipal =
            mutation.shareWith?.principalId ??
            (mutation.shareWith?.userId
              ? (String(mutation.shareWith.userId).includes(":")
                ? String(mutation.shareWith.userId)
                : `user:${mutation.shareWith.userId}`)
              : undefined);
          if (typeof inheritanceUnsharePrincipal === "string") {
            const inheritanceUnshareResult = await applyRelationInheritanceForUnshare({
              db,
              schema,
              namespace,
              parentResource: mutation.resource,
              parentId: mutation.scope === "resource" ? null : mutation.id,
              principalId: inheritanceUnsharePrincipal,
            });
            if (!inheritanceUnshareResult.ok) {
              opResult = inheritanceUnshareResult;
              break;
            }
          }
          changeOverride = {
            resource: getPermissionsTable(mutation.resource),
            id: unshareResult.changeId,
            op: "delete",
            record: null,
          };
        }
        opResult = { ok: true };
        break;
      }

      case "relate":
        try {
          const consentResult = await enforceRelateConsentForInheritance({
            schema,
            db,
            namespace,
            mutation,
          });
          if (!consentResult.ok) {
            opResult = consentResult;
            break;
          }

          opResult = await executeRelate(db, schema, mutation, namespace, actorId);
          if (opResult.ok) {
            const inheritanceRelateResult = await applyRelationInheritanceForRelate({
              db,
              schema,
              namespace,
              actorId,
              mutation,
            });
            if (!inheritanceRelateResult.ok) {
              opResult = inheritanceRelateResult;
            }
          }
          if (opResult.ok) {
            additionalChanges.push(...await applyInactivePropagation(
              db,
              schema,
              collectInactivePropagationSeeds(mutation, schema),
              namespace,
            ));
          }
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation relate failed", { error: String(e), operation: "relate", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "modifyRelation":
        try {
          opResult = await executeModifyRelation(db, schema, mutation, namespace, actorId);
          if (opResult.ok) {
            additionalChanges.push(...await applyInactivePropagation(
              db,
              schema,
              collectInactivePropagationSeeds(mutation, schema),
              namespace,
            ));
          }
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation modifyRelation failed", { error: String(e), operation: "modifyRelation", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      case "unrelate":
        try {
          const unrelateTargets = await collectRelationInheritanceTargetsForUnrelate({
            db,
            schema,
            namespace,
            mutation,
          });
          opResult = await executeUnrelate(db, schema, mutation, namespace);
          if (opResult.ok) {
            const inheritanceUnrelateResult = await applyRelationInheritanceForUnrelate({
              db,
              schema,
              namespace,
              mutation,
              targets: unrelateTargets,
            });
            if (!inheritanceUnrelateResult.ok) {
              opResult = inheritanceUnrelateResult;
            }
          }
          if (opResult.ok) {
            additionalChanges.push(...await applyInactivePropagation(
              db,
              schema,
              collectInactivePropagationSeeds(mutation, schema),
              namespace,
            ));
          }
        } catch (e: any) {
          // EXE-010: Log original error for observability
          logger?.error("Mutation unrelate failed", { error: String(e), operation: "unrelate", resource: mutation.resource });
          opResult = { ok: false, code: "INTERNAL", message: e?.message || "Internal error", path: "$" };
        }
        break;

      default:
        opResult = {
          ok: false,
          code: "DFQL_UNSUPPORTED",
          message: `Unsupported DFQL feature: mutation.operation.${(mutation as any).operation}`,
          path: "operation",
        };
    }
  } catch (error: any) {
    if (mutation.operation === "share") {
      failedShareCompensation = getFailedShareCompensation(error);
    }
    logger?.error("Unexpected mutation error", {
      error: String(error),
      operation: (mutation as any).operation,
      resource: mutation.resource,
    });
    opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
  }

  const result: MutationResult = opResult.ok
    ? { ok: true, mutationId: effectiveMutationId, affectedIds: [mutation.id], errors: [], deduped: false }
    : {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [{ code: opResult.code, message: opResult.message, path: opResult.path, retryable: false }],
        deduped: false,
      };
  if (failedShareCompensation) {
    Object.defineProperty(result, FAILED_SHARE_COMPENSATION_RESULT, {
      value: failedShareCompensation,
    });
  }

  // REL-011: Record change tracking using the provided changeTracking instance
  // (which uses the same db adapter as the operation — ensures atomicity when in a transaction)
  if (opResult.ok && !skipChangeTracking) {
    try {
      const isRelationMutation =
        mutation.operation === "relate" ||
        mutation.operation === "modifyRelation" ||
        mutation.operation === "unrelate";

      if (isRelationMutation) {
        const recordDeltas = await extractRelationRecordDeltasFromDB(db, mutation, schema, namespace);
        const joinDeltas = extractJoinDeltas(mutation, schema);
        const deltaByRecord = new Map<string, typeof recordDeltas[number] | typeof joinDeltas[number] | typeof additionalChanges[number]>();
        for (const delta of [...recordDeltas, ...joinDeltas, ...additionalChanges]) {
          deltaByRecord.set(`${delta.resource}:${delta.id}`, delta);
        }
        const allDeltas = [...deltaByRecord.values()];
        if (allDeltas.length > 0) {
          const seqs = await changeTracking.getNextServerSeqBatch(allDeltas.length);
          const entries = allDeltas.map((delta, i) => ({
            serverSeq: seqs[i],
            resource: delta.resource,
            id: delta.id,
            op: delta.op,
            record: delta.record,
          }));
          await recordChangesWithRetry(changeTracking, entries, 2, logger);
        }
      } else {
        const changeOp: ChangeEntryInput["op"] = changeOverride
          ? changeOverride.op
          : mutation.operation === "delete" ? "delete" :
            mutation.operation === "insert" ? "insert" :
            mutation.operation === "trash" ? "merge" :
            mutation.operation === "restore" ? "merge" :
            mutation.operation === "archive" ? "merge" :
            mutation.operation === "unarchive" ? "merge" :
            mutation.operation === "merge" ? "merge" :
            "replace";
        const changeRecord = changeOverride
          ? changeOverride.record
          : mutation.operation === "delete"
            ? null
            : mutation.operation === "replace" && resolvedRecord !== undefined
              ? { id: mutation.id, ...resolvedRecord }
              : { id: mutation.id, ...(resolvedRecord || mutation.record || {}) };
        const primaryChange: Omit<ChangeEntryInput, "serverSeq"> = {
          resource: changeOverride?.resource ?? mutation.resource,
          id: changeOverride?.id ?? mutation.id,
          op: changeOp,
          record: changeRecord,
        };
        const allChanges = [
          primaryChange,
          ...additionalChanges,
        ];
        if (allChanges.length > 1) {
          const seqs = await changeTracking.getNextServerSeqBatch(allChanges.length);
          await recordChangesWithRetry(
            changeTracking,
            allChanges.map((change, i) => ({
              serverSeq: seqs[i],
              resource: change.resource,
              id: change.id,
              op: change.op,
              record: change.record,
            })),
            2,
            logger,
          );
        } else {
          const serverSeq = await changeTracking.getNextServerSeq();
          // FIX-REL-002: Use shared retry helper for change-tracking parity with push path
          await recordChangeWithRetry(changeTracking, {
            serverSeq,
            ...primaryChange,
          }, 2, logger);
        }
      }
    } catch (error) {
      logger?.error("Change tracking failed", { error: String(error), operation: "changeTracking", resource: mutation.resource });
      throw error;
    }
  }

  return result;
}

/**
 * Execute a single mutation
 */
export async function executeMutation(
  mutation: DFQLMutation,
  schema: DatafnSchema,
  db: Adapter,
  idempotencyStore: IdempotencyStore,
  changeTracking: ChangeTrackingService,
  plugins: DatafnPlugin[] = [],
  namespace: string,
  actorId?: string,
  logger?: DatafnLogger,
  searchProvider?: SearchProvider,
  insideTransaction = false,
  deferPermissionDirectorySync?: (
    sync: (committedDb: Adapter) => Promise<void>,
  ) => void,
  prequeuedPermissionDirectoryTaskId?: string,
): Promise<MutationResult> {
  const multiRegionRuntime = getDatafnMultiRegionRuntimeConfig(plugins);
  let permissionDirectoryTaskId: string | null =
    prequeuedPermissionDirectoryTaskId ?? null;
  let permissionDirectoryTaskPending = Boolean(
    prequeuedPermissionDirectoryTaskId,
  );
  const needsPermissionDirectoryOutbox = Boolean(
    multiRegionRuntime &&
    (mutation.operation === "share" || mutation.operation === "unshare"),
  );
  const shouldQueuePermissionDirectorySync = Boolean(
    multiRegionRuntime && mutation.operation === "share",
  );
  const queuePermissionDirectorySync = async (
    targetDb: Adapter,
    pending = false,
  ) => {
    if (!needsPermissionDirectoryOutbox || permissionDirectoryTaskId) return;
    permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
      targetDb,
      mutation,
      namespace,
      multiRegionRuntime!.regionId,
      { pending },
    );
    permissionDirectoryTaskPending = pending;
  };
  const releasePermissionDirectoryTask = async () => {
    if (!permissionDirectoryTaskId || !permissionDirectoryTaskPending) return;
    try {
      const release = await markPermissionDirectorySyncReady(
        db,
        permissionDirectoryTaskId,
      );
      if (release === "ownership-lost") {
        permissionDirectoryTaskId = null;
      }
      permissionDirectoryTaskPending = false;
    } catch (error) {
      // The pre-commit lease keeps the task durable and makes it eligible for
      // recovery after expiry even when this best-effort release fails.
      logger?.error("Permission directory task release deferred", {
        error: String(error),
        operation: mutation.operation,
        resource: mutation.resource,
        taskId: permissionDirectoryTaskId,
      });
    }
  };
  const syncPermissionDirectoryAfterCommit = async (committedDb = db) => {
    if (
      needsPermissionDirectoryOutbox &&
      multiRegionRuntime &&
      !permissionDirectoryTaskId
    ) {
      try {
        // Unshare invalidates before the database settles. Queue repair after
        // settlement so a rollback restoration is durable if re-indexing is
        // temporarily unavailable.
        permissionDirectoryTaskId = await enqueuePermissionDirectorySync(
          committedDb,
          mutation,
          namespace,
          multiRegionRuntime.regionId,
        );
      } catch (error) {
        logger?.error("Permission directory rollback repair could not be queued", {
          error: String(error),
          operation: mutation.operation,
          resource: mutation.resource,
        });
        return;
      }
    }
    if (multiRegionRuntime && permissionDirectoryTaskId) {
      try {
        await drainPermissionDirectorySync(
          committedDb,
          permissionDirectoryTaskId,
          multiRegionRuntime,
          logger,
        );
      } catch (error) {
        // The grant and outbox task have already committed. Preserve the
        // successful mutation result; startup/interval draining owns retry.
        logger?.error("Permission directory reconciliation failed after commit", {
          error: String(error),
          operation: mutation.operation,
          resource: mutation.resource,
        });
      }
      return;
    }
    try {
      await syncDatafnPermissionGrantAfterCommit(
        committedDb,
        mutation,
        namespace,
        multiRegionRuntime,
      );
    } catch (error) {
      logger?.error("Permission directory reconciliation failed after commit", {
        error: String(error),
        operation: mutation.operation,
        resource: mutation.resource,
      });
    }
  };
  const reconcilePermissionDirectoryAfterCommit = async () => {
    if (insideTransaction) {
      // External directory state must never observe the transaction adapter.
      // The enclosing transaction owner is the only layer that knows whether
      // the database committed or rolled back, so it must run reconciliation
      // against the settled outer adapter.
      if (deferPermissionDirectorySync) {
        deferPermissionDirectorySync(syncPermissionDirectoryAfterCommit);
      } else {
        logger?.error("Permission directory reconciliation requires settlement deferral", {
          operation: mutation.operation,
          resource: mutation.resource,
        });
      }
      return;
    }
    await syncPermissionDirectoryAfterCommit();
  };
  // clientId and mutationId are optional. When absent, skip idempotency tracking.
  // EXE-009: Use crypto.randomUUID() for unpredictable anonymous mutation IDs
  const effectiveMutationId = mutation.mutationId || randomUUID();

  // Check idempotency only when both IDs are provided
  if (mutation.clientId && mutation.mutationId) {
    const cached = await idempotencyStore.get(
      mutation.clientId,
      mutation.mutationId,
    );
    if (cached && !isRetryableMutationResult(cached)) {
      return { ...cached, deduped: true };
    }
  }

  // Validate operation
  const validOps = [
    "insert",
    "merge",
    "replace",
    "delete",
    "trash",
    "restore",
    "archive",
    "unarchive",
    "share",
    "unshare",
    "relate",
    "modifyRelation",
    "unrelate",
  ];
  if (!validOps.includes(mutation.operation)) {
    const result: MutationResult = {
      ok: false,
      mutationId: effectiveMutationId,
      affectedIds: [],
      errors: [
        {
          code: "DFQL_UNSUPPORTED",
          message: `Unsupported DFQL feature: mutation.operation.${mutation.operation}`,
          path: "operation",
          retryable: false,
        },
      ],
      deduped: false,
    };
    if (mutation.clientId && mutation.mutationId) {
      await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
    }
    return result;
  }

  // PHASE_11: Shareable mutation authorization by access level.
  const resolvedCapabilities = resolveCapabilitiesForResource(schema, mutation.resource);
  if (hasShareableCapability(resolvedCapabilities)) {
    const authzResult = await validateShareableOperationAccess({
      db,
      schema,
      resource: mutation.resource,
      operation: mutation.operation,
      id: mutation.id,
      actorId,
      namespace,
      requireActorForPrivate: false,
    });
    if (!authzResult.ok) {
      const result: MutationResult = {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [
          {
            code: authzResult.code,
            message: authzResult.message,
            path: authzResult.path,
            retryable: authzResult.code === "FORBIDDEN",
          },
        ],
        deduped: false,
      };
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
      }
      return result;
    }
  }

  if (needsPermissionDirectoryOutbox && !insideTransaction) {
    // DDL must happen before any enclosing transaction; the task itself is
    // inserted with the grant so a committed share always has a durable retry.
    await ensurePermissionDirectoryOutbox(db);
  }
  if (
    multiRegionRuntime &&
    mutation.operation === "unshare" &&
    !insideTransaction
  ) {
    // Unshare invalidates the external directory before the database write.
    // Persist repair work on the outer adapter first so a later rollback can
    // never restore the grant without leaving durable re-index work.
    await queuePermissionDirectorySync(db, true);
  }

  // DI-002: Guard evaluation + operation MUST run in same transaction to prevent TOCTOU.
  // When db.transaction is available and a guard is present, wrap the guard check +
  // the entire operation + change tracking in a single transaction.
  // When called from transact.ts (db is already a tx adapter), `db.transaction` on the
  // proxy still exists, but the proxy is the same instance — nested calls are safe because
  // each call to the test mock just creates a new scope; real adapters use savepoints.
  //
  // REL-011: changeTracking.withDb(db) ensures change recording uses the same db
  // that performed the operation (tx db from transact.ts, outer db from push.ts).
  const hasGuard = !!mutation.if;
  // DI-002: Use adapter capabilities to determine transaction support.
  // capabilities.transactions.supported === false means explicitly no support (e.g. memoryAdapter).
  // If capabilities are absent/incomplete (e.g. test mocks), fall back to duck-typing.
  const hasTransaction =
    !insideTransaction &&
    (db.capabilities?.transactions?.supported !== false) &&
    typeof db.transaction === "function";

  if (hasGuard && hasTransaction) {
    // Wrap guard evaluation + full operation + change tracking in a single transaction
    let txMutationResult: MutationResult | null = null;
    let guardFailed = false;

    try {
      await changeTracking.ensureReady();
      await (db as any).transaction(async (txDb: Adapter) => {
        // DI-002: Re-read record inside transaction to prevent TOCTOU
        const guardResult = await evaluateGuard(
          txDb,
          mutation.resource,
          mutation.id,
          mutation.if!,
          schema,
          namespace,
        );

        if (!guardResult.match) {
          guardFailed = true;
          // Signal transaction abort (will be caught below)
          throw { __datafnGuardFailed: true };
        }

        // Execute the operation within the transaction
        txMutationResult = await executeMutationCore(
          mutation,
          txDb,
          schema,
          namespace,
          effectiveMutationId,
          changeTracking.withDb(txDb),
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (txMutationResult.ok && shouldQueuePermissionDirectorySync) {
          await queuePermissionDirectorySync(txDb);
        }
        if (!txMutationResult.ok) {
          // A returned mutation failure is still an aborted transaction. Throw
          // after retaining the public result so adapters roll back relation
          // effects and change tracking together.
          throw { __datafnMutationFailed: true };
        }
      });
    } catch (err: any) {
      if (err?.__datafnGuardFailed) {
        guardFailed = true;
      } else if (!err?.__datafnMutationFailed) {
        // Transaction aborted for another reason
        txMutationResult = {
          ok: false,
          mutationId: effectiveMutationId,
          affectedIds: [],
          errors: [{ code: "INTERNAL", message: err?.message || "Transaction failed", path: "$", retryable: false }],
          deduped: false,
        };
      }
    }

    if (guardFailed) {
      await releasePermissionDirectoryTask();
      if (permissionDirectoryTaskId) {
        await syncPermissionDirectoryAfterCommit(db);
      }
      const result: MutationResult = {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [{ code: "CONFLICT", message: "Guard condition not met", path: "if", retryable: false }],
        deduped: false,
      };
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
      }
      return result;
    }

    if (txMutationResult) {
      await releasePermissionDirectoryTask();
      if ((txMutationResult as MutationResult).ok) {
        await reconcilePermissionDirectoryAfterCommit();
      } else if (mutation.operation === "unshare") {
        // Fail-closed unshare invalidates the directory before the database
        // delete. A rolled-back transaction restores the grant, so restore its
        // directory entry from settled outer-adapter state as compensation.
        await syncPermissionDirectoryAfterCommit(db);
      }
      if (searchProvider && (txMutationResult as MutationResult).ok) {
        await tryUpdateSearchIndex(searchProvider, mutation, db, namespace, logger, multiRegionRuntime);
      }
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, txMutationResult as MutationResult);
      }
      return txMutationResult as MutationResult;
    }
  } else if (hasGuard) {
    // No transaction available: evaluate guard outside transaction (TOCTOU possible but rare)
    const guardResult = await evaluateGuard(
      db,
      mutation.resource,
      mutation.id,
      mutation.if!,
      schema,
      namespace,
    );

    if (!guardResult.match) {
      await releasePermissionDirectoryTask();
      if (permissionDirectoryTaskId) {
        await reconcilePermissionDirectoryAfterCommit();
      }
      const result: MutationResult = {
        ok: false,
        mutationId: effectiveMutationId,
        affectedIds: [],
        errors: [
          {
            code: "CONFLICT",
            message: "Guard condition not met",
            path: "if",
            retryable: false,
          },
        ],
        deduped: false,
      };
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(
          mutation.clientId,
          mutation.mutationId,
          result,
        );
      }
      return result;
    }
  }

  // Relation delete policies may update or cascade through several records.
  // Keep those effects, the parent delete, and their change records atomic
  // even when the caller did not supply a guard.
  if (!hasGuard && hasTransaction) {
    let txMutationResult: MutationResult | null = null;
    try {
      await changeTracking.ensureReady();
      await (db as any).transaction(async (txDb: Adapter) => {
        txMutationResult = await executeMutationCore(
          mutation,
          txDb,
          schema,
          namespace,
          effectiveMutationId,
          changeTracking.withDb(txDb),
          actorId,
          logger,
          multiRegionRuntime,
        );
        if (txMutationResult.ok && shouldQueuePermissionDirectorySync) {
          await queuePermissionDirectorySync(txDb);
        }
        if (!txMutationResult.ok) {
          throw { __datafnMutationFailed: true };
        }
      });
    } catch (err: any) {
      if (!err?.__datafnMutationFailed) {
        txMutationResult = {
          ok: false,
          mutationId: effectiveMutationId,
          affectedIds: [],
          errors: [{ code: "INTERNAL", message: err?.message || "Transaction failed", path: "$", retryable: false }],
          deduped: false,
        };
      }
    }

    if (txMutationResult) {
      await releasePermissionDirectoryTask();
      if ((txMutationResult as MutationResult).ok) {
        await reconcilePermissionDirectoryAfterCommit();
      } else if (mutation.operation === "unshare") {
        await syncPermissionDirectoryAfterCommit(db);
      }
      if (searchProvider && (txMutationResult as MutationResult).ok) {
        await tryUpdateSearchIndex(searchProvider, mutation, db, namespace, logger, multiRegionRuntime);
      }
      if (mutation.clientId && mutation.mutationId) {
        await idempotencyStore.set(mutation.clientId, mutation.mutationId, txMutationResult as MutationResult);
      }
      return txMutationResult as MutationResult;
    }
  }

  // REL-011: Execute operation + change tracking using executeMutationCore.
  // changeTracking.withDb(db) ensures the change tracking uses the same db as the
  // operation — when db is a tx adapter (from transact.ts), both are in the transaction.
  if (shouldQueuePermissionDirectorySync && !insideTransaction) {
    // Non-transactional adapters cannot atomically insert the grant and its
    // retry task. Persist the retry first so a committed grant is never left
    // without durable reconciliation if the next write fails.
    await queuePermissionDirectorySync(db, true);
  }

  let result: MutationResult;
  try {
    result = await executeMutationCore(
      mutation,
      db,
      schema,
      namespace,
      effectiveMutationId,
      changeTracking.withDb(db),
      actorId,
      logger,
      multiRegionRuntime,
    );
  } catch (error) {
    await releasePermissionDirectoryTask();
    throw error;
  }

  const failedShareCompensation = (result as InternalMutationResult)[
    FAILED_SHARE_COMPENSATION_RESULT
  ];
  if (!result.ok && mutation.operation === "share") {
    if (
      failedShareCompensation &&
      permissionDirectoryTaskId &&
      multiRegionRuntime
    ) {
      permissionDirectoryTaskId = await deferFailedShareCompensation(
        db,
        permissionDirectoryTaskId,
        mutation,
        failedShareCompensation.snapshot,
        failedShareCompensation.error,
        namespace,
        multiRegionRuntime.regionId,
      );
      permissionDirectoryTaskPending = false;
    } else if (permissionDirectoryTaskId) {
      const discarded = await discardPermissionDirectorySync(
        db,
        permissionDirectoryTaskId,
      )
        .catch((error) => {
          logger?.error("Failed share directory task could not be discarded", {
            error: String(error),
            operation: mutation.operation,
            resource: mutation.resource,
            taskId: permissionDirectoryTaskId,
          });
          return false;
        });
      permissionDirectoryTaskId = discarded || !multiRegionRuntime
        ? null
        : await enqueuePermissionDirectorySyncDurably(
            db,
            mutation,
            namespace,
            multiRegionRuntime.regionId,
          );
      permissionDirectoryTaskPending = false;
    }
  } else {
    await releasePermissionDirectoryTask();
  }

  if (result.ok) {
    if (insideTransaction && shouldQueuePermissionDirectorySync) {
      await queuePermissionDirectorySync(db);
    }
    await reconcilePermissionDirectoryAfterCommit();
  } else if (
    permissionDirectoryTaskId ||
    (multiRegionRuntime && mutation.operation === "unshare")
  ) {
    // Clear or repair against settled authoritative state. Outer transact
    // calls must defer this work until their enclosing transaction resolves.
    if (insideTransaction && deferPermissionDirectorySync) {
      await reconcilePermissionDirectoryAfterCommit();
    } else {
      await syncPermissionDirectoryAfterCommit();
    }
  }

  if (searchProvider && result.ok) {
    await tryUpdateSearchIndex(searchProvider, mutation, db, namespace, logger, multiRegionRuntime);
  }

  // Store for idempotency only when IDs were provided
  if (mutation.clientId && mutation.mutationId) {
    await idempotencyStore.set(mutation.clientId, mutation.mutationId, result);
  }

  return result;
}
