/**
 * Mutation validation for DFQL
 * Validates mutations before execution to ensure schema-bounded correctness
 */

import type { SchemaIndex, ValidationResult, ValidationError } from "./schema.js";
import { resolveCapabilities } from "@datafn/core";
import type { CapabilityEntry, ShareableCapability } from "@datafn/core";
import {
  vOk,
  vErr,
  getResource,
  validateRecordKeys,
  validateRelationName,
  getRelation,
} from "./schema.js";
import {
  checkPrototypePollution,
  validateFieldValue,
  toBoundsEpochMs,
  formatBoundEpochMs,
} from "@datafn/core";

/**
 * Options for mutation validation (VAL-006 through VAL-009)
 */
export interface MutationValidationOpts {
  /** VAL-006: Max ID field length (default 255) */
  maxIdLength?: number;
  /** VAL-009: Debug mode - when false, messages are generic */
  debug?: boolean;
}

/**
 * Valid mutation operations
 */
const VALID_OPERATIONS = new Set([
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
]);

/**
 * Operations that require a record
 */
const RECORD_REQUIRED_OPERATIONS = new Set(["insert", "merge", "replace"]);

type ShareScope = "record" | "resource";

const DFQL_SHARE_SCOPE_INVALID_CODE = "DFQL_SHARE_SCOPE_INVALID" as any;
const DFQL_PRINCIPAL_INVALID_CODE = "DFQL_PRINCIPAL_INVALID" as any;

