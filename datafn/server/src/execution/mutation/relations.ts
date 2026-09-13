/**
 * Relation mutation operations (relate, modifyRelation, unrelate)
 */

import type { DatafnSchema, DatafnRelationSchema, NormalizedRelation } from "../../core-types.js";
import {
  endpointIncludes,
  endpointList,
  findRelationMatch,
  firstEndpoint,
  getJoinStoreKey,
  getRelationJoinTableName,
  normalizeRelationPayload,
  RELATION_CAPABILITY_FIELD_DEFS,
  relationTargetEndpoint,
  relationFkFieldForManyOne,
  resolveEndpointResource,
  resourceRequiresAncestorInactive,
  type DatafnRelationDirection,
  type DatafnRelationMatch,
} from "@datafn/core";
import type { Adapter, TransactionAdapter } from "@superfunctions/db";
import type { DFQLMutation } from "./dfql.js";

// Local alias — avoids TS2709 ("Cannot use namespace as type") for the @datafn/core re-export.
type RelationSimpleCapability = "timestamps" | "audit";
type RelationDeletePolicy = "restrict" | "cascade" | "setNull" | "detach";
type RelationMutationChange = {
  resource: string;
  id: string;
  op: "merge" | "delete";
  record: Record<string, unknown> | null;
};

// NormalizedRelation and normalizeRelationPayload are imported from @datafn/core above.
export type { NormalizedRelation };
export { normalizeRelationPayload };

function pickResourceName(name: string | readonly string[]): string {
  return typeof name === "string" ? name : name[0];
}

function resourceNameForId(
  schema: DatafnSchema,
  endpoint: string | readonly string[],
  id: string,
): string | undefined {
  return resolveEndpointResource(endpoint, id, schema);
}

async function validateRelationTargets(
  adapter: Adapter,
  schema: DatafnSchema,
  endpoint: string | readonly string[],
  items: NormalizedRelation[],
  namespace: string,
  path: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
  const targetsByResource = new Map<string, string[]>();
  for (const item of items) {
    const resource = resourceNameForId(schema, endpoint, item.toId);
    if (!resource) {
      return {
        ok: false,
        code: "DFQL_INVALID",
        message: `Invalid relation target: ${item.toId}`,
        path,
      };
    }
    const ids = targetsByResource.get(resource) ?? [];
    ids.push(item.toId);
    targetsByResource.set(resource, ids);
  }

  for (const [resource, ids] of targetsByResource.entries()) {
    const existingTargets = await adapter.findMany({
      model: resource,
      where: [{ field: "id", operator: "in", value: ids }],
      namespace,
    });
    const existingTargetIds = new Set(existingTargets.map((target: any) => target.id));
    const missingId = ids.find((id) => !existingTargetIds.has(id));
    if (missingId !== undefined) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `Related record not found: ${missingId}`,
        path,
      };
    }
  }

  return { ok: true };
}

function htreeFkField(relation: DatafnRelationSchema): string {
  return relation.fkField || relation.foreignKey || relation.inverse || "parentId";
}

function htreePathField(relation: DatafnRelationSchema): string {
  return relation.pathField || "parentPath";
}

function fkResourceFieldForRelation(
  relation: DatafnRelationSchema,
  side: "from" | "to",
): string {
  if (relation.fkResourceField) return relation.fkResourceField;
  if (relation.type === "htree") {
    return `${htreeFkField(relation).replace(/Id$/, "")}Resource`;
  }
  const base = side === "to"
    ? (relation.relation || "target")
    : (relation.inverse || relation.relation || "source");
  return `${base.replace(/Id$/, "")}Resource`;
}

function endpointIsPolymorphic(endpoint: string | readonly string[]): boolean {
  return endpointList(endpoint).length > 1;
}

function fkResourcePatch(
  relation: DatafnRelationSchema,
  side: "from" | "to",
  resource: string | null,
): Record<string, unknown> {
  const endpoint = side === "to" ? relation.to : relation.from;
  if (!endpointIsPolymorphic(endpoint)) return {};
  return { [fkResourceFieldForRelation(relation, side)]: resource };
}

function joinHtreePath(parentPath: unknown, parentId: string | null): string {
  if (!parentId) return "";
  return typeof parentPath === "string" && parentPath.length > 0
    ? `${parentPath}-${parentId}`
    : parentId;
}

function isRecordInactive(record: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    record &&
    (record.isArchived === true ||
      (record.trashedAt !== null && record.trashedAt !== undefined)),
  );
}

function isRecordEffectivelyInactive(record: Record<string, unknown> | null | undefined): boolean {
  return isRecordInactive(record) || record?.isAncestorInactive === true;
}

function resourceSupportsAncestorInactive(schema: DatafnSchema, resource: string): boolean {
  return resourceRequiresAncestorInactive(schema.relations, resource);
}

function dependentEndpoint(relation: DatafnRelationSchema): string | readonly string[] {
  return relation.type === "many-one" ? relation.from : relation.to;
}

async function findOneRecord(
  adapter: Adapter,
  resource: string,
  id: string,
  namespace: string,
): Promise<Record<string, unknown> | null> {
  return (await adapter.findOne<Record<string, unknown>>({
    model: resource,
    where: [{ field: "id", operator: "eq", value: id }],
    namespace,
  })) ?? null;
}

async function listRecords(
  adapter: Adapter,
  resource: string,
  namespace: string,
): Promise<Record<string, unknown>[]> {
  return await adapter.findMany({
    model: resource,
    where: [],
    namespace,
  }) as Record<string, unknown>[];
}

/**
 * Computes whether `record` should carry `isAncestorInactive` based on the
 * current state of its parents across all `inheritsInactive` relations.
 */
