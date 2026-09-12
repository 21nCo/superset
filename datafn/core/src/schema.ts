/**
 * Schema Validation
 *
 * Validates and normalizes DataFn schemas according to SCHEMA-001.
 */

import type {
  DatafnFieldSchema,
  DatafnRelationSchema,
  DatafnSchema,
  DatafnResourceSchema,
  DatafnDefaultPermissionsPolicy,
  DatafnRelationDeletePolicies,
  DatafnRelationIntegrityMode,
  RelationSimpleCapability,
} from "./types.js";
import type {
  CapabilityEntry,
  ResourceCapabilities,
  SchemaCapabilities,
  ShareableCapability,
  SimpleCapability,
} from "./capabilities.js";
import type { DatafnEnvelope } from "./errors.js";
import { ok, err } from "./errors.js";
import { validateFieldValue } from "./validate.js";
import { toBoundsEpochMs } from "./date.js";
import { isDatafnE2eeEnvelope } from "./e2ee.js";
import {
  CAPABILITY_FIELD_DEFS,
  getCapabilityFields,
  getRelationCapabilityFieldNames,
  resolveCapabilities,
} from "./capabilities.js";

const SIMPLE_CAPABILITIES: ReadonlySet<SimpleCapability> = new Set([
  "timestamps",
  "audit",
  "trash",
  "archivable",
]);

const SHAREABLE_LEVELS = new Set(["viewer", "editor", "owner"]);
const SHAREABLE_DEFAULTS = new Set(["private", "shared"]);
const SHAREABLE_VISIBILITY_DEFAULTS = new Set(["ns", "private", "shared"]);
const SHAREABLE_PRINCIPAL_MODES = new Set(["opaque-id"]);

const RELATION_SIMPLE_CAPABILITIES: ReadonlySet<RelationSimpleCapability> = new Set([
  "timestamps",
  "audit",
]);

const FIELD_TYPES: ReadonlySet<DatafnFieldSchema["type"]> = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "date",
  "file",
  "json",
]);

const RELATION_TYPES: ReadonlySet<DatafnRelationSchema["type"]> = new Set([
  "one-many",
  "many-one",
  "many-many",
  "htree",
]);

const RELATION_INTEGRITY_MODES: ReadonlySet<DatafnRelationIntegrityMode> = new Set([
  "application",
  "database",
]);

