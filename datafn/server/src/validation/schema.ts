/**
 * Schema validation primitives and index for DFQL validation
 * Centralizes all schema-bounded lookups to eliminate duplication
 */

import type { DatafnSchema, DatafnResourceSchema, DatafnRelationSchema } from "../core-types.js";
import type { DatafnErrorCode } from "../core-types.js";
import {
  resolveCapabilities,
  getCapabilityFields,
  buildSchemaIndex as buildCoreSchemaIndex,
} from "@datafn/core";

interface CoreSchemaIndexLike {
  resourcesByName: Map<string, DatafnResourceSchema>;
  relationsFromResource: Map<string, DatafnRelationSchema[]>;
}

/**
 * Validation error type - compatible with DatafnError
 */
export type ValidationError = {
  code: DatafnErrorCode;
  message: string;
  path: string;
  details?: Record<string, unknown>;
};

/**
 * Validation result - either success with result or failure with error.
 * Uses "result" to align with DatafnEnvelope naming.
 */
export type ValidationResult<T = void> =
  | { ok: true; result: T }
  | { ok: false; error: ValidationError };

/**
 * Create a successful validation result
 */
export function vOk<T>(value: T): ValidationResult<T> {
  return { ok: true, result: value };
}

/**
 * Create a failed validation result
 */
export function vErr(
  code: DatafnErrorCode,
  message: string,
  path: string,
  details?: Record<string, unknown>,
): ValidationResult<never> {
  return { ok: false, error: { code, message, path, details } };
}

/**
 * Server schema index — extends core's SchemaIndex with server-specific validation maps.
 * fieldsByResource and relationsByResource use Set<string> for fast name-based lookups,
 * while the underlying core index provides richer Map/array structures.
 */
export interface SchemaIndex
  extends Omit<CoreSchemaIndexLike, "fieldsByResource" | "relationsByResource"> {
  schema: DatafnSchema;
  /** All field names (schema-defined + capability-injected + id) per resource. */
  fieldsByResource: Map<string, Set<string>>;
  /** Writable field names per resource. */
  writableFieldsByResource: Map<string, Set<string>>;
  /** All relation names (forward + inverse) per resource. */
  relationsByResource: Map<string, Set<string>>;
}

/**
 * Build a server schema index by extending core's buildSchemaIndex with
 * server-specific validation maps (Set-based field/relation name lookups,
 * writable field tracking).
 */
export function buildSchemaIndex(schema: DatafnSchema): SchemaIndex {
  // Delegate to core for resourcesByName and relationsFromResource
  const coreIndex = buildCoreSchemaIndex(schema) as unknown as CoreSchemaIndexLike;

  const fieldsByResource = new Map<string, Set<string>>();
  const writableFieldsByResource = new Map<string, Set<string>>();
  const relationsByResource = new Map<string, Set<string>>();

  for (const resource of schema.resources) {
    const resolvedCapabilities = resolveCapabilities(
      schema.capabilities as any,
      resource.capabilities as any,
    );
    const capabilityFields = getCapabilityFields(resolvedCapabilities as any);
    const allFields = new Set<string>();
    const writableFields = new Set<string>();
    allFields.add("id");
    writableFields.add("id");

    for (const capabilityField of capabilityFields) {
      allFields.add(capabilityField.name);
      if (!capabilityField.readonly) {
        writableFields.add(capabilityField.name);
      }
    }

    for (const field of resource.fields) {
      allFields.add(field.name);
      if (!field.readonly) {
        writableFields.add(field.name);
      }
    }

    fieldsByResource.set(resource.name, allFields);
    writableFieldsByResource.set(resource.name, writableFields);
    relationsByResource.set(resource.name, new Set());
  }

  // Fix 1: Add FK fields from many-one relations to fieldsByResource and writableFieldsByResource
  // so mutations that include FK fields (e.g. catId, goalId) are accepted.
  if (schema.relations) {
    for (const rel of schema.relations) {
      if (rel.type === "many-one") {
        const fromResources = Array.isArray(rel.from) ? rel.from : [rel.from];
        for (const fromRes of fromResources) {
          const fkField = (rel as any).fkField || (rel as any).foreignKey || `${rel.relation}Id`;
          fieldsByResource.get(fromRes)?.add(fkField);
          writableFieldsByResource.get(fromRes)?.add(fkField);
        }
      }
    }
  }

  if (schema.relations) {
    for (const rel of schema.relations) {
      const fromResources = Array.isArray(rel.from) ? rel.from : [rel.from];
      const toResources = Array.isArray(rel.to) ? rel.to : [rel.to];

      for (const fromRes of fromResources) {
        if (rel.relation) {
          relationsByResource.get(fromRes)?.add(rel.relation);
        }
      }

      for (const toRes of toResources) {
        if (rel.inverse) {
          relationsByResource.get(toRes)?.add(rel.inverse);
        }
      }
    }
  }

  return {
    schema,
    resourcesByName: coreIndex.resourcesByName,
    relationsFromResource: coreIndex.relationsFromResource,
    fieldsByResource,
    writableFieldsByResource,
    relationsByResource,
  };
}

/**
 * Get a resource by name, returning validation error if not found
 */
export function getResource(
  index: SchemaIndex,
  resourceName: string,
  path: string,
): ValidationResult<DatafnResourceSchema> {
  const resource = index.resourcesByName.get(resourceName);
  if (!resource) {
    return vErr("DFQL_UNKNOWN_RESOURCE", `Unknown resource: ${resourceName}`, path);
  }
  return vOk(resource);
}