export async function resolveAncestorInactive(
  adapter: Adapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  namespace: string,
): Promise<boolean> {
  for (const relation of schema.relations ?? []) {
    if (relation.inheritsInactive !== true) continue;
    if (!endpointIncludes(dependentEndpoint(relation), resource)) continue;
    if (relation.type === "htree") {
      const parentId = record[htreeFkField(relation)];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await findOneRecord(
        adapter,
        resolveEndpointResource(relation.from, parentId, schema) ?? resource,
        parentId,
        namespace,
      );
      if (isRecordEffectivelyInactive(parent)) return true;
    } else if (relation.type === "many-one") {
      const parentId = record[relationFkFieldForManyOne(relation)];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await findOneRecord(
        adapter,
        resolveEndpointResource(relation.to, parentId, schema) ?? firstEndpoint(relation.to),
        parentId,
        namespace,
      );
      if (isRecordEffectivelyInactive(parent)) return true;
    } else if (relation.type === "one-many") {
      const parentId = record[relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await findOneRecord(
        adapter,
        resolveEndpointResource(relation.from, parentId, schema) ?? firstEndpoint(relation.from),
        parentId,
        namespace,
      );
      if (isRecordEffectivelyInactive(parent)) return true;
    }
  }
  return false;
}

async function updateAncestorInactive(
  adapter: Adapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
  namespace: string,
): Promise<Record<string, unknown> | null> {
  if (!resourceSupportsAncestorInactive(schema, resource)) return null;
  const next = await resolveAncestorInactive(adapter, schema, resource, record, namespace);
  if (record.isAncestorInactive === next) return null;
  await adapter.update({
    model: resource,
    where: [{ field: "id", operator: "eq", value: record.id as string }],
    data: { isAncestorInactive: next },
    namespace,
  });
  return { ...record, isAncestorInactive: next };
}

export async function applyInactivePropagation(
  adapter: Adapter,
  schema: DatafnSchema,
  seeds: Array<{ resource: string; id: string }>,
  namespace: string,
): Promise<RelationMutationChange[]> {
  if (!(schema.relations ?? []).some((relation) => relation.inheritsInactive === true)) {
    return [];
  }
  const changes: RelationMutationChange[] = [];
  const queue = [...seeds];
  const processed = new Set<string>();
  while (queue.length > 0) {
    const seed = queue.shift();
    if (!seed) continue;
    const key = `${seed.resource}:${seed.id}`;
    if (processed.has(key)) continue;
    processed.add(key);
    const record = await findOneRecord(adapter, seed.resource, seed.id, namespace);
    if (!record) continue;
    const updated = await updateAncestorInactive(adapter, schema, seed.resource, record, namespace);
    const source = updated ?? record;
    if (updated) {
      changes.push({ resource: seed.resource, id: seed.id, op: "merge", record: updated });
    }
    for (const relation of schema.relations ?? []) {
      if (relation.inheritsInactive !== true) continue;
      if (relation.type === "htree" && endpointIncludes(relation.from, seed.resource)) {
        const targetResource = firstEndpoint(relation.to);
        const childPath = joinHtreePath(source[htreePathField(relation)], seed.id);
        const children = (await listRecords(adapter, targetResource, namespace)).filter(
          (child) => child[htreePathField(relation)] === childPath,
        );
        for (const child of children) {
          const changed = await updateAncestorInactive(adapter, schema, targetResource, child, namespace);
          if (changed) {
            changes.push({ resource: targetResource, id: child.id as string, op: "merge", record: changed });
            queue.push({ resource: targetResource, id: child.id as string });
          }
        }
      } else if (relation.type === "many-one" && endpointIncludes(relation.to, seed.resource)) {
        const fkField = relationFkFieldForManyOne(relation);
        for (const childResource of endpointList(relation.from)) {
          const children = await adapter.findMany({
            model: childResource,
            where: [{ field: fkField, operator: "eq", value: seed.id }],
            namespace,
          }) as Record<string, unknown>[];
          for (const child of children) {
            const changed = await updateAncestorInactive(adapter, schema, childResource, child, namespace);
            if (changed) {
              changes.push({ resource: childResource, id: child.id as string, op: "merge", record: changed });
              queue.push({ resource: childResource, id: child.id as string });
            }
          }
        }
      } else if (relation.type === "one-many" && endpointIncludes(relation.from, seed.resource)) {
        const fkField = relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
        for (const childResource of endpointList(relation.to)) {
          const children = await adapter.findMany({
            model: childResource,
            where: [{ field: fkField, operator: "eq", value: seed.id }],
            namespace,
          }) as Record<string, unknown>[];
          for (const child of children) {
            const changed = await updateAncestorInactive(adapter, schema, childResource, child, namespace);
            if (changed) {
              changes.push({ resource: childResource, id: child.id as string, op: "merge", record: changed });
              queue.push({ resource: childResource, id: child.id as string });
            }
          }
        }
      }
    }
  }
  return changes;
}

async function updateHtreeDescendantPaths(
  adapter: Adapter,
  relation: DatafnRelationSchema,
  resource: string,
  childId: string,
  oldChildPath: string,
  newChildPath: string,
  namespace: string,
): Promise<void> {
  const pathField = htreePathField(relation);
  const oldPrefix = joinHtreePath(oldChildPath, childId);
  const newPrefix = joinHtreePath(newChildPath, childId);
  const records = await listRecords(adapter, resource, namespace);
  for (const record of records) {
    const currentPath = record[pathField];
    if (typeof currentPath !== "string") continue;
    if (currentPath !== oldPrefix && !currentPath.startsWith(`${oldPrefix}-`)) continue;
    const suffix = currentPath.slice(oldPrefix.length);
    await adapter.update({
      model: resource,
      where: [{ field: "id", operator: "eq", value: record.id as string }],
      data: { [pathField]: `${newPrefix}${suffix}` },
      namespace,
    });
  }
}

async function setHtreeParent(
  adapter: Adapter,
  relation: DatafnRelationSchema,
  resource: string,
  childId: string,
  parentId: string | null,
  parentResource: string | null,
  namespace: string,
): Promise<void> {
  const pathField = htreePathField(relation);
  const child = await findOneRecord(adapter, resource, childId, namespace);
  const oldChildPath = typeof child?.[pathField] === "string" ? child[pathField] as string : "";
  const parent = parentId
    ? await adapter.findOne<Record<string, unknown>>({
        model: parentResource ?? resource,
        where: [{ field: "id", operator: "eq", value: parentId }],
        namespace,
      })
    : null;
  const newChildPath = parentId ? joinHtreePath(parent?.[pathField], parentId) : "";
  await adapter.update({
    model: resource,
    where: [{ field: "id", operator: "eq", value: childId }],
    data: {
      [htreeFkField(relation)]: parentId,
      [pathField]: newChildPath,
      ...fkResourcePatch(relation, "from", parentResource),
    },
    namespace,
  });
  await updateHtreeDescendantPaths(
    adapter,
    relation,
    resource,
    childId,
    oldChildPath,
    newChildPath,
    namespace,
  );
}

// ─── Relation Capability Helpers (JRT-001/002/003/004, SEC-001) ───────────────

/**
 * Returns the resolved (canonical-ordered, deduplicated) relation capabilities
 * for a relation definition. Schema is already validated at this point.
 */
function getResolvedRelationCaps(relation: DatafnRelationSchema): RelationSimpleCapability[] {
  const caps = relation.capabilities as string[] | undefined;
  if (!caps || caps.length === 0) return [];
  // Canonical order: timestamps first, then audit
  const result: RelationSimpleCapability[] = [];
  if (caps.includes("timestamps")) result.push("timestamps");
  if (caps.includes("audit")) result.push("audit");
  return result;
}

/**
 * JRT-001 / SEC-001: Strip readonly relation capability fields from
 * client-provided metadata. Only strips fields for enabled capabilities.
 */
function stripRelationCapabilityFields(
  metadata: Record<string, unknown>,
  caps: RelationSimpleCapability[],
): Record<string, unknown> {
  if (caps.length === 0) return metadata;
  const stripped = { ...metadata };
  for (const cap of caps) {
    for (const fieldDef of RELATION_CAPABILITY_FIELD_DEFS[cap]) {
      delete stripped[fieldDef.name];
    }
  }
  return stripped;
}

/**
 * JRT-002 / SEC-001: Build create-time capability fields (all four when enabled).
 * actorId must come from server context — never from client payload.
 */
function buildRelationCapabilityCreateFields(
  caps: RelationSimpleCapability[],
  actorId?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const now = Date.now();
  for (const cap of caps) {
    if (cap === "timestamps") {
      fields.createdAt = now;
      fields.updatedAt = now;
    } else if (cap === "audit") {
      fields.createdBy = actorId ?? null;
      fields.updatedBy = actorId ?? null;
    }
  }
  return fields;
}

/**
 * JRT-003 / JRT-004 / SEC-001: Build update-time capability fields only.
 * Immutable insert-time fields (createdAt/createdBy) are NOT included.
 */
function buildRelationCapabilityUpdateFields(
  caps: RelationSimpleCapability[],
  actorId?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const cap of caps) {
    if (cap === "timestamps") {
      fields.updatedAt = Date.now();
    } else if (cap === "audit") {
      fields.updatedBy = actorId ?? null;
    }
  }
  return fields;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find relation definition for relation mutation execution.
 */
function findRelation(
  schema: DatafnSchema,
  resource: string,
  relationName: string,
): DatafnRelationMatch | undefined {
  return findRelationMatch(schema, resource, relationName);
}

function fkFieldForOneMany(relation: DatafnRelationSchema): string {
  return relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
}

function relationNameFor(relation: DatafnRelationSchema): string {
  return relation.relation ?? relation.inverse ?? firstEndpoint(relation.to);
}

function resolveManyManyPair(
  schema: DatafnSchema,
  relation: DatafnRelationSchema,
  direction: DatafnRelationDirection,
  mutationResource: string,
  mutationId: string,
  item: NormalizedRelation,
): {
  fromId: string;
  toId: string;
  fromResource: string;
  toResource: string;
  tableName: string;
  joinStoreKey: string;
} | null {
  const fromId = direction === "forward" ? mutationId : item.toId;
  const toId = direction === "forward" ? item.toId : mutationId;
  const fromResource = direction === "forward"
    ? mutationResource
    : resourceNameForId(schema, relation.from, fromId);
  const toResource = direction === "forward"
    ? resourceNameForId(schema, relation.to, toId)
    : mutationResource;
  if (!fromResource || !toResource) return null;
  return {
    fromId,
    toId,
    fromResource,
    toResource,
    tableName: getRelationJoinTableName(relation, fromResource),
    joinStoreKey: getJoinStoreKey(fromResource, relationNameFor(relation), toResource),
  };
}

function relationDiscriminatorFields(
  relation: DatafnRelationSchema,
  pair: ReturnType<typeof resolveManyManyPair> extends infer T ? NonNullable<T> : never,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (endpointList(relation.from).length > 1) {
    fields.fromResource = pair.fromResource;
  }
  if (endpointList(relation.to).length > 1) {
    fields.toResource = pair.toResource;
  }
  return fields;
}

function relationIdentityMetadataFields(relation: DatafnRelationSchema): string[] {
  return [...(relation.identityMetadata ?? [])];
}

function hasRelationIdentityMetadata(
  relation: DatafnRelationSchema,
  item: NormalizedRelation,
): boolean {
  const identityFields = relationIdentityMetadataFields(relation);
  if (identityFields.length === 0) return false;
  return identityFields.every((field) =>
    Object.prototype.hasOwnProperty.call(item.metadata, field)
  );
}

function relationIdentityMetadataValues(
  relation: DatafnRelationSchema,
  item: NormalizedRelation,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of relationIdentityMetadataFields(relation)) {
    if (Object.prototype.hasOwnProperty.call(item.metadata, field)) {
      values[field] = item.metadata[field];
    }
  }
  return values;
}

