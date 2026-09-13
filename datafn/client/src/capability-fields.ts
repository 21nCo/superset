import {
  findSystemFieldWrite,
  normalizeRelationFkRecord,
  resolveCapabilities,
  type DatafnSchema,
} from "@datafn/core";
import { createClientError } from "./errors.js";

type CapabilityMutationOp = "insert" | "merge" | "replace";

type CapabilityContext = {
  hasTimestamps: boolean;
  hasAudit: boolean;
  hasTrash: boolean;
};

function resolveCapabilityContext(
  schema: DatafnSchema,
  resourceName: string,
): CapabilityContext | null {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) return null;

  const resolved = resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );

  return {
    hasTimestamps: resolved.some((entry) => entry === "timestamps"),
    hasAudit: resolved.some((entry) => entry === "audit"),
    hasTrash: resolved.some((entry) => entry === "trash"),
  };
}

function stripReadonlyCapabilityFields(
  record: Record<string, unknown>,
  context: CapabilityContext,
): Record<string, unknown> {
  const next = { ...record };

  if (context.hasTimestamps) {
    delete next.createdAt;
    delete next.updatedAt;
  }
  if (context.hasAudit) {
    delete next.createdBy;
    delete next.updatedBy;
  }
  if (context.hasTrash) {
    delete next.trashedAt;
    delete next.trashedBy;
  }

  return next;
}

function isRecordOperation(operation: unknown): operation is CapabilityMutationOp {
  return operation === "insert" || operation === "merge" || operation === "replace";
}

function applySchemaDefaults(
  schema: DatafnSchema,
  resourceName: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource?.fields) return record;

  const next = { ...record };
  for (const field of resource.fields as readonly Record<string, unknown>[]) {
    const name = field.name;
    if (typeof name !== "string") continue;
    if (next[name] !== undefined) continue;
    if ("default" in field) {
      const defaultValue = field.default;
      if (Array.isArray(defaultValue)) {
        next[name] = [...defaultValue];
      } else if (
        defaultValue !== null &&
        typeof defaultValue === "object"
      ) {
        next[name] = { ...(defaultValue as Record<string, unknown>) };
      } else {
        next[name] = defaultValue;
      }
    }
  }
  return next;
}

/**
 * Throws DFQL_INVALID when a record mutation writes a DataFn system field
 * (e.g. `isAncestorInactive`) that only the runtime may maintain.
 */
export function assertNoSystemFieldWrite(
  schema: DatafnSchema | undefined,
  mutation: Record<string, unknown>,
): void {
  if (!schema) return;
  if (!isRecordOperation(mutation.operation)) return;
  if (typeof mutation.record !== "object" || mutation.record === null || Array.isArray(mutation.record)) {
    return;
  }
  const resourceName = mutation.resource;
  if (typeof resourceName !== "string") return;
  const systemField = findSystemFieldWrite(
    schema.relations,
    resourceName,
    mutation.record as Record<string, unknown>,
  );
  if (systemField) {
    throw createClientError(
      "DFQL_INVALID",
      `Field is read-only: ${systemField} on ${resourceName}`,
      { path: `record.${systemField}` },
    );
  }
}

export function sanitizeCapabilityReadonlyFields(
  schema: DatafnSchema | undefined,
  mutation: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return mutation;

  const operation = mutation.operation;
  if (!isRecordOperation(operation)) return mutation;

  if (typeof mutation.record !== "object" || mutation.record === null || Array.isArray(mutation.record)) {
    return mutation;
  }

  const resourceName = mutation.resource;
  if (typeof resourceName !== "string") return mutation;

  const context = resolveCapabilityContext(schema, resourceName);
  if (!context) return mutation;

  return {
    ...mutation,
    record: stripReadonlyCapabilityFields(
      normalizeRelationFkRecord(
        schema,
        resourceName,
        mutation.record as Record<string, unknown>,
      ),
      context,
    ),
  };
}

export function injectCapabilityFieldsForOptimisticRecord(
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
  opts: {
    timestampMs: number;
    actorId?: string;
    existingRecord?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  const operation = mutation.operation;
  if (!isRecordOperation(operation)) {
    return (mutation.record || {}) as Record<string, unknown>;
  }

  const resourceName = mutation.resource;
  if (typeof resourceName !== "string") {
    return (mutation.record || {}) as Record<string, unknown>;
  }

  const context = resolveCapabilityContext(schema, resourceName);
  if (!context) {
    return (mutation.record || {}) as Record<string, unknown>;
  }

  const base = stripReadonlyCapabilityFields(
    normalizeRelationFkRecord(
      schema,
      resourceName,
      (mutation.record || {}) as Record<string, unknown>,
    ),
    context,
  );
  const next = { ...base };

  if (operation === "insert") {
    const defaulted = applySchemaDefaults(schema, resourceName, next);
    if (context.hasTimestamps) {
      defaulted.createdAt = opts.timestampMs;
      defaulted.updatedAt = opts.timestampMs;
    }
    if (context.hasAudit) {
      defaulted.createdBy = opts.actorId ?? null;
      defaulted.updatedBy = opts.actorId ?? null;
    }
    return defaulted;
  }

  if (operation === "merge") {
    const defaulted = opts.existingRecord
      ? next
      : applySchemaDefaults(schema, resourceName, next);
    if (context.hasTimestamps) {
      if (!opts.existingRecord) {
        defaulted.createdAt = opts.timestampMs;
      }
      defaulted.updatedAt = opts.timestampMs;
    }
    if (context.hasAudit) {
      if (!opts.existingRecord) {
        defaulted.createdBy = opts.actorId ?? null;
      }
      defaulted.updatedBy = opts.actorId ?? null;
    }
    return defaulted;
  }

  // replace
  const existing = opts.existingRecord || null;
  const defaulted = applySchemaDefaults(schema, resourceName, next);
  if (context.hasTimestamps) {
    if (existing && existing.createdAt !== undefined) {
      defaulted.createdAt = existing.createdAt;
    }
    defaulted.updatedAt = opts.timestampMs;
  }
  if (context.hasAudit) {
    if (existing && existing.createdBy !== undefined) {
      defaulted.createdBy = existing.createdBy;
    }
    defaulted.updatedBy = opts.actorId ?? null;
  }
  return defaulted;
}