function isShareableCapability(entry: CapabilityEntry): entry is ShareableCapability {
  return typeof entry === "object" && entry !== null && "shareable" in entry;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canonicalizePrincipalFromUserId(userId: string): string {
  return userId.includes(":") ? userId : `user:${userId}`;
}

/**
 * Validate a single mutation against the schema
 */
export function validateMutation(
  mutation: unknown,
  index: SchemaIndex,
  basePath: string = "$",
  opts?: MutationValidationOpts,
): ValidationResult<void> {
  // Must be object
  if (typeof mutation !== "object" || mutation === null || Array.isArray(mutation)) {
    return vErr("DFQL_INVALID", "Invalid DFQL: mutation must be object", basePath);
  }

  const m = mutation as Record<string, unknown>;

  // SEC-008: Prototype pollution check on the entire mutation object
  const pollutionCheck = checkPrototypePollution(m);
  if (!pollutionCheck.ok) {
    return vErr("DFQL_INVALID", `Disallowed key: ${pollutionCheck.key}`, basePath);
  }

  // Validate resource exists
  if (typeof m.resource !== "string") {
    return vErr("DFQL_INVALID", "Invalid DFQL: resource must be string", `${basePath}.resource`);
  }

  const resourceResult = getResource(index, m.resource, `${basePath}.resource`);
  if (!resourceResult.ok) {
    return resourceResult;
  }

  // Validate operation
  if (typeof m.operation !== "string") {
    return vErr("DFQL_INVALID", "Invalid DFQL: operation must be string", `${basePath}.operation`);
  }

  if (!VALID_OPERATIONS.has(m.operation)) {
    return vErr(
      "DFQL_UNSUPPORTED",
      `Unsupported DFQL feature: mutation.operation.${m.operation}`,
      `${basePath}.operation`,
    );
  }

  // VAL-007: clientId validation
  if (m.clientId !== undefined) {
    if (typeof m.clientId !== "string" || m.clientId.length === 0) {
      return vErr("DFQL_INVALID", "Invalid DFQL: clientId must be a non-empty string", `${basePath}.clientId`);
    }
    if (m.clientId.length > 255) {
      return vErr("DFQL_INVALID", "clientId exceeds maximum length (255)", `${basePath}.clientId`);
    }
  }

  // VAL-007: mutationId validation
  if (m.mutationId !== undefined) {
    if (typeof m.mutationId !== "string" || m.mutationId.length === 0) {
      return vErr("DFQL_INVALID", "Invalid DFQL: mutationId must be a non-empty string", `${basePath}.mutationId`);
    }
    if (m.mutationId.length > 255) {
      return vErr("DFQL_INVALID", "mutationId exceeds maximum length (255)", `${basePath}.mutationId`);
    }
  }

  // VAL-008: version field validation (accept numeric string for compat)
  if (m.version !== undefined) {
    const versionNum =
      typeof m.version === "string" ? Number(m.version) : m.version;
    if (
      (typeof m.version !== "number" && typeof m.version !== "string") ||
      isNaN(versionNum as number) ||
      !Number.isInteger(versionNum) ||
      (versionNum as number) <= 0
    ) {
      return vErr("DFQL_INVALID", "Invalid DFQL: version must be a positive integer", `${basePath}.version`);
    }
  }

  // Validate id prefix if defined in schema
  const resource = resourceResult.result;
  const resolvedCapabilities = resolveCapabilities(
    index.schema.capabilities as any,
    resource.capabilities as any,
  );
  const hasTrashCapability = resolvedCapabilities.some(
    (capability: unknown) => capability === "trash",
  );
  const hasArchivableCapability = resolvedCapabilities.some(
    (capability: unknown) => capability === "archivable",
  );
  const shareableCapability = resolvedCapabilities.find(isShareableCapability);
  const isShareOperation = m.operation === "share" || m.operation === "unshare";

  if ((m.operation === "trash" || m.operation === "restore") && !hasTrashCapability) {
    return vErr(
      "DFQL_UNSUPPORTED",
      `Unsupported DFQL feature: mutation.operation.${m.operation}`,
      `${basePath}.operation`,
    );
  }
  if (
    (m.operation === "archive" || m.operation === "unarchive") &&
    !hasArchivableCapability
  ) {
    return vErr(
      "DFQL_UNSUPPORTED",
      `Unsupported DFQL feature: mutation.operation.${m.operation}`,
      `${basePath}.operation`,
    );
  }
  if (isShareOperation && !shareableCapability) {
    return vErr(
      "DFQL_UNSUPPORTED",
      `Unsupported DFQL feature: mutation.operation.${m.operation}`,
      `${basePath}.operation`,
    );
  }

  // VAL-006: ID length limit
  const maxIdLength = opts?.maxIdLength ?? 255;

  if (isShareOperation) {
    if (typeof m.shareWith !== "object" || m.shareWith === null || Array.isArray(m.shareWith)) {
      return vErr(
        "DFQL_INVALID",
        "Invalid DFQL: shareWith must be object",
        `${basePath}.shareWith`,
      );
    }

    const scopeValue = m.scope;
    let scope: ShareScope = "record";
    if (scopeValue !== undefined) {
      if (scopeValue !== "record" && scopeValue !== "resource") {
        return vErr(
          DFQL_SHARE_SCOPE_INVALID_CODE,
          "scope must be either record or resource",
          `${basePath}.scope`,
        );
      }
      scope = scopeValue;
    } else {
      m.scope = "record";
    }

    if (scope === "resource" && shareableCapability && shareableCapability.shareable.supportsScopeGrants === false) {
      return vErr(
        "DFQL_UNSUPPORTED",
        "Unsupported DFQL feature: mutation.scope.resource",
        `${basePath}.scope`,
      );
    }

    if (scope === "resource") {
      if (m.id !== undefined) {
        return vErr(
          DFQL_SHARE_SCOPE_INVALID_CODE,
          "resource scope share must omit id",
          `${basePath}.id`,
        );
      }
    } else {
      if (typeof m.id !== "string") {
        return vErr("DFQL_INVALID", "Invalid DFQL: id must be string", `${basePath}.id`);
      }
      if (m.id.length > maxIdLength) {
        return vErr(
          "DFQL_INVALID",
          `ID exceeds maximum length (${maxIdLength})`,
          `${basePath}.id`,
        );
      }
      if (resource.idPrefix && !m.id.startsWith(resource.idPrefix)) {
        return vErr(
          "DFQL_INVALID",
          `Invalid id: must start with "${resource.idPrefix}"`,
          `${basePath}.id`,
        );
      }
    }

    const shareWith = m.shareWith as Record<string, unknown>;
    const principalId = normalizeNonEmptyString(shareWith.principalId);
    const userId = normalizeNonEmptyString(shareWith.userId);

    if (shareWith.principalId !== undefined && principalId === null) {
      return vErr(
        DFQL_PRINCIPAL_INVALID_CODE,
        "principalId must be non-empty string",
        `${basePath}.shareWith.principalId`,
      );
    }
    if (shareWith.userId !== undefined && userId === null) {
      return vErr(
        DFQL_PRINCIPAL_INVALID_CODE,
        "userId must be non-empty string",
        `${basePath}.shareWith.userId`,
      );
    }
    if (principalId && userId) {
      return vErr(
        DFQL_PRINCIPAL_INVALID_CODE,
        "Provide only one of shareWith.userId or shareWith.principalId",
        `${basePath}.shareWith`,
      );
    }
    if (!principalId && !userId) {
      return vErr(
        DFQL_PRINCIPAL_INVALID_CODE,
        "Either shareWith.userId or shareWith.principalId is required",
        `${basePath}.shareWith`,
      );
    }

    const canonicalPrincipalId = principalId ?? canonicalizePrincipalFromUserId(userId as string);
    const level = shareWith.level;
    if (userId && !principalId) {
      m.shareWith = level === undefined
        ? { principalId: canonicalPrincipalId, userId }
        : { principalId: canonicalPrincipalId, userId, level };
    } else {
      m.shareWith = level === undefined
        ? { principalId: canonicalPrincipalId }
        : { principalId: canonicalPrincipalId, level };
    }

    if (m.operation === "share" && level !== undefined) {
      if (typeof shareWith.level !== "string") {
        return vErr(
          "DFQL_INVALID",
          "Invalid DFQL: shareWith.level must be string",
          `${basePath}.shareWith.level`,
        );
      }
      const allowedLevels = shareableCapability?.shareable.levels ?? [];
      if (!allowedLevels.some((candidate) => candidate === shareWith.level)) {
        return vErr(
          "DFQL_INVALID",
          `Invalid DFQL: shareWith.level must be one of [${allowedLevels.join(", ")}]`,
          `${basePath}.shareWith.level`,
        );
      }
    }
  } else {
    if (typeof m.id !== "string") {
      return vErr("DFQL_INVALID", "Invalid DFQL: id must be string", `${basePath}.id`);
    }
    if (m.id.length > maxIdLength) {
      return vErr(
        "DFQL_INVALID",
        `ID exceeds maximum length (${maxIdLength})`,
        `${basePath}.id`,
      );
    }
    if (resource.idPrefix && !m.id.startsWith(resource.idPrefix)) {
      return vErr(
        "DFQL_INVALID",
        `Invalid id: must start with "${resource.idPrefix}"`,
        `${basePath}.id`,
      );
    }
  }

  // Validate record for operations that require it
  if (RECORD_REQUIRED_OPERATIONS.has(m.operation)) {
    if (m.record === undefined) {
      return vErr(
        "DFQL_INVALID",
        `Invalid DFQL: ${m.operation} requires record`,
        `${basePath}.record`,
      );
    }

    if (typeof m.record !== "object" || m.record === null || Array.isArray(m.record)) {
      return vErr("DFQL_INVALID", "Invalid DFQL: record must be object", `${basePath}.record`);
    }

    // Validate record keys against schema
    const recordResult = validateRecordKeys(
      index,
      m.resource,
      m.record as Record<string, unknown>,
      `${basePath}.record`,
      "write",
    );
    if (!recordResult.ok) {
      return recordResult;
    }

    // SEC-005: Validate field value types against schema
    const record = m.record as Record<string, unknown>;
    for (const [fieldName, value] of Object.entries(record)) {
      if (fieldName === "id") continue; // id is always a string, validated elsewhere
      const fieldDef = resource.fields.find((f) => f.name === fieldName);
      if (!fieldDef) continue; // Unknown fields handled by validateRecordKeys
      if (value === undefined) continue; // undefined means not provided
      const typeResult = validateFieldValue(fieldDef.type, value, fieldDef.nullable ?? false);
      if (!typeResult.ok) {
        return vErr(
          "DFQL_INVALID",
          `Field '${fieldName}' expects ${fieldDef.type}, got ${typeResult.error!.split("got ")[1] || "invalid"}`,
          `${basePath}.record.${fieldName}`,
        );
      }
      // Enforce min/max bounds for date fields by comparing epoch milliseconds.
      if (
        fieldDef.type === "date" &&
        (fieldDef.min !== undefined || fieldDef.max !== undefined)
      ) {
        // Timezone-less ISO datetimes compare as UTC so absolute bounds do
        // not depend on the server's local timezone.
        const epoch = toBoundsEpochMs(value);
        // Non-finite epochs are e2ee envelopes or already rejected above.
        if (Number.isFinite(epoch)) {
          if (fieldDef.min !== undefined && epoch < fieldDef.min) {
            return vErr(
              "DFQL_INVALID",
              `Field '${fieldName}' must be on or after ${formatBoundEpochMs(fieldDef.min)}`,
              `${basePath}.record.${fieldName}`,
            );
          }
          if (fieldDef.max !== undefined && epoch > fieldDef.max) {
            return vErr(
              "DFQL_INVALID",
              `Field '${fieldName}' must be on or before ${formatBoundEpochMs(fieldDef.max)}`,
              `${basePath}.record.${fieldName}`,
            );
          }
        }
      }
    }

    // Check required fields for insert/replace
    if (m.operation === "insert" || m.operation === "replace") {
        const resource = resourceResult.result;
        const record = m.record as Record<string, unknown>;
        for (const field of resource.fields) {
            if (field.required && field.default === undefined && field.name !== "id" && !field.readonly) {
                // If required, no default, not id, not readonly (system)
                // Must be present
                if (
                  !(field.name in record) ||
                  record[field.name] === undefined ||
                  (record[field.name] === null && !field.nullable)
                ) {
                     return vErr(
                        "DFQL_INVALID",
                        `Required field missing: ${field.name}`,
                        `${basePath}.record.${field.name}`,
                      );
                }
            }
        }
    }
  }

  // Validate if guard fields
  if (m.if !== undefined) {
    if (typeof m.if !== "object" || m.if === null || Array.isArray(m.if)) {
      return vErr("DFQL_INVALID", "Invalid DFQL: if must be object", `${basePath}.if`);
    }

    // Validate if fields against schema (guards can reference any readable field)
    const ifResult = validateRecordKeys(
      index,
      m.resource,
      m.if as Record<string, unknown>,
      `${basePath}.if`,
      "read",
    );
    if (!ifResult.ok) {
      return ifResult;
    }
  }

  // Validate relations object for relate/modifyRelation/unrelate
  if (m.relations !== undefined) {
    if (typeof m.relations !== "object" || m.relations === null || Array.isArray(m.relations)) {
      return vErr("DFQL_INVALID", "Invalid DFQL: relations must be object", `${basePath}.relations`);
    }

    const relations = m.relations as Record<string, unknown>;
    for (const relationName of Object.keys(relations)) {
      // Validate relation exists
      const relResult = validateRelationName(
        index,
        m.resource,
        relationName,
        `${basePath}.relations.${relationName}`,
      );
      if (!relResult.ok) {
        return relResult;
      }

      // Validate relation metadata keys if present
      const relationValue = relations[relationName];
      const relDef = getRelation(index, m.resource, relationName);
      
      if (relDef) {
        // Normalize to array for validation
        const items = Array.isArray(relationValue) ? relationValue : [relationValue];
        
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemPath = Array.isArray(relationValue) 
            ? `${basePath}.relations.${relationName}[${i}]`
            : `${basePath}.relations.${relationName}`;

          if (typeof item === "object" && item !== null) {
            const allowedMetaKeys = new Set(relDef.metadata?.map((m) => m.name) || []);
            allowedMetaKeys.add("$ref"); // $ref is always allowed
            const fromResources = Array.isArray(relDef.from) ? relDef.from : [relDef.from];
            const toResources = Array.isArray(relDef.to) ? relDef.to : [relDef.to];
            if (relDef.type === "many-many" && fromResources.length > 1) {
              allowedMetaKeys.add("fromResource");
            }
            if (relDef.type === "many-many" && toResources.length > 1) {
              allowedMetaKeys.add("toResource");
            }
            
            for (const key of Object.keys(item as Record<string, unknown>)) {
              if (!allowedMetaKeys.has(key)) {
                return vErr(
                  "DFQL_UNKNOWN_FIELD",
                  `Unknown relation metadata key: ${key}`,
                  `${itemPath}.${key}`,
                );
              }
            }
          }
        }
      }
    }
  }

  return vOk(undefined);
}