function relationIdentityValueKey(value: unknown): string {
  if (value === null || value === undefined) return "";
  return encodeURIComponent(String(value));
}

function manyManyCompositeId(
  relation: DatafnRelationSchema,
  pair: ReturnType<typeof resolveManyManyPair> extends infer T ? NonNullable<T> : never,
  item: NormalizedRelation,
): string {
  const identityFields = hasRelationIdentityMetadata(relation, item)
    ? relationIdentityMetadataFields(relation)
    : [];
  if (identityFields.length === 0) return `${pair.fromId}:${pair.toId}`;
  const identitySuffix = identityFields
    .map((field) => `${field}=${relationIdentityValueKey(item.metadata[field])}`)
    .join(":");
  return `${pair.fromId}:${pair.toId}:${identitySuffix}`;
}

function manyManyWhere(
  relation: DatafnRelationSchema,
  pair: ReturnType<typeof resolveManyManyPair> extends infer T ? NonNullable<T> : never,
  item: NormalizedRelation,
  fromCol: string,
  toCol: string,
): Array<{ field: string; operator: "eq"; value: unknown }> {
  const where: Array<{ field: string; operator: "eq"; value: unknown }> = [
    { field: fromCol, operator: "eq", value: pair.fromId },
    { field: toCol, operator: "eq", value: pair.toId },
  ];
  for (const [field, value] of Object.entries(relationDiscriminatorFields(relation, pair))) {
    where.push({ field, operator: "eq", value });
  }
  if (hasRelationIdentityMetadata(relation, item)) {
    for (const [field, value] of Object.entries(relationIdentityMetadataValues(relation, item))) {
      where.push({ field, operator: "eq", value });
    }
  }
  return where;
}

function relationDeletePolicy(
  relation: DatafnRelationSchema,
  side: "from" | "to",
): RelationDeletePolicy | undefined {
  const policy = relation.onDelete;
  if (typeof policy === "string") return policy as RelationDeletePolicy;
  if (policy && typeof policy === "object") {
    return policy[side] as RelationDeletePolicy | undefined;
  }
  return undefined;
}

function joinTablesForDeletedResource(
  relation: DatafnRelationSchema,
  deletedResource: string,
  side: "from" | "to",
): string[] {
  if (relation.joinTable) {
    return [relation.joinTable];
  }
  const fromResources = side === "from"
    ? [deletedResource]
    : endpointList(relation.from);
  return fromResources.map((fromResource) =>
    getRelationJoinTableName(relation, fromResource),
  );
}

async function applyFkDeletePolicy(options: {
  adapter: Adapter;
  schema: DatafnSchema;
  relation: DatafnRelationSchema;
  policy: RelationDeletePolicy;
  resources: string[];
  fkField: string;
  deletedId: string;
  namespace: string;
  visited: Set<string>;
  changes: RelationMutationChange[];
  extraNullFields?: Record<string, unknown>;
  resourceField?: string;
  deletedResource?: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
  const {
    adapter,
    schema,
    relation,
    policy,
    resources,
    fkField,
    deletedId,
    namespace,
    visited,
    changes,
    extraNullFields,
    resourceField,
    deletedResource,
  } = options;

  for (const resource of resources) {
    const where = [{ field: fkField, operator: "eq" as const, value: deletedId }];
    if (resourceField && deletedResource) {
      where.push({ field: resourceField, operator: "eq", value: deletedResource });
    }
    const rows = await adapter.findMany({
      model: resource,
      where,
      namespace,
    });

    if (rows.length > 0 && policy === "restrict") {
      return {
        ok: false,
        code: "RELATION_RESTRICTED",
        message: `Cannot delete ${deletedId}; relation "${relation.relation ?? relation.inverse ?? relation.type}" still references it`,
        path: "id",
      };
    }

    if (policy === "setNull" || policy === "detach") {
      for (const row of rows) {
        const rowId = String(row.id ?? "");
        if (!rowId) continue;
        const record = {
          id: rowId,
          [fkField]: null,
          ...(extraNullFields ?? {}),
        };
        await adapter.update({
          model: resource,
          where: [{ field: "id", operator: "eq", value: rowId }],
          data: record,
          namespace,
        });
        changes.push({
          resource,
          id: rowId,
          op: "merge",
          record,
        });
      }
    } else if (policy === "cascade") {
      for (const row of rows) {
        const rowId = String(row.id ?? "");
        if (!rowId) continue;
        const cascadeResult = await deleteRecordWithRelationPolicies({
          adapter,
          schema,
          resource,
          id: rowId,
          namespace,
          visited,
          changes,
        });
        if (!cascadeResult.ok) return cascadeResult;
      }
    }
  }

  return { ok: true };
}

async function deleteRecordWithRelationPolicies(options: {
  adapter: Adapter;
  schema: DatafnSchema;
  resource: string;
  id: string;
  namespace: string;
  visited: Set<string>;
  changes: RelationMutationChange[];
}): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
  const { adapter, schema, resource, id, namespace, visited, changes } = options;
  const visitKey = `${resource}:${id}`;
  if (visited.has(visitKey)) return { ok: true };
  visited.add(visitKey);

  const policyResult = await applyRelationDeletePolicies(
    adapter,
    schema,
    resource,
    id,
    namespace,
    visited,
  );
  if (!policyResult.ok) return policyResult;

  await adapter.delete({
    model: resource,
    where: [{ field: "id", operator: "eq", value: id }],
    namespace,
  });
  changes.push({
    resource,
    id,
    op: "delete",
    record: null,
  });
  changes.push(...policyResult.changes);
  return { ok: true };
}