function validateDefaultPermissions(
  value: unknown,
): DatafnEnvelope<DatafnDefaultPermissionsPolicy | undefined> {
  if (value === undefined) return ok(undefined);
  if (value === "allResourceFields") return ok(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(
      "SCHEMA_INVALID",
      "Invalid schema: defaultPermissions must be allResourceFields or an object",
      { path: "defaultPermissions" },
    );
  }

  const config = value as Record<string, unknown>;
  for (const key of ["read", "write"] as const) {
    const mode = config[key];
    if (
      mode !== undefined &&
      mode !== false &&
      mode !== "allResourceFields"
    ) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: defaultPermissions.${key} must be allResourceFields or false`,
        { path: `defaultPermissions.${key}` },
      );
    }
  }
  if (
    config.relationWrites !== undefined &&
    config.relationWrites !== false &&
    config.relationWrites !== "all"
  ) {
    return err(
      "SCHEMA_INVALID",
      "Invalid schema: defaultPermissions.relationWrites must be all or false",
      { path: "defaultPermissions.relationWrites" },
    );
  }

  return ok({
    ...(config.read === undefined
      ? {}
      : { read: config.read as "allResourceFields" | false }),
    ...(config.write === undefined
      ? {}
      : { write: config.write as "allResourceFields" | false }),
    ...(config.relationWrites === undefined
      ? {}
      : { relationWrites: config.relationWrites as "all" | false }),
  });
}

const RELATION_DELETE_POLICIES: ReadonlySet<string> = new Set([
  "restrict",
  "cascade",
  "setNull",
  "detach",
]);

// Canonical ordering for relation capabilities (RCAP-004)
const RELATION_CAPABILITY_CANONICAL_ORDER: RelationSimpleCapability[] = ["timestamps", "audit"];

/**
 * Resolves and validates relation capability declarations.
 * Returns canonical ordered, deduplicated array, or error.
 * - Returns ok([]) when capabilities is undefined.
 * - Rejects non-array, non-string entries, and unknown capability values.
 * - Returns deterministic canonical order: ["timestamps", "audit"] subset.
 */
export function resolveRelationCapabilities(
  capabilities: unknown,
): DatafnEnvelope<RelationSimpleCapability[]> {
  if (capabilities === undefined) return ok([]);
  if (!Array.isArray(capabilities)) {
    return err("SCHEMA_INVALID", "Relation capabilities must be an array", {
      path: "capabilities",
    });
  }
  for (const entry of capabilities) {
    if (typeof entry !== "string") {
      return err("SCHEMA_INVALID", "Relation capability values must be strings", {
        path: "capabilities",
      });
    }
    if (!RELATION_SIMPLE_CAPABILITIES.has(entry as RelationSimpleCapability)) {
      return err("INVALID_CAPABILITY", `Unknown relation capability "${entry}"`, {
        path: "capabilities",
      });
    }
  }
  const declared = new Set(capabilities as RelationSimpleCapability[]);
  return ok(RELATION_CAPABILITY_CANONICAL_ORDER.filter((cap) => declared.has(cap)));
}

/**
 * Resolve whether namespace isolation is enabled from a schema-like object.
 * Default is `true`.
 */
function resolveNamespaced(s: Record<string, unknown>): boolean {
  if (typeof s.namespaced === "boolean") return s.namespaced;
  return true;
}

/**
 * Returns whether namespace isolation is enabled for a given schema.
 * Default is `true`.
 */
export function isNamespaced(schema: DatafnSchema): boolean {
  if (typeof schema.namespaced === "boolean") return schema.namespaced;
  return true;
}

/**
 * Validates a schema and returns a normalized version.
 *
 * Normalization:
 * - Converts `indices: string[]` to `{ base: string[], search: [], vector: [] }`
 * - Ensures `relations` is present (defaults to [])
 *
 * Validation:
 * - `resources` must be present and be an array
 * - Each resource must have unique `name` and integer `version`
 * - Fields must have unique names within a resource
 */
export function validateSchema(schema: unknown): DatafnEnvelope<DatafnSchema> {
  // Check that schema is an object
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return err("SCHEMA_INVALID", "Invalid schema: expected object", {
      path: "$",
    });
  }

  const s = schema as Record<string, unknown>;
  const globalCapsResult = parseSchemaCapabilities(s.capabilities);
  if (!globalCapsResult.ok) return globalCapsResult;
  const globalCapabilities = globalCapsResult.result;
  const defaultPermissionsResult = validateDefaultPermissions(s.defaultPermissions);
  if (!defaultPermissionsResult.ok) return defaultPermissionsResult;

  if (
    s.relationIntegrity !== undefined &&
    !RELATION_INTEGRITY_MODES.has(s.relationIntegrity as DatafnRelationIntegrityMode)
  ) {
    return err(
      "SCHEMA_INVALID",
      `Invalid schema: relationIntegrity must be one of ${[...RELATION_INTEGRITY_MODES].join(", ")}`,
      { path: "relationIntegrity" },
    );
  }

  // Check resources exists and is an array
  if (!s.resources || !Array.isArray(s.resources)) {
    return err("SCHEMA_INVALID", "Invalid schema: missing resources", {
      path: "resources",
    });
  }

  // LOW-028: Enforce resource count limit
  const MAX_RESOURCES = 100;
  if (s.resources.length > MAX_RESOURCES) {
    return err("SCHEMA_INVALID", `Invalid schema: too many resources (max ${MAX_RESOURCES})`, {
      path: "resources",
    });
  }

  const resourceNames = new Set<string>();
  const normalizedIdPrefixes = new Map<string, string>();
  const normalizedResources: DatafnResourceSchema[] = [];

  for (const resource of s.resources) {
    if (
      typeof resource !== "object" ||
      resource === null ||
      Array.isArray(resource)
    ) {
      return err("SCHEMA_INVALID", "Invalid schema: resource must be object", {
        path: "resources",
      });
    }

    const r = resource as Record<string, unknown>;

    // Validate name
    if (typeof r.name !== "string") {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.name must be string",
        { path: "resources" }
      );
    }

    // Check for duplicate resource names
    if (resourceNames.has(r.name)) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: duplicate resource name: ${r.name}`,
        { path: "resources" }
      );
    }
    resourceNames.add(r.name);

    let effectiveIdPrefix = `${r.name}:`;
    if (r.idPrefix !== undefined) {
      if (typeof r.idPrefix !== "string") {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: resource.idPrefix must be string",
          { path: `resources.${r.name}.idPrefix` },
        );
      }
      if (r.idPrefix.length === 0) {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: resource.idPrefix must not be empty",
          { path: `resources.${r.name}.idPrefix` },
        );
      }
      effectiveIdPrefix = r.idPrefix;
    }
    const normalizedIdPrefix = effectiveIdPrefix.endsWith(":")
      ? effectiveIdPrefix.slice(0, -1)
      : effectiveIdPrefix;
    if (normalizedIdPrefix.length === 0) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.idPrefix must not normalize to empty",
        { path: `resources.${r.name}.idPrefix` },
      );
    }
    const conflictingResource = normalizedIdPrefixes.get(normalizedIdPrefix);
    if (conflictingResource !== undefined) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: resource idPrefix "${effectiveIdPrefix}" conflicts with resource "${conflictingResource}" after normalization`,
        { path: `resources.${r.name}.idPrefix` },
      );
    }
    normalizedIdPrefixes.set(normalizedIdPrefix, r.name);

    // Validate version
    if (typeof r.version !== "number" || !Number.isInteger(r.version)) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.version must be integer",
        { path: "resources" }
      );
    }

    // Validate fields
    if (!Array.isArray(r.fields)) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.fields must be array",
        { path: "resources" }
      );
    }

    // LOW-028: Enforce field count limit per resource
    const MAX_FIELDS_PER_RESOURCE = 200;
    if ((r.fields as unknown[]).length > MAX_FIELDS_PER_RESOURCE) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: resource "${r.name}" has too many fields (max ${MAX_FIELDS_PER_RESOURCE})`,
        { path: `resources.${r.name}.fields` },
      );
    }

    const fieldNames = new Set<string>();
    const normalizedFields: DatafnFieldSchema[] = [];
    for (const field of r.fields) {
      if (typeof field !== "object" || field === null || Array.isArray(field)) {
        return err("SCHEMA_INVALID", "Invalid schema: field must be object", {
          path: "resources",
        });
      }
      const f = field as Record<string, unknown>;
      if (typeof f.name !== "string") {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: field.name must be string",
          { path: "resources" }
        );
      }
      if (fieldNames.has(f.name)) {
        return err(
          "SCHEMA_INVALID",
          `Invalid schema: duplicate field name: ${f.name}`,
          { path: "resources" }
        );
      }
      const normalizedType =
        f.type === "id" ? "string" : (f.type as DatafnFieldSchema["type"]);
      if (!FIELD_TYPES.has(normalizedType)) {
        return err(
          "SCHEMA_INVALID",
          `Invalid schema: field.type must be one of ${[...FIELD_TYPES].join(", ")}`,
          { path: `resources.${r.name}.fields.${f.name}.type` }
        );
      }
      let normalizedRequired: boolean;
      if (typeof f.required === "boolean") {
        normalizedRequired = f.required;
      } else if (f.required === undefined) {
        // Preserve legacy shorthand: `required` defaulted to false, except for `id`.
        normalizedRequired = f.name === "id";
      } else {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: field.required must be boolean",
          { path: `resources.${r.name}.fields.${f.name}.required` }
        );
      }
      if (normalizedType === "date") {
        // Date bounds are absolute epoch milliseconds: they must be finite,
        // ordered, and any non-null default must lie within them, otherwise a
        // replace/insert that applies the default would bypass mutation-time
        // bounds enforcement.
        const min = f.min;
        const max = f.max;
        if (
          min !== undefined &&
          (typeof min !== "number" || !Number.isFinite(min))
        ) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: date field "${f.name}" min must be finite epoch milliseconds`,
            { path: `resources.${r.name}.fields.${f.name}.min` },
          );
        }
        if (
          max !== undefined &&
          (typeof max !== "number" || !Number.isFinite(max))
        ) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: date field "${f.name}" max must be finite epoch milliseconds`,
            { path: `resources.${r.name}.fields.${f.name}.max` },
          );
        }
        if (
          typeof min === "number" &&
          typeof max === "number" &&
          min > max
        ) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: date field "${f.name}" min must not exceed max`,
            { path: `resources.${r.name}.fields.${f.name}.min` },
          );
        }
        if (
          f.default !== undefined &&
          f.default !== null &&
          (min !== undefined || max !== undefined)
        ) {
          const defaultEpoch = toBoundsEpochMs(f.default);
          // Reject defaults that do not parse as dates (e.g. "not-a-date" or
          // a plain object): replace/merge-create apply defaults without
          // mutation-time bounds checks, so an unparseable default would be
          // persisted as-is. Opaque e2ee envelopes stay exempt.
          if (
            (!Number.isFinite(defaultEpoch) ||
              !validateFieldValue("date", f.default, false).ok) &&
            !isDatafnE2eeEnvelope(f.default)
          ) {
            return err(
              "SCHEMA_INVALID",
              `Invalid schema: date field "${f.name}" default must be a valid date`,
              { path: `resources.${r.name}.fields.${f.name}.default` },
            );
          }
          if (Number.isFinite(defaultEpoch)) {
            if (typeof min === "number" && defaultEpoch < min) {
              return err(
                "SCHEMA_INVALID",
                `Invalid schema: date field "${f.name}" default is before its min bound`,
                { path: `resources.${r.name}.fields.${f.name}.default` },
              );
            }
            if (typeof max === "number" && defaultEpoch > max) {
              return err(
                "SCHEMA_INVALID",
                `Invalid schema: date field "${f.name}" default is after its max bound`,
                { path: `resources.${r.name}.fields.${f.name}.default` },
              );
            }
          }
        }
      }
      fieldNames.add(f.name);
      normalizedFields.push({
        ...(f as Omit<DatafnFieldSchema, "type" | "required">),
        name: f.name,
        type: normalizedType,
        required: normalizedRequired,
      });
    }

    const resourceCapsResult = parseResourceCapabilities(r.capabilities);
    if (!resourceCapsResult.ok) return resourceCapsResult;
    const resolvedCapabilities = resolveCapabilities(
      globalCapabilities,
      resourceCapsResult.result,
    );

    if (hasShareable(resolvedCapabilities) && !hasCapability(resolvedCapabilities, "audit")) {
      return err(
        "CAPABILITY_DEPENDENCY",
        `"shareable" capability requires "audit" capability`,
        { path: `resources.${r.name}.capabilities` },
      );
    }

    const collision = findCapabilityFieldCollision(fieldNames, resolvedCapabilities);
    if (collision) {
      return err(
        "CAPABILITY_FIELD_COLLISION",
        `Field "${collision.field}" on resource "${r.name}" collides with capability-injected field from "${collision.capability}"`,
        { path: `resources.${r.name}.fields.${collision.field}` },
      );
    }

    const injectedFields = getCapabilityFields(resolvedCapabilities);
    for (const injectedField of injectedFields) {
      fieldNames.add(injectedField.name);
    }

    // Normalize indices
    let normalizedIndices: {
      base: string[];
      search: string[];
      vector: string[];
    };
    const normalizeIndexFields = (
      value: unknown,
      path: string,
    ): DatafnEnvelope<string[]> => {
      if (value === undefined) return ok([]);
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: index definitions must be string[]",
          { path },
        );
      }
      return ok([...value]);
    };
    if (Array.isArray(r.indices)) {
      const baseIndices = normalizeIndexFields(r.indices, `resources.${r.name}.indices`);
      if (!baseIndices.ok) return baseIndices;
      normalizedIndices = {
        base: baseIndices.result,
        search: [],
        vector: [],
      };
    } else if (r.indices && typeof r.indices === "object") {
      const idx = r.indices as Record<string, unknown>;
      const base = normalizeIndexFields(idx.base, `resources.${r.name}.indices.base`);
      if (!base.ok) return base;
      const search = normalizeIndexFields(idx.search, `resources.${r.name}.indices.search`);
      if (!search.ok) return search;
      const vector = normalizeIndexFields(idx.vector, `resources.${r.name}.indices.vector`);
      if (!vector.ok) return vector;
      normalizedIndices = {
        base: base.result,
        search: search.result,
        vector: vector.result,
      };
    } else {
      normalizedIndices = { base: [], search: [], vector: [] };
    }

    // Validate index field names against declared fields
    for (const [category, idxFields] of Object.entries(normalizedIndices)) {
      for (const idxField of idxFields) {
        if (!fieldNames.has(idxField)) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: index field "${idxField}" in indices.${category} does not match any field in resource "${r.name}". Available fields: ${[...fieldNames].join(", ")}`,
            { path: `resources.${r.name}.indices.${category}` }
          );
        }
      }
    }

    const normalizedResource: DatafnResourceSchema = {
      ...r,
      name: r.name,
      version: r.version,
      capabilities: resourceCapsResult.result as DatafnResourceSchema["capabilities"],
      fields: [...normalizedFields, ...injectedFields],
      indices: normalizedIndices,
    };
    normalizedResources.push(normalizedResource);
  }

  // Normalize relations (default to empty array)
  const relations = Array.isArray(s.relations) ? s.relations : [];
  const normalizedRelations: DatafnRelationSchema[] = [];

  // Validate relation fields
  for (const rel of relations) {
    if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
      return err("SCHEMA_INVALID", "Invalid schema: relation must be object", {
        path: "relations",
      });
    }
    const r = rel as Record<string, unknown>;

    if (r.from === undefined || r.to === undefined || r.type === undefined) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: relation.from, relation.to, and relation.type are required",
        { path: "relations" },
      );
    }

    const normalizeRelationEndpoint = (
      ref: unknown,
      side: "from" | "to",
    ): DatafnEnvelope<string | string[]> => {
      if (typeof ref === "string") return ok(ref);
      if (!Array.isArray(ref) || ref.length === 0 || !ref.every((value) => typeof value === "string")) {
        return err(
          "SCHEMA_INVALID",
          `Invalid schema: relation.${side} must be a string or non-empty string[]`,
          { path: `relations.${side}` },
        );
      }
      return ok([...ref] as string[]);
    };

    const normalizedFrom = normalizeRelationEndpoint(r.from, "from");
    if (!normalizedFrom.ok) return normalizedFrom;
    const normalizedTo = normalizeRelationEndpoint(r.to, "to");
    if (!normalizedTo.ok) return normalizedTo;

    if (!RELATION_TYPES.has(r.type as DatafnRelationSchema["type"])) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: relation.type must be one of ${[...RELATION_TYPES].join(", ")}`,
        { path: "relations.type" },
      );
    }
    if (r.relation !== undefined && typeof r.relation !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.relation must be string", {
        path: "relations.relation",
      });
    }
    if (r.inverse !== undefined && typeof r.inverse !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.inverse must be string", {
        path: "relations.inverse",
      });
    }
    if (r.cache !== undefined && typeof r.cache !== "boolean") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.cache must be boolean", {
        path: "relations.cache",
      });
    }
    if (r.inheritsInactive !== undefined) {
      if (typeof r.inheritsInactive !== "boolean") {
        return err("SCHEMA_INVALID", "Invalid schema: relation.inheritsInactive must be boolean", {
          path: "relations.inheritsInactive",
        });
      }
      if (r.inheritsInactive === true && r.type === "many-many") {
        return err("SCHEMA_INVALID", "Invalid schema: relation.inheritsInactive is not supported on many-many relations", {
          path: "relations.inheritsInactive",
        });
      }
    }
    if (r.fkField !== undefined && typeof r.fkField !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.fkField must be string", {
        path: "relations.fkField",
      });
    }
    if (r.foreignKey !== undefined && typeof r.foreignKey !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.foreignKey must be string", {
        path: "relations.foreignKey",
      });
    }
    if (r.fkResourceField !== undefined && typeof r.fkResourceField !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.fkResourceField must be string", {
        path: "relations.fkResourceField",
      });
    }
    if (r.pathField !== undefined && typeof r.pathField !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.pathField must be string", {
        path: "relations.pathField",
      });
    }
    if (r.metadata !== undefined) {
      if (!Array.isArray(r.metadata)) {
        return err("SCHEMA_INVALID", "Invalid schema: relation.metadata must be array", {
          path: "relations.metadata",
        });
      }
      for (const field of r.metadata) {
        if (typeof field !== "object" || field === null || Array.isArray(field)) {
          return err("SCHEMA_INVALID", "Invalid schema: relation.metadata items must be objects", {
            path: "relations.metadata",
          });
        }
        const metaField = field as Record<string, unknown>;
        if (typeof metaField.name !== "string") {
          return err("SCHEMA_INVALID", "Invalid schema: relation.metadata.name must be string", {
            path: "relations.metadata.name",
          });
        }
        if (
          !["string", "number", "boolean", "date", "object", "json"].includes(
            metaField.type as string,
          )
        ) {
          return err(
            "SCHEMA_INVALID",
            "Invalid schema: relation.metadata.type must be one of string, number, boolean, date, object, json",
            { path: `relations.metadata.${metaField.name}.type` },
          );
        }
      }
    }
    if (r.identityMetadata !== undefined) {
      if (r.type !== "many-many") {
        return err("SCHEMA_INVALID", "Invalid schema: relation.identityMetadata is only supported on many-many relations", {
          path: "relations.identityMetadata",
        });
      }
      if (!Array.isArray(r.identityMetadata)) {
        return err("SCHEMA_INVALID", "Invalid schema: relation.identityMetadata must be array", {
          path: "relations.identityMetadata",
        });
      }
      const metadataFields = new Map(
        (r.metadata ?? []).map((field) => [field.name, field.type]),
      );
      for (const fieldName of r.identityMetadata) {
        if (typeof fieldName !== "string" || fieldName.length === 0) {
          return err("SCHEMA_INVALID", "Invalid schema: relation.identityMetadata entries must be non-empty strings", {
            path: "relations.identityMetadata",
          });
        }
        const fieldType = metadataFields.get(fieldName);
        if (!fieldType) {
          return err("SCHEMA_INVALID", `Invalid schema: relation.identityMetadata references unknown metadata field "${fieldName}"`, {
            path: `relations.identityMetadata.${fieldName}`,
          });
        }
        if (fieldType === "object" || fieldType === "json") {
          return err("SCHEMA_INVALID", "Invalid schema: relation.identityMetadata cannot reference object or json metadata fields", {
            path: `relations.identityMetadata.${fieldName}`,
          });
        }
      }
    }

    // CLI-004: Validate that from/to reference declared resource names
    const validateRelationRef = (
      ref: string | string[],
      side: "from" | "to",
    ): DatafnEnvelope<never> | null => {
      const refs = Array.isArray(ref) ? ref : [ref];
      for (const name of refs) {
        if (!resourceNames.has(name)) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: relation.${side} references unknown resource "${name}". Available: ${[...resourceNames].join(", ")}`,
            { path: `relations.${side}` },
          );
        }
      }
      return null;
    };
    const fromRefError = validateRelationRef(normalizedFrom.result, "from");
    if (fromRefError) return fromRefError;
    const toRefError = validateRelationRef(normalizedTo.result, "to");
    if (toRefError) return toRefError;
    if (r.inheritsInactive === true) {
      const dependentResources = r.type === "many-one"
        ? (Array.isArray(normalizedFrom.result) ? normalizedFrom.result : [normalizedFrom.result])
        : (Array.isArray(normalizedTo.result) ? normalizedTo.result : [normalizedTo.result]);
      for (const name of dependentResources) {
        const dependentResource = normalizedResources.find((resource) => resource.name === name);
        if (!dependentResource?.fields.some((field) => field.name === "isAncestorInactive")) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: relation.inheritsInactive requires resource "${name}" to define isAncestorInactive`,
            { path: "relations.inheritsInactive" },
          );
        }
      }
    }

    if (r.joinTable !== undefined && typeof r.joinTable !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.joinTable must be string", {
        path: "relations",
      });
    }
    if (r.joinColumns !== undefined) {
      if (typeof r.joinColumns !== "object" || r.joinColumns === null || Array.isArray(r.joinColumns)) {
        return err("SCHEMA_INVALID", "Invalid schema: relation.joinColumns must be object with from/to strings", {
          path: "relations",
        });
      }
      const jc = r.joinColumns as Record<string, unknown>;
      if (typeof jc.from !== "string" || typeof jc.to !== "string") {
        return err("SCHEMA_INVALID", "Invalid schema: relation.joinColumns.from and .to must be strings", {
          path: "relations",
        });
      }
    }
    if (
      r.integrity !== undefined &&
      !RELATION_INTEGRITY_MODES.has(r.integrity as DatafnRelationIntegrityMode)
    ) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: relation.integrity must be one of ${[...RELATION_INTEGRITY_MODES].join(", ")}`,
        { path: "relations.integrity" },
      );
    }
    if (r.onDelete !== undefined) {
      const policyValidation = validateRelationDeletePolicies(r.onDelete);
      if (!policyValidation.ok) return policyValidation;
    }

    // RCAP-001, RCAP-002, RCAP-003: Validate relation capabilities if present
    let normalizedRelationCapabilities: RelationSimpleCapability[] | undefined;
    if (r.capabilities !== undefined) {
      if (r.type !== "many-many") {
        return err(
          "SCHEMA_INVALID",
          `Relation capabilities are only supported on many-many relations, got "${r.type}"`,
          { path: "relations" },
        );
      }
      const capResult = resolveRelationCapabilities(r.capabilities);
      if (!capResult.ok) return capResult;
      normalizedRelationCapabilities = capResult.result;

      // RCAP-003: Detect collisions between relation metadata fields and injected capability fields
      if (Array.isArray(r.metadata) && capResult.result.length > 0) {
        const injectedNames = new Set(getRelationCapabilityFieldNames(capResult.result));
        const relationName = typeof r.relation === "string" ? r.relation : "unknown";
        for (const metaField of r.metadata as Array<Record<string, unknown>>) {
          if (typeof metaField?.name === "string" && injectedNames.has(metaField.name)) {
            return err(
              "CAPABILITY_FIELD_COLLISION",
              `Relation metadata field "${metaField.name}" on relation "${relationName}" collides with relation capability-injected field`,
              { path: `relations.${relationName}.metadata.${metaField.name}` },
            );
          }
        }
      }
    }

    normalizedRelations.push({
      ...(r as Omit<DatafnRelationSchema, "from" | "to" | "capabilities">),
      from: normalizedFrom.result,
      to: normalizedTo.result,
      capabilities: normalizedRelationCapabilities,
    });
  }

  const namespaced = resolveNamespaced(s);

  return ok({
    capabilities: globalCapabilities,
    defaultPermissions: defaultPermissionsResult.result,
    resources: normalizedResources,
    relations: normalizedRelations,
    relationIntegrity: s.relationIntegrity as DatafnRelationIntegrityMode | undefined,
    namespaced,
  });
}

