import type { DatafnSchema } from "../../core-types.js";
import { resolveCapabilities } from "@datafn/core";

/**
 * DFQL mutation type definitions
 */

export type MutationOperation =
  | "insert"
  | "merge"
  | "replace"
  | "delete"
  | "trash"
  | "restore"
  | "archive"
  | "unarchive"
  | "share"
  | "unshare"
  | "relate"
  | "modifyRelation"
  | "unrelate";

export interface DFQLMutation {
  resource: string;
  version: number;
  operation: MutationOperation;
  clientId: string;
  mutationId: string;
  id: string;
  record?: Record<string, unknown>;
  scope?: "record" | "resource";
  shareWith?: {
    principalId?: string;
    userId?: string;
    level?: string;
  };
  if?: Record<string, unknown>; // Optimistic concurrency guard
  relations?: Record<string, unknown>; // Relation operations payload
}

export interface RelationOperation {
  $ref: string; // Target record ID
  [key: string]: unknown; // Metadata fields
}

/**
 * Build a full record for replace operation
 * Clears unspecified fields to their default or null, and preserves system fields
 */
export function buildReplaceRecord(
  schema: DatafnSchema,
  resourceName: string,
  existingRecord: Record<string, unknown>,
  newRecord: Record<string, unknown>,
  resolvedCapabilities?: unknown[],
): {
  ok: true;
  record: Record<string, unknown>;
} | {
  ok: false;
  code: string;
  message: string;
  path: string;
} {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) {
    return {
      ok: false,
      code: "DFQL_UNKNOWN_RESOURCE",
      message: `Unknown resource: ${resourceName}`,
      path: "resource",
    };
  }

  const result: Record<string, unknown> = {};
  const caps =
    resolvedCapabilities ??
    resolveCapabilities(
      schema.capabilities as any,
      resource.capabilities as any,
    );
  const hasTimestamps = caps.some((entry: unknown) => entry === "timestamps");
  const hasAudit = caps.some((entry: unknown) => entry === "audit");

  for (const field of resource.fields) {
    const key = field.name;

    // ID and immutable capability fields are always preserved on replace.
    if (key === "id") {
      result[key] = existingRecord[key];
      continue;
    }
    if (hasTimestamps && key === "createdAt") {
      result[key] = existingRecord[key];
      continue;
    }
    if (hasAudit && key === "createdBy") {
      result[key] = existingRecord[key];
      continue;
    }

    // Readonly fields are rejected by write validation, so clients cannot
    // supply them in a replacement. Carry the stored value forward instead
    // of clearing it to null/default. A key already present in newRecord is
    // server-injected (e.g. injectCapabilityFieldsOnUpdate sets updatedAt),
    // so it wins.
    if (field.readonly) {
      result[key] = Object.prototype.hasOwnProperty.call(newRecord, key)
        ? newRecord[key]
        : existingRecord[key];
      continue;
    }

    // Normal fields
    if (Object.prototype.hasOwnProperty.call(newRecord, key)) {
      result[key] = newRecord[key];
    } else {
      // Not provided: reset to the default, otherwise clear with null. Null is
      // the only clear every supported adapter persists (Drizzle and Prisma
      // ignore undefined) and the only one that survives JSON change tracking;
      // read paths normalize it back to undefined for non-nullable fields.
      result[key] = field.default !== undefined ? field.default : null;
    }

    // Validation: Required check
    // If required, undefined is always missing and null is missing unless allowed.
    // Note: boolean false or number 0 are valid.
    if (
      field.required &&
      (result[key] === undefined ||
        (result[key] === null && !field.nullable))
    ) {
      return {
        ok: false,
        code: "DFQL_INVALID",
        message: `Required field missing: ${key}`,
        path: `record.${key}`,
      };
    }
  }

  return { ok: true, record: result };
}