async function validateFkDeletePolicy(options: {
  adapter: Adapter;
  schema: DatafnSchema;
  relation: DatafnRelationSchema;
  policy: RelationDeletePolicy;
  resources: string[];
  fkField: string;
  deletedId: string;
  namespace: string;
  visited: Set<string>;
  resourceField?: string;
  deletedResource?: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
  const {
    adapter,
    schema,
    relation,
    policy,
    resources,
    fkField,
    deletedId,
    namespace,
    visited,
    resourceField,
    deletedResource,
  } = options;

  for (const resource of resources) {
    const where = [{ field: fkField, operator: "eq" as const, value: deletedId }];
    if (resourceField && deletedResource) {
      where.push({ field: resourceField, operator: "eq", value: deletedResource });
    }
    const rows = await adapter.findMany({ model: resource, where, namespace });
    if (rows.length > 0 && policy === "restrict") {
      return {
        ok: false,
        code: "RELATION_RESTRICTED",
        message: `Cannot delete ${deletedId}; relation "${relation.relation ?? relation.inverse ?? relation.type}" still references it`,
        path: "id",
      };
    }
    if (policy === "cascade") {
      for (const row of rows) {
        const rowId = String(row.id ?? "");
        if (!rowId) continue;
        const nested = await validateRelationDeletePolicies(
          adapter,
          schema,
          resource,
          rowId,
          namespace,
          visited,
        );
        if (!nested.ok) return nested;
      }
    }
  }
  return { ok: true };
}

async function validateRelationDeletePolicies(
  adapter: Adapter,
  schema: DatafnSchema,
  resource: string,
  id: string,
  namespace: string,
  visited: Set<string> = new Set(),
): Promise<{ ok: true } | { ok: false; code: string; message: string; path: string }> {
  const visitKey = `${resource}:${id}`;
  if (visited.has(visitKey)) return { ok: true };
  visited.add(visitKey);

  for (const relation of schema.relations ?? []) {
    if (relation.type === "many-many") {
      const side = endpointIncludes(relation.from, resource)
        ? "from"
        : endpointIncludes(relation.to, resource)
          ? "to"
          : null;
      if (!side) continue;
      const policy = relationDeletePolicy(relation, side);
      if (policy !== "restrict") continue;
      const filterField = side === "from"
        ? relation.joinColumns?.from || "from"
        : relation.joinColumns?.to || "to";
      for (const tableName of joinTablesForDeletedResource(relation, resource, side)) {
        const discriminatorField = side === "from" ? "fromResource" : "toResource";
        const sideEndpoint = side === "from" ? relation.from : relation.to;
        const rows = await adapter.findMany({
          model: tableName,
          where: [
            { field: filterField, operator: "eq", value: id },
            ...(endpointIsPolymorphic(sideEndpoint)
              ? [{ field: discriminatorField, operator: "eq" as const, value: resource }]
              : []),
          ],
          namespace,
        });
        if (rows.length > 0) {
          return {
            ok: false,
            code: "RELATION_RESTRICTED",
            message: `Cannot delete ${id}; relation "${relation.relation ?? relation.type}" still references it`,
            path: "id",
          };
        }
      }
    } else if (relation.type === "many-one" && endpointIncludes(relation.to, resource)) {
      const policy = relationDeletePolicy(relation, "to");
      if (!policy) continue;
      const result = await validateFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.from),
        fkField: relationFkFieldForManyOne(relation),
        deletedId: id,
        namespace,
        visited,
        resourceField: endpointIsPolymorphic(relation.to)
          ? fkResourceFieldForRelation(relation, "to")
          : undefined,
        deletedResource: resource,
      });
      if (!result.ok) return result;
    } else if (relation.type === "one-many" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      const result = await validateFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.to),
        fkField: fkFieldForOneMany(relation),
        deletedId: id,
        namespace,
        visited,
        resourceField: endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        deletedResource: resource,
      });
      if (!result.ok) return result;
    } else if (relation.type === "htree" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      const result = await validateFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.to),
        fkField: htreeFkField(relation),
        deletedId: id,
        namespace,
        visited,
        resourceField: endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        deletedResource: resource,
      });
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

/**
 * Applies declared relation delete policies before deleting a record.
 */
export async function applyRelationDeletePolicies(
  adapter: Adapter,
  schema: DatafnSchema,
  resource: string,
  id: string,
  namespace: string,
  visited: Set<string> = new Set(),
): Promise<
  | { ok: true; changes: RelationMutationChange[] }
  | { ok: false; code: string; message: string; path: string }
> {
  const validation = await validateRelationDeletePolicies(
    adapter,
    schema,
    resource,
    id,
    namespace,
  );
  if (!validation.ok) return validation;

  const changes: RelationMutationChange[] = [];

  for (const relation of schema.relations ?? []) {
    if (relation.type === "many-many") {
      const side = endpointIncludes(relation.from, resource)
        ? "from"
        : endpointIncludes(relation.to, resource)
          ? "to"
          : null;
      if (!side) continue;
      const policy = relationDeletePolicy(relation, side);
      if (!policy) continue;

      const fromCol = relation.joinColumns?.from || "from";
      const toCol = relation.joinColumns?.to || "to";
      const filterField = side === "from" ? fromCol : toCol;

      for (const tableName of joinTablesForDeletedResource(relation, resource, side)) {
        const discriminatorField = side === "from" ? "fromResource" : "toResource";
        const sideEndpoint = side === "from" ? relation.from : relation.to;
        const rows = await adapter.findMany({
          model: tableName,
          where: [
            { field: filterField, operator: "eq", value: id },
            ...(endpointIsPolymorphic(sideEndpoint)
              ? [{ field: discriminatorField, operator: "eq" as const, value: resource }]
              : []),
          ],
          namespace,
        });

        if (rows.length > 0 && policy === "restrict") {
          return {
            ok: false,
            code: "RELATION_RESTRICTED",
            message: `Cannot delete ${id}; relation "${relation.relation ?? relation.type}" still references it`,
            path: "id",
          };
        }

        if (policy === "detach" || policy === "cascade" || policy === "setNull") {
          for (const row of rows) {
            const fromId = String(row[fromCol] ?? "");
            const toId = String(row[toCol] ?? "");
            if (!fromId || !toId) continue;
            const fromResource = resolveEndpointResource(relation.from, fromId, schema);
            const toResource = resolveEndpointResource(relation.to, toId, schema);
            if (!fromResource || !toResource) continue;
            const rowId = String(row.id ?? `${fromId}:${toId}`);
            await adapter.delete({
              model: tableName,
              where: [{ field: "id", operator: "eq", value: rowId }],
              namespace,
            });
            changes.push({
              resource: getJoinStoreKey(fromResource, relationNameFor(relation), toResource),
              id: `${fromId}:${toId}`,
              op: "delete",
              record: null,
            });
          }
        }
      }
    } else if (relation.type === "many-one" && endpointIncludes(relation.to, resource)) {
      const policy = relationDeletePolicy(relation, "to");
      if (!policy) continue;
      const fkResult = await applyFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.from),
        fkField: relation.fkField || relation.foreignKey || `${relation.relation ?? firstEndpoint(relation.to)}Id`,
        deletedId: id,
        namespace,
        visited,
        changes,
        extraNullFields: fkResourcePatch(relation, "to", null),
        resourceField: endpointIsPolymorphic(relation.to)
          ? fkResourceFieldForRelation(relation, "to")
          : undefined,
        deletedResource: resource,
      });
      if (!fkResult.ok) return fkResult;
    } else if (relation.type === "one-many" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      const fkResult = await applyFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.to),
        fkField: fkFieldForOneMany(relation),
        deletedId: id,
        namespace,
        visited,
        changes,
        extraNullFields: fkResourcePatch(relation, "from", null),
        resourceField: endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        deletedResource: resource,
      });
      if (!fkResult.ok) return fkResult;
    } else if (relation.type === "htree" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      const fkResult = await applyFkDeletePolicy({
        adapter,
        schema,
        relation,
        policy,
        resources: endpointList(relation.to),
        fkField: htreeFkField(relation),
        deletedId: id,
        namespace,
        visited,
        changes,
        extraNullFields: {
          [htreePathField(relation)]: "",
          ...fkResourcePatch(relation, "from", null),
        },
        resourceField: endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        deletedResource: resource,
      });
      if (!fkResult.ok) return fkResult;
    }
  }

  return { ok: true, changes };
}