/**
 * Validate that a field exists on a resource
 */
export function validateFieldName(
  index: SchemaIndex,
  resourceName: string,
  fieldName: string,
  path: string,
): ValidationResult<void> {
  const fields = index.fieldsByResource.get(resourceName);
  if (!fields) {
    return vErr("DFQL_UNKNOWN_RESOURCE", `Unknown resource: ${resourceName}`, path);
  }
  if (!fields.has(fieldName)) {
    return vErr("DFQL_UNKNOWN_FIELD", `Unknown field: ${fieldName}`, path);
  }
  return vOk(undefined);
}

/**
 * Validate that a field is writable on a resource
 */
export function validateWritableField(
  index: SchemaIndex,
  resourceName: string,
  fieldName: string,
  path: string,
): ValidationResult<void> {
  const fields = index.fieldsByResource.get(resourceName);
  if (!fields) {
    return vErr("DFQL_UNKNOWN_RESOURCE", `Unknown resource: ${resourceName}`, path);
  }
  if (!fields.has(fieldName)) {
    return vErr("DFQL_UNKNOWN_FIELD", `Unknown field: ${fieldName}`, path);
  }
  const writableFields = index.writableFieldsByResource.get(resourceName);
  if (!writableFields?.has(fieldName)) {
    return vErr("DFQL_INVALID", `Field is read-only: ${fieldName}`, path);
  }
  return vOk(undefined);
}

/**
 * Validate that a relation exists on a resource
 */
export function validateRelationName(
  index: SchemaIndex,
  resourceName: string,
  relationName: string,
  path: string,
): ValidationResult<void> {
  const relations = index.relationsByResource.get(resourceName);
  if (!relations) {
    return vErr("DFQL_UNKNOWN_RESOURCE", `Unknown resource: ${resourceName}`, path);
  }
  if (!relations.has(relationName)) {
    return vErr("DFQL_UNKNOWN_RELATION", `Unknown relation: ${relationName}`, path);
  }
  return vOk(undefined);
}

/**
 * Check if a name is a field or relation on a resource
 */
export function isFieldOrRelation(
  index: SchemaIndex,
  resourceName: string,
  name: string,
): "field" | "relation" | null {
  const fields = index.fieldsByResource.get(resourceName);
  const relations = index.relationsByResource.get(resourceName);
  
  if (fields?.has(name)) return "field";
  if (relations?.has(name)) return "relation";
  return null;
}

/**
 * Get target resource for a relation
 */
export function getRelationTarget(
  index: SchemaIndex,
  resourceName: string,
  relationName: string,
): string | null {
  const relations = index.schema.relations || [];
  for (const rel of relations) {
    const fromResources = Array.isArray(rel.from) ? rel.from : [rel.from];
    const toResources = Array.isArray(rel.to) ? rel.to : [rel.to];

    // Check forward relation
    if (fromResources.includes(resourceName) && rel.relation === relationName) {
      return typeof rel.to === "string" ? rel.to : (rel.to[0] ?? null);
    }
    // Check inverse relation
    if (toResources.includes(resourceName) && rel.inverse === relationName) {
      return typeof rel.from === "string" ? rel.from : (rel.from[0] ?? null);
    }
  }
  return null;
}

/**
 * Get relation definition for a relation name
 */
export function getRelation(
  index: SchemaIndex,
  resourceName: string,
  relationName: string,
): DatafnRelationSchema | null {
  const relations = index.schema.relations || [];
  for (const rel of relations) {
    const fromResources = Array.isArray(rel.from) ? rel.from : [rel.from];
    const toResources = Array.isArray(rel.to) ? rel.to : [rel.to];

    if (fromResources.includes(resourceName) && rel.relation === relationName) {
      return rel;
    }
    if (toResources.includes(resourceName) && rel.inverse === relationName) {
      return rel;
    }
  }
  return null;
}

/**
 * Validate record keys against schema fields
 * Mode: 'write' validates writable fields, 'read' validates all fields
 */
export function validateRecordKeys(
  index: SchemaIndex,
  resourceName: string,
  record: Record<string, unknown>,
  basePath: string,
  mode: "write" | "read" = "write",
): ValidationResult<void> {
  const fields =
    mode === "write"
      ? index.writableFieldsByResource.get(resourceName)
      : index.fieldsByResource.get(resourceName);

  if (!fields) {
    return vErr("DFQL_UNKNOWN_RESOURCE", `Unknown resource: ${resourceName}`, basePath);
  }

  for (const key of Object.keys(record)) {
    // Skip id field for record validation (it's passed separately)
    if (key === "id") continue;
    
    if (!fields.has(key)) {
      if (mode === "write" && index.fieldsByResource.get(resourceName)?.has(key)) {
        return vErr(
          "DFQL_INVALID",
          `Field is read-only: ${key} on ${resourceName}`,
          `${basePath}.${key}`,
        );
      }
      return vErr(
        "DFQL_UNKNOWN_FIELD",
        `Unknown field: ${key} on ${resourceName}`,
        `${basePath}.${key}`,
      );
    }
  }

  return vOk(undefined);
}

/**
 * Helper to join paths
 */
export function joinPath(...parts: (string | number | undefined)[]): string {
  return parts
    .filter((p) => p !== undefined && p !== "")
    .map((p, i) => {
      if (typeof p === "number") return `[${p}]`;
      const s = String(p);
      if (i === 0) return s;
      if (s.startsWith("[")) return s;
      return `.${s}`;
    })
    .join("")
    .replace(/^\./g, "");
}