/**
 * Validate mutation body (single or batch)
 */
export function validateMutationBody(
  body: unknown,
  index: SchemaIndex,
  opts?: MutationValidationOpts,
): ValidationResult<{ isBatch: boolean; mutations: Record<string, unknown>[] }> {
  if (typeof body !== "object" || body === null) {
    return vErr("DFQL_INVALID", "Invalid DFQL: expected object or array", "$");
  }

  const isBatch = Array.isArray(body);
  const mutations = isBatch ? (body as unknown[]) : [body];

  for (let i = 0; i < mutations.length; i++) {
    const path = isBatch ? `$[${i}]` : "$";
    const result = validateMutation(mutations[i], index, path, opts);
    if (!result.ok) {
      // Add index to error for batch operations
      if (isBatch) {
        return {
          ok: false,
          error: {
            ...result.error,
            path: result.error.path,
          },
        };
      }
      return result;
    }
  }

  return vOk({
    isBatch,
    mutations: mutations as Record<string, unknown>[],
  });
}

/**
 * Validate mutations for push operation
 * Returns all validation errors (not fail-fast) for batch reporting
 */
export function validatePushMutations(
  mutations: unknown[],
  index: SchemaIndex,
  opts?: MutationValidationOpts,
): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    const result = validateMutation(mutation, index, `mutations[${i}]`, opts);
    if (!result.ok) {
      errors.push(result.error);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