/**
 * Execute relate operation
 */
export async function executeRelate(
  adapter: Adapter,
  schema: DatafnSchema,
  mutation: DFQLMutation,
  namespace: string,
  actorId?: string,
): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
  if (!mutation.relations) {
    return { ok: true, affectedIds: [mutation.id] };
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match) {
      return {
        ok: false,
        code: "DFQL_UNKNOWN_RELATION",
        message: `Unknown relation: ${relName}`,
        path: `relations.${relName}`,
      };
    }
    const relation = match.relation;
    const direction = match.direction;

    const items = normalizeRelationPayload(payload);

    if (items.length > 0) {
      const validation = await validateRelationTargets(
        adapter,
        schema,
        relationTargetEndpoint(relation, direction),
        items,
        namespace,
        `relations.${relName}`,
      );
      if (!validation.ok) return validation;
    }

    if (relation.type === "many-one" && direction === "forward") {
      // Update FK on source record (mutation.id)
      // Expect single target
      if (items.length !== 1) {
        return {
          ok: false,
          code: "DFQL_INVALID",
          message: "many-one relation expects single target",
          path: `relations.${relName}`,
        };
      }
      const fkField = relation.fkField || relation.foreignKey || `${relName}Id`; // Default convention or schema
      const targetResource = resourceNameForId(schema, relation.to, items[0].toId);
      // We assume adapter update handles simple field update
      await adapter.update({
        model: mutation.resource,
        where: [{ field: "id", operator: "eq", value: mutation.id }],
        data: {
          [fkField]: items[0].toId,
          ...fkResourcePatch(relation, "to", targetResource ?? null),
        },
        namespace,
      });
    } else if (relation.type === "many-one" && direction === "inverse") {
      const fkField = relationFkFieldForManyOne(relation);
      for (const item of items) {
        const targetResource = resourceNameForId(schema, relation.from, item.toId);
        if (!targetResource) {
          return {
            ok: false,
            code: "DFQL_INVALID",
            message: `Invalid relation target: ${item.toId}`,
            path: `relations.${relName}`,
          };
        }
        await adapter.update({
          model: targetResource,
          where: [{ field: "id", operator: "eq", value: item.toId }],
          data: {
            [fkField]: mutation.id,
            ...fkResourcePatch(relation, "to", mutation.resource),
          },
          namespace,
        });
      }
    } else if (relation.type === "one-many" && direction === "forward") {
      // Update FK on target records (to point to mutation.id)
      const fkField = fkFieldForOneMany(relation);
      // PER-004: Batch update when adapter supports it and there are multiple items
      const targetIdsByResource = new Map<string, string[]>();
      for (const item of items) {
        const targetResource = resourceNameForId(schema, relation.to, item.toId);
        if (!targetResource) {
          return {
            ok: false,
            code: "DFQL_INVALID",
            message: `Invalid relation target: ${item.toId}`,
            path: `relations.${relName}`,
          };
        }
        const ids = targetIdsByResource.get(targetResource) ?? [];
        ids.push(item.toId);
        targetIdsByResource.set(targetResource, ids);
      }
      for (const [targetResource, targetIds] of targetIdsByResource.entries()) {
        if (targetIds.length > 1 && adapter.capabilities.operations.batch) {
          await adapter.updateMany({
            model: targetResource,
            where: [{ field: "id", operator: "in", value: targetIds }],
            data: {
              [fkField]: mutation.id,
              ...fkResourcePatch(relation, "from", mutation.resource),
            },
            namespace,
          });
        } else {
          for (const targetId of targetIds) {
            await adapter.update({
            model: targetResource,
            where: [{ field: "id", operator: "eq", value: targetId }],
            data: {
              [fkField]: mutation.id,
              ...fkResourcePatch(relation, "from", mutation.resource),
            },
            namespace,
          });
          }
        }
      }
    } else if (relation.type === "one-many" && direction === "inverse") {
      if (items.length !== 1) {
        return {
          ok: false,
          code: "DFQL_INVALID",
          message: "one-many inverse relation expects single target",
          path: `relations.${relName}`,
        };
      }
      const fkField = fkFieldForOneMany(relation);
      const targetResource = resourceNameForId(schema, relation.from, items[0].toId);
      await adapter.update({
        model: mutation.resource,
        where: [{ field: "id", operator: "eq", value: mutation.id }],
        data: {
          [fkField]: items[0].toId,
          ...fkResourcePatch(relation, "from", targetResource ?? null),
        },
        namespace,
      });
    } else if (relation.type === "htree") {
      const isForward =
        endpointIncludes(relation.from, mutation.resource) &&
        relation.relation === relName;
      const treeResource = isForward
        ? pickResourceName(relation.to)
        : pickResourceName(relation.from);
      for (const item of items) {
        await setHtreeParent(
          adapter,
          relation,
          treeResource,
          isForward ? item.toId : mutation.id,
          isForward ? mutation.id : item.toId,
          isForward ? mutation.resource : resourceNameForId(schema, relation.from, item.toId) ?? null,
          namespace,
        );
      }
    } else if (relation.type === "many-many") {
      const fromCol = relation.joinColumns?.from || "from";
      const toCol = relation.joinColumns?.to || "to";

      // JRT-001/002/003: Resolve relation capabilities for this relation
      const relCaps = getResolvedRelationCaps(relation);

      // Use upsert per join item instead of findOne + conditional create/update (REL-OPT-002)
      // Target the `id` column (PK) for conflict detection, not (from, to) which may lack a unique constraint.
      // The composite id `${from}:${to}` guarantees the same uniqueness semantics.
      for (const item of items) {
        const pair = resolveManyManyPair(
          schema,
          relation,
          direction,
          mutation.resource,
          mutation.id,
          item,
        );
        if (!pair) {
          return {
            ok: false,
            code: "DFQL_INVALID",
            message: `Invalid relation target: ${item.toId}`,
            path: `relations.${relName}`,
          };
        }
        const compositeId = manyManyCompositeId(relation, pair, item);
        const usesIdentityMetadata = hasRelationIdentityMetadata(relation, item);
        const relationWhere = usesIdentityMetadata
          ? manyManyWhere(relation, pair, item, fromCol, toCol)
          : [{ field: "id" as const, operator: "eq" as const, value: compositeId }];

        // JRT-001 / SEC-001: Strip readonly capability fields from client-provided metadata
        const strippedMetadata = stripRelationCapabilityFields(item.metadata, relCaps);
        const discriminatorFields = relationDiscriminatorFields(relation, pair);

        // JRT-002: Create payload includes insert-time capability fields
        const createCapFields = buildRelationCapabilityCreateFields(relCaps, actorId);

        // JRT-003: Update payload includes only update-time capability fields (NOT createdAt/createdBy)
        const updateCapFields = buildRelationCapabilityUpdateFields(relCaps, actorId);

        // Build payloads: stripped metadata merged with server-injected capability fields
        const hasUpdateContent =
          Object.keys(strippedMetadata).length > 0 ||
          Object.keys(discriminatorFields).length > 0 ||
          Object.keys(updateCapFields).length > 0;

        await adapter.upsert({
          model: pair.tableName,
          where: relationWhere,
          create: {
            id: compositeId,
            [fromCol]: pair.fromId,
            [toCol]: pair.toId,
            ...strippedMetadata,
            ...discriminatorFields,
            ...createCapFields,
          },
          update: hasUpdateContent
            ? { ...strippedMetadata, ...discriminatorFields, ...updateCapFields }
            : {},
          namespace,
          conflictTarget: usesIdentityMetadata ? undefined : "id",
        });
      }
    }
  }

  return { ok: true, affectedIds: [mutation.id] };
}