function validateRelationDeletePolicies(
  value: unknown,
): DatafnEnvelope<DatafnRelationDeletePolicies> {
  if (typeof value === "string") {
    if (RELATION_DELETE_POLICIES.has(value)) return ok(value as DatafnRelationDeletePolicies);
    return err(
      "SCHEMA_INVALID",
      `Invalid schema: relation.onDelete must use one of ${[...RELATION_DELETE_POLICIES].join(", ")}`,
      { path: "relations.onDelete" },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(
      "SCHEMA_INVALID",
      "Invalid schema: relation.onDelete must be a policy string or { from, to } object",
      { path: "relations.onDelete" },
    );
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "from" && key !== "to") {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: relation.onDelete only supports from and to keys",
        { path: "relations.onDelete" },
      );
    }
    const policy = obj[key];
    if (policy !== undefined && (typeof policy !== "string" || !RELATION_DELETE_POLICIES.has(policy))) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: relation.onDelete.${key} must use one of ${[...RELATION_DELETE_POLICIES].join(", ")}`,
        { path: `relations.onDelete.${key}` },
      );
    }
  }
  return ok(obj as DatafnRelationDeletePolicies);
}

function parseSchemaCapabilities(
  value: unknown,
): DatafnEnvelope<SchemaCapabilities | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) {
    return err("INVALID_CAPABILITY_CONFIG", "Schema capabilities must be an array", {
      path: "capabilities",
    });
  }
  return parseCapabilityArray(value, "capabilities");
}

function parseResourceCapabilities(
  value: unknown,
): DatafnEnvelope<ResourceCapabilities | undefined> {
  if (value === undefined) return ok(undefined);
  if (Array.isArray(value)) {
    return parseCapabilityArray(value, "resources.capabilities");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      "Resource capabilities must be an array or { exclude: [...] }",
      { path: "resources.capabilities" },
    );
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.exclude)) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      "Resource capability exclusion must be { exclude: SimpleCapability[] }",
      { path: "resources.capabilities.exclude" },
    );
  }
  const excluded: SimpleCapability[] = [];
  for (const cap of obj.exclude) {
    if (typeof cap !== "string") {
      return err("INVALID_CAPABILITY", "Capability name must be a string", {
        path: "resources.capabilities.exclude",
      });
    }
    if (!SIMPLE_CAPABILITIES.has(cap as SimpleCapability)) {
      return err("INVALID_CAPABILITY", `Unknown capability "${cap}"`, {
        path: "resources.capabilities.exclude",
      });
    }
    excluded.push(cap as SimpleCapability);
  }
  return ok({ exclude: excluded });
}

function parseCapabilityArray(
  input: unknown[],
  path: string,
): DatafnEnvelope<CapabilityEntry[]> {
  const parsed: CapabilityEntry[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      if (entry === "shareable") {
        return err(
          "INVALID_CAPABILITY_CONFIG",
          `"shareable" capability requires object config`,
          { path },
        );
      }
      if (!SIMPLE_CAPABILITIES.has(entry as SimpleCapability)) {
        return err("INVALID_CAPABILITY", `Unknown capability "${entry}"`, { path });
      }
      parsed.push(entry as SimpleCapability);
      continue;
    }
    const shareableResult = parseShareableCapability(entry, path);
    if (shareableResult.ok) {
      parsed.push(shareableResult.result);
      continue;
    }
    return shareableResult;
  }

  // VA-001: duplicate entries are deduplicated, not rejected
  return ok(resolveCapabilities(parsed, undefined));
}

function parseShareableCapability(
  entry: unknown,
  path: string,
): DatafnEnvelope<ShareableCapability> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return err("INVALID_CAPABILITY_CONFIG", "Invalid capability configuration", { path });
  }
  const obj = entry as Record<string, unknown>;
  if (!obj.shareable || typeof obj.shareable !== "object" || Array.isArray(obj.shareable)) {
    return err("INVALID_CAPABILITY_CONFIG", "Invalid capability configuration", { path });
  }
  const shareable = obj.shareable as Record<string, unknown>;
  if (!Array.isArray(shareable.levels)) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.levels" must be an array`,
      { path: `${path}.shareable.levels` },
    );
  }
  if (
    shareable.levels.length === 0 ||
    !shareable.levels.every((level) => typeof level === "string" && SHAREABLE_LEVELS.has(level))
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.levels" must include one or more of [viewer, editor, owner]`,
      { path: `${path}.shareable.levels` },
    );
  }
  if (
    shareable.default !== undefined &&
    (typeof shareable.default !== "string" || !SHAREABLE_DEFAULTS.has(shareable.default))
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.default" must be one of [private, shared]`,
      { path: `${path}.shareable.default` },
    );
  }

  if (
    shareable.visibilityDefault !== undefined &&
    (typeof shareable.visibilityDefault !== "string" ||
      !SHAREABLE_VISIBILITY_DEFAULTS.has(shareable.visibilityDefault))
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.visibilityDefault" must be one of [ns, private, shared]`,
      { path: `${path}.shareable.visibilityDefault` },
    );
  }
  if (shareable.default === undefined && shareable.visibilityDefault === undefined) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.default" or "shareable.visibilityDefault" must be provided`,
      { path: `${path}.shareable` },
    );
  }

  if (
    shareable.supportsScopeGrants !== undefined &&
    typeof shareable.supportsScopeGrants !== "boolean"
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.supportsScopeGrants" must be boolean`,
      { path: `${path}.shareable.supportsScopeGrants` },
    );
  }

  if (
    shareable.crossNsShareable !== undefined &&
    typeof shareable.crossNsShareable !== "boolean"
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.crossNsShareable" must be boolean`,
      { path: `${path}.shareable.crossNsShareable` },
    );
  }

  if (
    shareable.principalMode !== undefined &&
    (typeof shareable.principalMode !== "string" ||
      !SHAREABLE_PRINCIPAL_MODES.has(shareable.principalMode))
  ) {
    return err(
      "INVALID_CAPABILITY_CONFIG",
      `"shareable.principalMode" must be one of [opaque-id]`,
      { path: `${path}.shareable.principalMode` },
    );
  }

  let relationInheritance: ShareableCapability["shareable"]["relationInheritance"] | undefined;
  if (shareable.relationInheritance !== undefined) {
    const rel = shareable.relationInheritance;
    if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
      return err(
        "INVALID_CAPABILITY_CONFIG",
        `"shareable.relationInheritance" must be an object`,
        { path: `${path}.shareable.relationInheritance` },
      );
    }
    const relObj = rel as Record<string, unknown>;
    if (typeof relObj.enabled !== "boolean") {
      return err(
        "INVALID_CAPABILITY_CONFIG",
        `"shareable.relationInheritance.enabled" must be boolean`,
        { path: `${path}.shareable.relationInheritance.enabled` },
      );
    }
    if (
      relObj.relations !== undefined &&
      (!Array.isArray(relObj.relations) ||
        !relObj.relations.every((value) => typeof value === "string"))
    ) {
      return err(
        "INVALID_CAPABILITY_CONFIG",
        `"shareable.relationInheritance.relations" must be string[]`,
        { path: `${path}.shareable.relationInheritance.relations` },
      );
    }
    if (
      relObj.requireRelateConsent !== undefined &&
      typeof relObj.requireRelateConsent !== "boolean"
    ) {
      return err(
        "INVALID_CAPABILITY_CONFIG",
        `"shareable.relationInheritance.requireRelateConsent" must be boolean`,
        { path: `${path}.shareable.relationInheritance.requireRelateConsent` },
      );
    }
    relationInheritance = {
      enabled: relObj.enabled,
      relations: relObj.relations as string[] | undefined,
      requireRelateConsent: (relObj.requireRelateConsent as boolean | undefined) ?? true,
    };
  }

  const normalized: ShareableCapability = {
    shareable: {
      levels: shareable.levels as ShareableCapability["shareable"]["levels"],
      default:
        (shareable.default as ShareableCapability["shareable"]["default"] | undefined) ??
        ((shareable.visibilityDefault as ShareableCapability["shareable"]["visibilityDefault"]) === "private"
          ? "private"
          : "shared"),
      visibilityDefault: (
        (shareable.visibilityDefault as
          | ShareableCapability["shareable"]["visibilityDefault"]
          | undefined) ??
        (shareable.default as ShareableCapability["shareable"]["default"])
      ) as ShareableCapability["shareable"]["visibilityDefault"],
      supportsScopeGrants: (shareable.supportsScopeGrants as boolean | undefined) ?? true,
      crossNsShareable: (shareable.crossNsShareable as boolean | undefined) ?? true,
      principalMode:
        (shareable.principalMode as ShareableCapability["shareable"]["principalMode"] | undefined) ??
        "opaque-id",
      relationInheritance,
    },
  };

  return ok(normalized);
}

function hasCapability(caps: CapabilityEntry[], capability: SimpleCapability): boolean {
  return caps.some((cap) => cap === capability);
}

function hasShareable(caps: CapabilityEntry[]): boolean {
  return caps.some((cap) => typeof cap === "object" && cap !== null && "shareable" in cap);
}

function findCapabilityFieldCollision(
  userFieldNames: Set<string>,
  resolvedCapabilities: CapabilityEntry[],
): { field: string; capability: string } | null {
  for (const cap of resolvedCapabilities) {
    const key = typeof cap === "string" ? cap : "shareable";
    const injectedDefs = CAPABILITY_FIELD_DEFS[key];
    for (const field of injectedDefs) {
      if (userFieldNames.has(field.name)) {
        return { field: field.name, capability: key };
      }
    }
  }
  return null;
}