/**
 * Execute modifyRelation operation
 */
export async function executeModifyRelation(
  adapter: Adapter,
  schema: DatafnSchema,
  mutation: DFQLMutation,
  namespace: string,
  actorId?: string,
): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
  if (!mutation.relations) {
    return { ok: true, affectedIds: [mutation.id] };
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match) {
        return {
          ok: false,
          code: "DFQL_UNKNOWN_RELATION",
          message: `Unknown relation: ${relName}`,
          path: `relations.${relName}`,
        };
    }
    const relation = match.relation;
    const direction = match.direction;

    if (relation.type !== "many-many") {
         return {
          ok: false,
          code: "DFQL_UNSUPPORTED",
          message: `modifyRelation only supported for many-many relations`,
          path: `relations.${relName}`,
        };
    }

    const items = normalizeRelationPayload(payload);
    const fromCol = relation.joinColumns?.from || "from";
    const toCol = relation.joinColumns?.to || "to";

    // JRT-001/004: Resolve relation capabilities once per relation
    const relCaps = getResolvedRelationCaps(relation);

    for (const item of items) {
      const pair = resolveManyManyPair(
        schema,
        relation,
        direction,
        mutation.resource,
        mutation.id,
        item,
      );
      if (!pair) {
        return {
          ok: false,
          code: "DFQL_INVALID",
          message: `Invalid relation target: ${item.toId}`,
          path: `relations.${relName}`,
        };
      }
      // JRT-001 / SEC-001: Strip readonly capability fields from client-provided metadata
      const strippedMetadata = stripRelationCapabilityFields(item.metadata, relCaps);
      const discriminatorFields = relationDiscriminatorFields(relation, pair);

      // JRT-004: Inject update-time capability fields for existing rows
      const updateCapFields = buildRelationCapabilityUpdateFields(relCaps, actorId);

      // DI-001: Atomic findOne + update to prevent TOCTOU race.
      // Wrap in transaction when adapter supports it; otherwise execute sequentially.
      const performModify = async (
        adp: Adapter | TransactionAdapter,
      ): Promise<"ok" | "not_found"> => {
        const relationWhere = manyManyWhere(relation, pair, item, fromCol, toCol);
        const existing = await adp.findOne({
          model: pair.tableName,
          where: relationWhere,
          namespace,
        });
        if (!existing) return "not_found";
        await adp.update({
          model: pair.tableName,
          where: relationWhere,
          // JRT-004: merge stripped user metadata with server-injected update fields
          data: { ...strippedMetadata, ...discriminatorFields, ...updateCapFields },
          namespace,
        });
        return "ok";
      };

      let itemResult: "ok" | "not_found";
      // DI-001: capabilities.transactions.supported === false means explicitly no support (e.g. memoryAdapter).
      // If capabilities are absent/incomplete (test mocks), fall back to duck-typing.
      if ((adapter.capabilities?.transactions?.supported !== false) && typeof adapter.transaction === "function") {
        let txOutcome: "ok" | "not_found" = "ok";
        await adapter.transaction(async (txAdp: TransactionAdapter) => {
          txOutcome = await performModify(txAdp);
        });
        itemResult = txOutcome;
      } else {
        itemResult = await performModify(adapter);
      }

      if (itemResult === "not_found") {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: `Relation not found between ${pair.fromId} and ${pair.toId}`,
          path: `relations.${relName}`,
        };
      }
    }
  }
  return { ok: true, affectedIds: [mutation.id] };
}

/**
 * Minimal mutation shape needed for change-delta helpers
 */
interface RelationMutationInput {
  operation: string;
  resource: string;
  id: string;
  relations?: Record<string, unknown>;
}

export function collectInactivePropagationSeeds(
  mutation: RelationMutationInput,
  schema: DatafnSchema,
): Array<{ resource: string; id: string }> {
  const seeds = new Map<string, { resource: string; id: string }>();
  const addSeed = (resource: string | undefined, id: string | undefined) => {
    if (!resource || !id) return;
    seeds.set(`${resource}:${id}`, { resource, id });
  };
  addSeed(mutation.resource, mutation.id);
  if (!mutation.relations) return [...seeds.values()];
  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match) continue;
    const relation = match.relation;
    const targetEndpoint = match.direction === "forward" ? relation.to : relation.from;
    for (const item of normalizeRelationPayload(payload)) {
      addSeed(resourceNameForId(schema, targetEndpoint, item.toId) ?? pickResourceName(targetEndpoint), item.toId);
    }
  }
  return [...seeds.values()];
}

/**
 * Extract join deltas for a relation mutation (many-many only).
 * Returns array of { resource, id, op, record } for join store changes.
 * Used by change-tracking in both push.ts and execute.ts.
 */
export function extractJoinDeltas(
  mutation: RelationMutationInput,
  schema: DatafnSchema,
): Array<{
  resource: string;
  id: string;
  op: "upsert" | "delete";
  record: Record<string, unknown> | null;
}> {
  const deltas: Array<{
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }> = [];

  if (!mutation.relations) {
    return deltas;
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match) {
      continue;
    }
    const relation = match.relation;
    const direction = match.direction;

    // Only many-many relations produce join deltas
    if (relation.type !== "many-many") {
      continue;
    }

    const items = normalizeRelationPayload(payload);

    for (const item of items) {
      const pair = resolveManyManyPair(
        schema,
        relation,
        direction,
        mutation.resource,
        mutation.id,
        item,
      );
      if (!pair) continue;
      const compositeId = manyManyCompositeId(relation, pair, item);

      if (mutation.operation === "relate" || mutation.operation === "modifyRelation") {
        deltas.push({
          resource: pair.joinStoreKey,
          id: compositeId,
          op: "upsert",
          record: {
            from: pair.fromId,
            to: pair.toId,
            ...relationDiscriminatorFields(relation, pair),
            ...item.metadata,
          },
        });
      } else if (mutation.operation === "unrelate") {
        deltas.push({
          resource: pair.joinStoreKey,
          id: compositeId,
          op: "delete",
          record: {
            from: pair.fromId,
            to: pair.toId,
          },
        });
      }
    }
  }

  return deltas;
}

/**
 * Extract FK change deltas for relation mutations on non-many-many relations.
 *
 * - many-one relate:   merge on source resource with FK = target id
 * - many-one unrelate: merge on source resource with FK = null
 * - one-many relate:   merge on each target resource with FK = source id
 * - one-many unrelate: merge on each target resource with FK = null
 * - many-many / modifyRelation: returns empty (join deltas handle propagation)
 *
 * Used by change-tracking in both push.ts and execute.ts to avoid recording a
 * spurious { op: "upsert", record: { id } } entry for the primary resource,
 * which would overwrite full records on other clients (FIX-REL-001).
 */
export function extractRelationFkDeltas(
  mutation: RelationMutationInput,
  schema: DatafnSchema,
): Array<{
  resource: string;
  id: string;
  op: "merge";
  record: Record<string, unknown>;
}> {
  const deltas: Array<{
    resource: string;
    id: string;
    op: "merge";
    record: Record<string, unknown>;
  }> = [];

  if (!mutation.relations) {
    return deltas;
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match) {
      continue;
    }
    const relation = match.relation;
    const direction = match.direction;

    // many-many: join deltas handle propagation; no FK on primary resource changes
    // modifyRelation: only applies to many-many, so also skip
    if (relation.type === "many-many" || mutation.operation === "modifyRelation") {
      continue;
    }

    const items = normalizeRelationPayload(payload);

    if (relation.type === "many-one" && direction === "forward") {
      // FK lives on the source record (mutation.resource)
      const fkField = relation.fkField || relation.foreignKey || `${relName}Id`;
      const fkValue = mutation.operation === "unrelate" ? null : (items[0]?.toId ?? null);
      const targetResource = mutation.operation === "unrelate"
        ? null
        : (typeof fkValue === "string" ? resourceNameForId(schema, relation.to, fkValue) : null);
      deltas.push({
        resource: mutation.resource,
        id: mutation.id,
        op: "merge",
        record: {
          id: mutation.id,
          [fkField]: fkValue,
          ...fkResourcePatch(relation, "to", targetResource ?? null),
        },
      });
    } else if (relation.type === "many-one" && direction === "inverse") {
      const fkField = relationFkFieldForManyOne(relation);
      const fkValue = mutation.operation === "unrelate" ? null : mutation.id;
      for (const item of items) {
        const targetResource = resourceNameForId(schema, relation.from, item.toId);
        if (!targetResource) continue;
        deltas.push({
          resource: targetResource,
          id: item.toId,
          op: "merge",
          record: {
            id: item.toId,
            [fkField]: fkValue,
            ...fkResourcePatch(relation, "to", mutation.operation === "unrelate" ? null : mutation.resource),
          },
        });
      }
    } else if (relation.type === "one-many" && direction === "forward") {
      // FK lives on each target record (relation.to)
      const fkField = fkFieldForOneMany(relation);
      const fkValue = mutation.operation === "unrelate" ? null : mutation.id;
      for (const item of items) {
        const targetResource = resourceNameForId(schema, relation.to, item.toId);
        if (!targetResource) continue;
        deltas.push({
          resource: targetResource,
          id: item.toId,
          op: "merge",
          record: {
            id: item.toId,
            [fkField]: fkValue,
            ...fkResourcePatch(relation, "from", mutation.operation === "unrelate" ? null : mutation.resource),
          },
        });
      }
    } else if (relation.type === "one-many" && direction === "inverse") {
      const fkField = fkFieldForOneMany(relation);
      const fkValue = mutation.operation === "unrelate" ? null : (items[0]?.toId ?? null);
      const targetResource = mutation.operation === "unrelate"
        ? null
        : (typeof fkValue === "string" ? resourceNameForId(schema, relation.from, fkValue) : null);
      deltas.push({
        resource: mutation.resource,
        id: mutation.id,
        op: "merge",
        record: {
          id: mutation.id,
          [fkField]: fkValue,
          ...fkResourcePatch(relation, "from", targetResource ?? null),
        },
      });
    } else if (relation.type === "htree") {
      const fkField = htreeFkField(relation);
      const isForward =
        endpointIncludes(relation.from, mutation.resource) &&
        relation.relation === relName;
      for (const item of items) {
        const resource = isForward ? pickResourceName(relation.to) : mutation.resource;
        const id = isForward ? item.toId : mutation.id;
        const fkValue = mutation.operation === "unrelate"
          ? null
          : isForward ? mutation.id : item.toId;
        const parentResource = mutation.operation === "unrelate"
          ? null
          : isForward ? mutation.resource : resourceNameForId(schema, relation.from, item.toId) ?? null;
        deltas.push({
          resource,
          id,
          op: "merge",
          record: {
            id,
            [fkField]: fkValue,
            ...fkResourcePatch(relation, "from", parentResource),
          },
        });
      }
    }
  }

  return deltas;
}

export async function extractRelationRecordDeltasFromDB(
  adapter: Adapter,
  mutation: RelationMutationInput,
  schema: DatafnSchema,
  namespace: string,
): Promise<Array<{
  resource: string;
  id: string;
  op: "merge";
  record: Record<string, unknown>;
}>> {
  const deltas = new Map<string, {
    resource: string;
    id: string;
    op: "merge";
    record: Record<string, unknown>;
  }>();
  const addRecord = async (
    resource: string,
    id: string,
    fallback?: Record<string, unknown>,
  ) => {
    const record = await findOneRecord(adapter, resource, id, namespace);
    const nextRecord = record ?? fallback;
    if (!nextRecord) return;
    deltas.set(`${resource}:${id}`, {
      resource,
      id,
      op: "merge",
      record: { id, ...nextRecord },
    });
  };
  for (const delta of extractRelationFkDeltas(mutation, schema)) {
    await addRecord(delta.resource, delta.id, delta.record);
  }
  if (!mutation.relations) return [...deltas.values()];
  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match || match.relation.type !== "htree") continue;
    const relation = match.relation;
    const pathField = htreePathField(relation);
    const isForward =
      endpointIncludes(relation.from, mutation.resource) &&
      relation.relation === relName;
    for (const item of normalizeRelationPayload(payload)) {
      const childResource = isForward ? pickResourceName(relation.to) : mutation.resource;
      const childId = isForward ? item.toId : mutation.id;
      const child = await findOneRecord(adapter, childResource, childId, namespace);
      if (!child) continue;
      await addRecord(childResource, childId, child);
      const childPrefix = joinHtreePath(child[pathField], childId);
      const descendants = (await listRecords(adapter, childResource, namespace)).filter((record) => {
        const recordPath = record[pathField];
        return typeof recordPath === "string" &&
          (recordPath === childPrefix || recordPath.startsWith(`${childPrefix}-`));
      });
      for (const descendant of descendants) {
        await addRecord(childResource, descendant.id as string, descendant);
      }
    }
  }
  return [...deltas.values()];
}

/**
 * JSY-002: Extract join deltas by reading actual persisted join rows from DB.
 * Unlike extractJoinDeltas (which reflects client payload), this function reads
 * back the full row after the write, so the change-tracking record includes
 * server-injected relation capability fields (createdAt, updatedAt, createdBy,
 * updatedBy).
 *
 * Used by push.ts for `relate` and `modifyRelation` cases only.
 * `unrelate` (delete ops) continues to use extractJoinDeltas — no DB read needed.
 */
export async function extractJoinDeltasFromDB(
  adapter: Adapter,
  mutation: RelationMutationInput,
  schema: DatafnSchema,
  namespace: string,
): Promise<
  Array<{
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }>
> {
  const deltas: Array<{
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }> = [];

  if (!mutation.relations) {
    return deltas;
  }

  for (const [relName, payload] of Object.entries(mutation.relations)) {
    const match = findRelation(schema, mutation.resource, relName);
    if (!match || match.relation.type !== "many-many") {
      continue;
    }
    const relation = match.relation;
    const direction = match.direction;

    const items = normalizeRelationPayload(payload);
    const fromCol = relation.joinColumns?.from || "from";
    const toCol = relation.joinColumns?.to || "to";

    for (const item of items) {
      const pair = resolveManyManyPair(
        schema,
        relation,
        direction,
        mutation.resource,
        mutation.id,
        item,
      );
      if (!pair) continue;
      const compositeId = manyManyCompositeId(relation, pair, item);
      const rowWhere = hasRelationIdentityMetadata(relation, item)
        ? manyManyWhere(relation, pair, item, fromCol, toCol)
        : [{ field: "id" as const, operator: "eq" as const, value: compositeId }];

      // Read the actual persisted join row so the change record includes
      // server-injected capability fields (createdAt, updatedAt, createdBy, updatedBy).
      const persistedRow = (await adapter.findOne({
        model: pair.tableName,
        where: rowWhere,
        namespace,
      })) as Record<string, unknown> | null;

      let record: Record<string, unknown>;
      if (persistedRow) {
        // Normalize custom joinColumns to standard from/to keys for client-side change records.
        record = { ...persistedRow };
        if (fromCol !== "from") {
          record.from = record[fromCol];
          delete record[fromCol];
        }
        if (toCol !== "to") {
          record.to = record[toCol];
          delete record[toCol];
        }
      } else {
        // Row should exist after a successful write; use a minimal record when unavailable.
        record = { from: pair.fromId, to: pair.toId };
      }

      deltas.push({
        resource: pair.joinStoreKey,
        id: compositeId,
        op: "upsert",
        record,
      });
    }
  }

  return deltas;
}

/**
 * Execute unrelate operation
 */
export async function executeUnrelate(
    adapter: Adapter,
    schema: DatafnSchema,
    mutation: DFQLMutation,
    namespace: string,
  ): Promise<{ ok: true; affectedIds: string[] } | { ok: false; code: string; message: string; path: string }> {
    if (!mutation.relations) {
      return { ok: true, affectedIds: [mutation.id] };
    }
  
    for (const [relName, payload] of Object.entries(mutation.relations)) {
      const match = findRelation(schema, mutation.resource, relName);
      if (!match) {
         return {
            ok: false,
            code: "DFQL_UNKNOWN_RELATION",
            message: `Unknown relation: ${relName}`,
            path: `relations.${relName}`,
          };
      }
      const relation = match.relation;
      const direction = match.direction;
  
      const items = normalizeRelationPayload(payload);
  
      if (relation.type === "many-one" && direction === "forward") {
        // Clear FK on source
        const fkField = relation.fkField || relation.foreignKey || `${relName}Id`;
        await adapter.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: {
            [fkField]: null,
            ...fkResourcePatch(relation, "to", null),
          },
          namespace,
        });
      } else if (relation.type === "many-one" && direction === "inverse") {
        const fkField = relationFkFieldForManyOne(relation);
        for (const item of items) {
          const targetResource = resourceNameForId(schema, relation.from, item.toId);
          if (!targetResource) {
            return {
              ok: false,
              code: "DFQL_INVALID",
              message: `Invalid relation target: ${item.toId}`,
              path: `relations.${relName}`,
            };
          }
          await adapter.update({
            model: targetResource,
            where: [{ field: "id", operator: "eq", value: item.toId }],
            data: {
              [fkField]: null,
              ...fkResourcePatch(relation, "to", null),
            },
            namespace,
          });
        }
      } else if (relation.type === "one-many" && direction === "forward") {
        // Clear FK on target
        const fkField = fkFieldForOneMany(relation);
        // PER-004: Batch update when adapter supports it and there are multiple items
        const targetIdsByResource = new Map<string, string[]>();
        for (const item of items) {
          const targetResource = resourceNameForId(schema, relation.to, item.toId);
          if (!targetResource) {
            return {
              ok: false,
              code: "DFQL_INVALID",
              message: `Invalid relation target: ${item.toId}`,
              path: `relations.${relName}`,
            };
          }
          const ids = targetIdsByResource.get(targetResource) ?? [];
          ids.push(item.toId);
          targetIdsByResource.set(targetResource, ids);
        }
        for (const [targetResource, targetIds] of targetIdsByResource.entries()) {
          if (targetIds.length > 1 && adapter.capabilities.operations.batch) {
            await adapter.updateMany({
              model: targetResource,
              where: [{ field: "id", operator: "in", value: targetIds }],
              data: {
                [fkField]: null,
                ...fkResourcePatch(relation, "from", null),
              },
              namespace,
            });
          } else {
            for (const targetId of targetIds) {
              await adapter.update({
                model: targetResource,
                where: [{ field: "id", operator: "eq", value: targetId }],
                data: {
                  [fkField]: null,
                  ...fkResourcePatch(relation, "from", null),
                },
                namespace,
              });
            }
          }
        }
      } else if (relation.type === "one-many" && direction === "inverse") {
        const fkField = fkFieldForOneMany(relation);
        await adapter.update({
          model: mutation.resource,
          where: [{ field: "id", operator: "eq", value: mutation.id }],
          data: {
            [fkField]: null,
            ...fkResourcePatch(relation, "from", null),
          },
          namespace,
        });
      } else if (relation.type === "htree") {
        const isForward =
          endpointIncludes(relation.from, mutation.resource) &&
          relation.relation === relName;
        const treeResource = isForward
          ? pickResourceName(relation.to)
          : pickResourceName(relation.from);
        for (const item of items) {
          await setHtreeParent(
            adapter,
            relation,
            treeResource,
            isForward ? item.toId : mutation.id,
            null,
            null,
            namespace,
          );
        }
      } else if (relation.type === "many-many") {
        const fromCol = relation.joinColumns?.from || "from";
        const toCol = relation.joinColumns?.to || "to";

        for (const item of items) {
          const pair = resolveManyManyPair(
            schema,
            relation,
            direction,
            mutation.resource,
            mutation.id,
            item,
          );
          if (!pair) {
            return {
              ok: false,
              code: "DFQL_INVALID",
              message: "Invalid relation target",
              path: `relations.${relName}`,
            };
          }
          await adapter.delete({
            model: pair.tableName,
            where: manyManyWhere(relation, pair, item, fromCol, toCol),
            namespace,
          });
        }
      }
    }
  
    return { ok: true, affectedIds: [mutation.id] };
  }
