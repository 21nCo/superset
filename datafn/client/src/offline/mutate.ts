/**
 * Offline Mutation Logic
 *
 * Handles offline mutations by:
 * 1. Appending to offline changelog
 * 2. Performing optimistic local write to storage
 * 3. Supporting relation mutations (relate, modifyRelation, unrelate)
 */

import type {
  DatafnRelationDeletePolicy,
  DatafnRelationDirection,
  DatafnRelationSchema,
  DatafnSchema,
} from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import { createClientError } from "../errors.js";
import {
  endpointIncludes,
  endpointList,
  findRelationMatch,
  firstEndpoint,
  relationFkFieldForManyOne,
  getJoinStoreKey,
  normalizeRelationPayload,
  resolveEndpointResource,
  resourceRequiresAncestorInactive,
} from "@datafn/core";
import {
  assertNoSystemFieldWrite,
  injectCapabilityFieldsForOptimisticRecord,
  sanitizeCapabilityReadonlyFields,
} from "../capability-fields.js";

function htreeFkField(relation: { fkField?: string; foreignKey?: string; inverse?: string }): string {
  return relation.fkField || relation.foreignKey || relation.inverse || "parentId";
}

function htreePathField(relation: { pathField?: string }): string {
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
  return (typeof endpoint === "string" ? [endpoint] : [...endpoint]).length > 1;
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

function resolveManyManyJoin(
  schema: DatafnSchema,
  relation: DatafnRelationSchema,
  direction: DatafnRelationDirection,
  resource: string,
  id: string,
  targetId: string,
  path: string,
) {
  const relationName = relation.relation || "";
  if (!relationName) {
    throw createClientError("DFQL_INVALID", "many-many relation requires relation name", { path });
  }

  const fromId = direction === "forward" ? id : targetId;
  const toId = direction === "forward" ? targetId : id;
  const fromResource =
    direction === "forward"
      ? resource
      : resolveEndpointResource(relation.from, targetId, schema);
  const toResource =
    direction === "forward"
      ? resolveEndpointResource(relation.to, targetId, schema)
      : resource;

  if (!fromResource || !toResource) {
    throw createClientError("DFQL_INVALID", `Invalid relation target: ${targetId}`, { path });
  }

  return {
    fromId,
    toId,
    fromResource,
    toResource,
    joinStore: getJoinStoreKey(fromResource, relationName, toResource),
  };
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

function dependentEndpoint(relation: DatafnRelationSchema): string | readonly string[] {
  return relation.type === "many-one" ? relation.from : relation.to;
}

async function resolveAncestorInactive(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
): Promise<boolean> {
  for (const relation of schema.relations ?? []) {
    if (relation.inheritsInactive !== true) continue;
    if (!endpointIncludes(dependentEndpoint(relation), resource)) continue;
    if (relation.type === "htree") {
      const parentId = record[htreeFkField(relation)];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await storage.getRecord(resolveEndpointResource(relation.from, parentId, schema) ?? resource, parentId);
      if (isRecordEffectivelyInactive(parent)) return true;
    } else if (relation.type === "many-one") {
      const parentId = record[relationFkFieldForManyOne(relation)];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await storage.getRecord(resolveEndpointResource(relation.to, parentId, schema) ?? firstEndpoint(relation.to), parentId);
      if (isRecordEffectivelyInactive(parent)) return true;
    } else if (relation.type === "one-many") {
      const parentId = record[relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const parent = await storage.getRecord(resolveEndpointResource(relation.from, parentId, schema) ?? firstEndpoint(relation.from), parentId);
      if (isRecordEffectivelyInactive(parent)) return true;
    }
  }
  return false;
}

async function updateAncestorInactive(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!resourceRequiresAncestorInactive(schema.relations, resource)) return null;
  const next = await resolveAncestorInactive(storage, schema, resource, record);
  if (record.isAncestorInactive === next) return null;
  const updated = { ...record, isAncestorInactive: next };
  await storage.upsertRecord(resource, updated);
  return updated;
}

async function applyInactivePropagation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  seeds: Array<{ resource: string; id: string }>,
): Promise<void> {
  const queue = [...seeds];
  const processed = new Set<string>();
  while (queue.length > 0) {
    const seed = queue.shift();
    if (!seed) continue;
    const key = `${seed.resource}:${seed.id}`;
    if (processed.has(key)) continue;
    processed.add(key);
    const record = await storage.getRecord(seed.resource, seed.id);
    if (!record) continue;
    const updated = await updateAncestorInactive(storage, schema, seed.resource, record);
    const source = updated ?? record;
    for (const relation of schema.relations ?? []) {
      if (relation.inheritsInactive !== true) continue;
      if (relation.type === "htree" && endpointIncludes(relation.from, seed.resource)) {
        const targetResource = firstEndpoint(relation.to);
        const childPath = joinHtreePath(source[htreePathField(relation)], seed.id);
        const children = (await storage.listRecords(targetResource)).filter(
          (child) => child[htreePathField(relation)] === childPath,
        );
        for (const child of children) {
          const changed = await updateAncestorInactive(storage, schema, targetResource, child);
          if (changed) queue.push({ resource: targetResource, id: child.id as string });
        }
      } else if (relation.type === "many-one" && endpointIncludes(relation.to, seed.resource)) {
        const fkField = relationFkFieldForManyOne(relation);
        for (const childResource of typeof relation.from === "string" ? [relation.from] : relation.from) {
          const children = await storage.findRecords(childResource, fkField, seed.id);
          for (const child of children) {
            const changed = await updateAncestorInactive(storage, schema, childResource, child);
            if (changed) queue.push({ resource: childResource, id: child.id as string });
          }
        }
      } else if (relation.type === "one-many" && endpointIncludes(relation.from, seed.resource)) {
        const fkField = relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
        for (const childResource of typeof relation.to === "string" ? [relation.to] : relation.to) {
          const children = await storage.findRecords(childResource, fkField, seed.id);
          for (const child of children) {
            const changed = await updateAncestorInactive(storage, schema, childResource, child);
            if (changed) queue.push({ resource: childResource, id: child.id as string });
          }
        }
      }
    }
  }
}

function collectInactivePropagationSeeds(
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Array<{ resource: string; id: string }> {
  const seeds = new Map<string, { resource: string; id: string }>();
  const addSeed = (resource: string | undefined, id: string | undefined) => {
    if (!resource || !id) return;
    seeds.set(`${resource}:${id}`, { resource, id });
  };
  const resource = mutation.resource as string | undefined;
  const id = mutation.id as string | undefined;
  addSeed(resource, id);
  const relations = mutation.relations as Record<string, unknown> | undefined;
  if (!resource || !relations) return [...seeds.values()];
  for (const [relationName, payload] of Object.entries(relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (!match) continue;
    const { relation, direction } = match;
    if (relation.inheritsInactive !== true && relation.type !== "htree") continue;
    const targetEndpoint = direction === "forward" ? relation.to : relation.from;
    for (const item of normalizeRelationPayload(payload)) {
      addSeed(resolveEndpointResource(targetEndpoint, item.toId, schema) ?? firstEndpoint(targetEndpoint), item.toId);
    }
  }
  return [...seeds.values()];
}

function relationDeletePolicy(
  relation: DatafnRelationSchema,
  side: "from" | "to",
): DatafnRelationDeletePolicy | undefined {
  const policy = relation.onDelete;
  if (typeof policy === "string") return policy;
  if (policy && typeof policy === "object") return policy[side];
  return undefined;
}

function fkFieldForOneMany(relation: DatafnRelationSchema): string {
  return relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
}

function relationDeletePolicyLabel(relation: DatafnRelationSchema): string {
  return relation.relation ?? relation.inverse ?? relation.type;
}

function throwRelationRestricted(
  deletedId: string,
  relation: DatafnRelationSchema,
): never {
  return createClientError(
    "RELATION_RESTRICTED",
    `Cannot delete ${deletedId}; relation "${relationDeletePolicyLabel(relation)}" still references it`,
    { path: "id" },
  );
}

async function findFkPolicyRows(
  storage: DatafnStorageAdapter,
  resources: string[],
  fkField: string,
  deletedId: string,
  resourceField?: string,
  deletedResource?: string,
): Promise<Array<{ resource: string; row: Record<string, unknown> }>> {
  const rows: Array<{ resource: string; row: Record<string, unknown> }> = [];
  for (const resource of resources) {
    const candidates = await storage.findRecords(resource, fkField, deletedId);
    for (const row of candidates) {
      if (
        resourceField &&
        deletedResource &&
        row[resourceField] !== deletedResource
      ) {
        continue;
      }
      rows.push({ resource, row });
    }
  }
  return rows;
}

async function listManyManyRowsForDeletedResource(
  storage: DatafnStorageAdapter,
  relation: DatafnRelationSchema,
  resource: string,
  id: string,
  side: "from" | "to",
): Promise<Array<{ joinStore: string; row: Record<string, unknown> }>> {
  const relationName = relation.relation;
  if (!relationName) return [];
  const rows: Array<{ joinStore: string; row: Record<string, unknown> }> = [];
  if (side === "from") {
    for (const toResource of endpointList(relation.to)) {
      const joinStore = getJoinStoreKey(resource, relationName, toResource);
      for (const row of await storage.getJoinRows(joinStore, id)) {
        rows.push({ joinStore, row });
      }
    }
  } else {
    for (const fromResource of endpointList(relation.from)) {
      const joinStore = getJoinStoreKey(fromResource, relationName, resource);
      for (const row of await storage.getJoinRowsInverse(joinStore, id)) {
        rows.push({ joinStore, row });
      }
    }
  }
  return rows;
}

async function validateFkDeletePolicy(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  relation: DatafnRelationSchema,
  policy: DatafnRelationDeletePolicy,
  resources: string[],
  fkField: string,
  deletedId: string,
  visited: Set<string>,
  resourceField?: string,
  deletedResource?: string,
): Promise<void> {
  const rows = await findFkPolicyRows(
    storage,
    resources,
    fkField,
    deletedId,
    resourceField,
    deletedResource,
  );
  if (rows.length > 0 && policy === "restrict") {
    throwRelationRestricted(deletedId, relation);
  }
  if (policy === "cascade") {
    for (const { resource, row } of rows) {
      const rowId = String(row.id ?? "");
      if (!rowId) continue;
      await validateRelationDeletePolicies(
        storage,
        schema,
        resource,
        rowId,
        visited,
      );
    }
  }
}

async function validateRelationDeletePolicies(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  id: string,
  visited: Set<string> = new Set(),
): Promise<void> {
  const visitKey = `${resource}:${id}`;
  if (visited.has(visitKey)) return;
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
      if (!policy) continue;
      const rows = await listManyManyRowsForDeletedResource(
        storage,
        relation,
        resource,
        id,
        side,
      );
      if (rows.length > 0 && policy === "restrict") {
        throwRelationRestricted(id, relation);
      }
    } else if (relation.type === "many-one" && endpointIncludes(relation.to, resource)) {
      const policy = relationDeletePolicy(relation, "to");
      if (!policy) continue;
      await validateFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.from),
        relationFkFieldForManyOne(relation),
        id,
        visited,
        endpointIsPolymorphic(relation.to)
          ? fkResourceFieldForRelation(relation, "to")
          : undefined,
        resource,
      );
    } else if (relation.type === "one-many" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      await validateFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.to),
        fkFieldForOneMany(relation),
        id,
        visited,
        endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        resource,
      );
    } else if (relation.type === "htree" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      await validateFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.to),
        htreeFkField(relation),
        id,
        visited,
        endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        resource,
      );
    }
  }
}

async function applyFkDeletePolicy(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  relation: DatafnRelationSchema,
  policy: DatafnRelationDeletePolicy,
  resources: string[],
  fkField: string,
  deletedId: string,
  visited: Set<string>,
  extraNullFields?: Record<string, unknown>,
  resourceField?: string,
  deletedResource?: string,
): Promise<void> {
  const rows = await findFkPolicyRows(
    storage,
    resources,
    fkField,
    deletedId,
    resourceField,
    deletedResource,
  );
  if (rows.length > 0 && policy === "restrict") {
    throwRelationRestricted(deletedId, relation);
  }
  if (policy === "setNull" || policy === "detach") {
    const seeds: Array<{ resource: string; id: string }> = [];
    for (const { resource, row } of rows) {
      const rowId = String(row.id ?? "");
      if (!rowId) continue;
      await storage.upsertRecord(resource, {
        ...row,
        [fkField]: null,
        ...(extraNullFields ?? {}),
      });
      seeds.push({ resource, id: rowId });
    }
    await applyInactivePropagation(storage, schema, seeds);
  } else if (policy === "cascade") {
    for (const { resource, row } of rows) {
      const rowId = String(row.id ?? "");
      if (!rowId) continue;
      await deleteRecordWithRelationPolicies(
        storage,
        schema,
        resource,
        rowId,
        visited,
      );
    }
  }
}

async function applyRelationDeletePolicies(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  id: string,
  visited: Set<string>,
): Promise<void> {
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
      const rows = await listManyManyRowsForDeletedResource(
        storage,
        relation,
        resource,
        id,
        side,
      );
      if (rows.length > 0 && policy === "restrict") {
        throwRelationRestricted(id, relation);
      }
      if (policy === "detach" || policy === "cascade" || policy === "setNull") {
        for (const { joinStore, row } of rows) {
          const from = String(row.from ?? "");
          const to = String(row.to ?? "");
          if (!from || !to) continue;
          await storage.deleteJoinRow(joinStore, from, to);
        }
      }
    } else if (relation.type === "many-one" && endpointIncludes(relation.to, resource)) {
      const policy = relationDeletePolicy(relation, "to");
      if (!policy) continue;
      await applyFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.from),
        relationFkFieldForManyOne(relation),
        id,
        visited,
        fkResourcePatch(relation, "to", null),
        endpointIsPolymorphic(relation.to)
          ? fkResourceFieldForRelation(relation, "to")
          : undefined,
        resource,
      );
    } else if (relation.type === "one-many" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      await applyFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.to),
        fkFieldForOneMany(relation),
        id,
        visited,
        fkResourcePatch(relation, "from", null),
        endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        resource,
      );
    } else if (relation.type === "htree" && endpointIncludes(relation.from, resource)) {
      const policy = relationDeletePolicy(relation, "from");
      if (!policy) continue;
      await applyFkDeletePolicy(
        storage,
        schema,
        relation,
        policy,
        endpointList(relation.to),
        htreeFkField(relation),
        id,
        visited,
        {
          [htreePathField(relation)]: "",
          ...fkResourcePatch(relation, "from", null),
        },
        endpointIsPolymorphic(relation.from)
          ? fkResourceFieldForRelation(relation, "from")
          : undefined,
        resource,
      );
    }
  }
}

async function deleteRecordWithRelationPolicies(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  id: string,
  visited: Set<string> = new Set(),
): Promise<void> {
  const visitKey = `${resource}:${id}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);
  await applyRelationDeletePolicies(storage, schema, resource, id, visited);
  await storage.deleteRecord(resource, id);
}

async function updateHtreeDescendantPaths(
  storage: DatafnStorageAdapter,
  resource: string,
  relation: { pathField?: string },
  childId: string,
  oldChildPath: string,
  newChildPath: string,
): Promise<void> {
  const pathField = htreePathField(relation);
  const oldPrefix = joinHtreePath(oldChildPath, childId);
  const newPrefix = joinHtreePath(newChildPath, childId);
  const records = await storage.listRecords(resource);
  for (const record of records) {
    const currentPath = record[pathField];
    if (typeof currentPath !== "string") continue;
    if (currentPath !== oldPrefix && !currentPath.startsWith(`${oldPrefix}-`)) {
      continue;
    }
    const suffix = currentPath.slice(oldPrefix.length);
    await storage.upsertRecord(resource, {
      ...record,
      [pathField]: `${newPrefix}${suffix}`,
    });
  }
}

async function setHtreeParent(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  resource: string,
  childId: string,
  parentId: string | null,
  parentResource: string | null,
  relation: DatafnRelationSchema,
): Promise<void> {
  const child = await storage.getRecord(resource, childId);
  if (!child) return;
  const fkField = htreeFkField(relation);
  const pathField = htreePathField(relation);
  const oldChildPath = typeof child[pathField] === "string" ? child[pathField] as string : "";
  const parent = parentId ? await storage.getRecord(parentResource ?? resource, parentId) : null;
  const newChildPath = parentId ? joinHtreePath(parent?.[pathField], parentId) : "";
  await storage.upsertRecord(resource, {
    ...child,
    [fkField]: parentId,
    [pathField]: newChildPath,
    ...fkResourcePatch(relation, "from", parentResource),
  });
  await updateHtreeDescendantPaths(
    storage,
    resource,
    relation,
    childId,
    oldChildPath,
    newChildPath,
  );
  await applyInactivePropagation(storage, schema, [{ resource, id: childId }]);
}

/**
 * Handle a mutation when remote is unavailable.
 *
 * @param storage Storage adapter
 * @param schema Schema definition (required for relation operations)
 * @param mutation The full mutation object (including resource, version, clientId, mutationId)
 * @param timestampMs Client timestamp
 * @returns Optimistic mutation result
 */
export async function handleOfflineMutation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
  timestampMs: number,
): Promise<any> {
  // Validate required fields
  if (!mutation.clientId) {
    throw new Error("Missing clientId in mutation - mutation must be enriched before calling handleOfflineMutation");
  }
  if (!mutation.mutationId) {
    throw new Error("Missing mutationId in mutation - mutation must be enriched before calling handleOfflineMutation");
  }

  // 1. Append to changelog (handling dedupe)
  // CLIENT-CHANGELOG-001, CLIENT-OFFLINE-MUT-001
  const clientId = mutation.clientId as string;
  const mutationId = mutation.mutationId as string;
  const id = mutation.id as string;
  const sanitizedMutation = sanitizeCapabilityReadonlyFields(schema, mutation);

  await validateOfflineMutation(storage, schema, sanitizedMutation);

  // 3. Append to changelog (after validation, before apply)
  // AUD-001: Enrich with timestamp
  try {
    await storage.changelogAppend({
      clientId,
      mutationId,
      mutation: sanitizedMutation,
      timestampMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // If changelog fails, the whole offline mutation fails
    // Throw as is or wrap (CLIENT-OFFLINE-MUT-002)
    throw err;
  }

  // 4. Optimistic local apply
  // Deterministic implementation
  await applyOptimisticMutationToStorage(
    storage,
    schema,
    sanitizedMutation,
    timestampMs,
    clientId,
  );

  // 5. Return optimistic success result
  return {
    ok: true,
    mutationId,
    affectedIds: [id],
    deduped: false, // local apply is fresh
  };
}

export async function applyOptimisticMutationToStorage(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
  timestampMs: number,
  actorId?: string,
): Promise<void> {
  const resource = mutation.resource as string;
  const id = mutation.id as string;
  const operation = mutation.operation as string;
  const sanitizedMutation = sanitizeCapabilityReadonlyFields(schema, mutation);

  if (operation === "delete") {
    await deleteRecordWithRelationPolicies(storage, schema, resource, id);
  } else if (operation === "trash") {
    await storage.mergeRecord(resource, id, {
      trashedAt: timestampMs,
      trashedBy: null,
    });
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "restore") {
    await storage.mergeRecord(resource, id, {
      trashedAt: null,
      trashedBy: null,
    });
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "archive") {
    await storage.mergeRecord(resource, id, {
      isArchived: true,
    });
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "unarchive") {
    await storage.mergeRecord(resource, id, {
      isArchived: false,
    });
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "merge") {
    // Keep the existence decision and default application inside the adapter's
    // atomic read-modify-write. Concurrent creates must not receive defaults
    // computed from an earlier missing-record read.
    const optimisticPatch = injectCapabilityFieldsForOptimisticRecord(
      schema,
      sanitizedMutation,
      {
        timestampMs,
        actorId,
        existingRecord: {},
      },
    );
    const optimisticCreate = injectCapabilityFieldsForOptimisticRecord(
      schema,
      sanitizedMutation,
      {
        timestampMs,
        actorId,
        existingRecord: null,
      },
    );
    if (storage.capabilities?.atomicMergeIfMissing === true) {
      await storage.mergeRecord(resource, id, optimisticPatch, {
        ifMissing: optimisticCreate,
      });
    } else {
      // DatafnStorageAdapter implementations written before the optional
      // ifMissing argument remain structurally compatible with the interface.
      // Their existence check cannot be made atomic from the client: applying
      // create-only defaults after a racy read could overwrite a concurrent
      // create. Use the merge-safe patch; adapters that need complete atomic
      // create defaults must advertise atomicMergeIfMissing.
      await storage.mergeRecord(resource, id, optimisticPatch);
    }
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "insert" || operation === "replace") {
    // Insert/Replace: Overwrite (simple upsert)
    // Ensure id matches mutation target
    const existing =
      operation === "replace" ? await storage.getRecord(resource, id) : null;
    const optimisticRecord = injectCapabilityFieldsForOptimisticRecord(
      schema,
      sanitizedMutation,
      {
        timestampMs,
        actorId,
        existingRecord: existing,
      },
    );
    const toWrite = { ...optimisticRecord, id };
    await storage.upsertRecord(resource, toWrite);
    await applyInactivePropagation(storage, schema, [{ resource, id }]);
  } else if (operation === "relate") {
    // Handle relation mutations
    await applyRelate(storage, schema, sanitizedMutation);
    await applyInactivePropagation(storage, schema, collectInactivePropagationSeeds(schema, sanitizedMutation));
  } else if (operation === "modifyRelation") {
    await applyModifyRelation(storage, schema, sanitizedMutation);
    await applyInactivePropagation(storage, schema, collectInactivePropagationSeeds(schema, sanitizedMutation));
  } else if (operation === "unrelate") {
    await applyUnrelate(storage, schema, sanitizedMutation);
    await applyInactivePropagation(storage, schema, collectInactivePropagationSeeds(schema, sanitizedMutation));
  }
}

/**
 * Validate relation mutation (no side effects)
 * Throws if validation fails
 */
export async function validateOfflineMutation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  const operation = mutation.operation as string;
  assertNoSystemFieldWrite(schema, mutation);
  if (operation === "relate" || operation === "modifyRelation" || operation === "unrelate") {
    await validateRelationMutation(storage, schema, mutation);
  } else if (operation === "delete") {
    const resource = mutation.resource as string;
    const id = mutation.id as string;
    if (resource && id) {
      await validateRelationDeletePolicies(storage, schema, resource, id);
    }
  }
}

async function validateRelationMutation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  const resource = mutation.resource as string;
  const id = mutation.id as string;
  const operation = mutation.operation as string;
  const relations = mutation.relations as Record<string, unknown>;

  if (!relations) return;

  for (const [relationName, payload] of Object.entries(relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (!match) {
      throw createClientError(
        "DFQL_UNKNOWN_RELATION",
        `Unknown relation: ${relationName}`,
        { path: `relations.${relationName}` },
      );
    }
    const { relation, direction } = match;

    // Validate payload structure
    const items = normalizeRelationPayload(payload);

    // For modifyRelation, check that join rows exist
    if (operation === "modifyRelation") {
      if (relation.type !== "many-many") {
        throw createClientError(
          "DFQL_UNSUPPORTED",
          "modifyRelation only supported for many-many relations",
          { path: `relations.${relationName}` },
        );
      }

      for (const item of items) {
        const join = resolveManyManyJoin(
          schema,
          relation,
          direction,
          resource,
          id,
          item.toId,
          `relations.${relationName}`,
        );
        const existingRows = await storage.getJoinRows(join.joinStore, join.fromId);
        const existingRow = existingRows.find((r) => r.to === join.toId);

        if (!existingRow) {
          throw createClientError(
            "NOT_FOUND",
            `Relation not found between ${id} and ${item.toId}`,
            { path: `relations.${relationName}` },
          );
        }
      }
    }

    // For relate with many-one, validate single target
    if (operation === "relate" && relation.type === "many-one") {
      if (items.length !== 1) {
        throw createClientError(
          "DFQL_INVALID",
          "many-one relation expects single target",
          { path: `relations.${relationName}` },
        );
      }
    }
  }
}

/**
 * Apply relate operation offline
 */
async function applyRelate(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  const resource = mutation.resource as string;
  const id = mutation.id as string;
  const relations = mutation.relations as Record<string, unknown>;

  if (!relations) return;

  for (const [relationName, payload] of Object.entries(relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (!match) continue;
    const { relation, direction } = match;

    const items = normalizeRelationPayload(payload);

    // Apply based on relation type
    if (relation.type === "many-one" && direction === "forward") {
      const fkField = relation.fkField || relation.foreignKey || `${relationName}Id`;
      const targetResource = resolveEndpointResource(relation.to, items[0].toId, schema);
      const existing = await storage.getRecord(resource, id);
      if (existing) {
        await storage.upsertRecord(resource, {
          ...existing,
          [fkField]: items[0].toId,
          ...fkResourcePatch(relation, "to", targetResource ?? null),
        });
      }
    } else if (relation.type === "many-one" && direction === "inverse") {
      const fkField = relationFkFieldForManyOne(relation);
      for (const item of items) {
        const targetResource = resolveEndpointResource(relation.from, item.toId, schema);
        if (!targetResource) continue;
        const existing = await storage.getRecord(targetResource, item.toId);
        if (existing) {
          await storage.upsertRecord(targetResource, {
            ...existing,
            [fkField]: id,
            ...fkResourcePatch(relation, "to", resource),
          });
        }
      }
    } else if (relation.type === "one-many" && direction === "forward") {
      const fkField =
        relation.fkField || relation.foreignKey || relation.inverse || `${resource}Id`;

      for (const item of items) {
        const targetResource = resolveEndpointResource(relation.to, item.toId, schema);
        if (!targetResource) continue;
        const targetRecord = await storage.getRecord(
          targetResource,
          item.toId,
        );
        if (targetRecord) {
          await storage.upsertRecord(targetResource, {
            ...targetRecord,
            [fkField]: id,
            ...fkResourcePatch(relation, "from", resource),
          });
        }
      }
    } else if (relation.type === "one-many" && direction === "inverse") {
      const fkField = relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
      const targetResource = resolveEndpointResource(relation.from, items[0].toId, schema);
      const existing = await storage.getRecord(resource, id);
      if (existing) {
        await storage.upsertRecord(resource, {
          ...existing,
          [fkField]: items[0].toId,
          ...fkResourcePatch(relation, "from", targetResource ?? null),
        });
      }
    } else if (relation.type === "htree") {
      const isForward =
        endpointIncludes(relation.from, resource) &&
        relation.relation === relationName;
      const treeResource = isForward
        ? firstEndpoint(relation.to)
        : firstEndpoint(relation.from);
      for (const item of items) {
        await setHtreeParent(
          storage,
          schema,
          treeResource,
          isForward ? item.toId : id,
          isForward ? id : item.toId,
          isForward ? resource : resolveEndpointResource(relation.from, item.toId, schema) ?? null,
          relation,
        );
      }
    } else if (relation.type === "many-many") {
      for (const item of items) {
        const join = resolveManyManyJoin(
          schema,
          relation,
          direction,
          resource,
          id,
          item.toId,
          `relations.${relationName}`,
        );
        const existingRows = await storage.getJoinRows(join.joinStore, join.fromId);
        const existingRow = existingRows.find((r) => r.to === join.toId);

        if (existingRow) {
          if (Object.keys(item.metadata).length > 0) {
            await storage.upsertJoinRow(join.joinStore, {
              from: join.fromId,
              to: join.toId,
              fromResource: join.fromResource,
              toResource: join.toResource,
              ...existingRow,
              ...item.metadata,
            });
          }
        } else {
          await storage.upsertJoinRow(join.joinStore, {
            from: join.fromId,
            to: join.toId,
            fromResource: join.fromResource,
            toResource: join.toResource,
            ...item.metadata,
          });
        }
      }
    }
  }
}

/**
 * Apply modifyRelation operation offline
 */
async function applyModifyRelation(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  const resource = mutation.resource as string;
  const id = mutation.id as string;
  const relations = mutation.relations as Record<string, unknown>;

  if (!relations) return;

  for (const [relationName, payload] of Object.entries(relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (!match) continue;
    const { relation, direction } = match;

    const items = normalizeRelationPayload(payload);

    for (const item of items) {
      const join = resolveManyManyJoin(
        schema,
        relation,
        direction,
        resource,
        id,
        item.toId,
        `relations.${relationName}`,
      );
      const existingRows = await storage.getJoinRows(join.joinStore, join.fromId);
      const existingRow = existingRows.find((r) => r.to === join.toId);

      await storage.upsertJoinRow(join.joinStore, {
        from: join.fromId,
        to: join.toId,
        fromResource: join.fromResource,
        toResource: join.toResource,
        ...existingRow,
        ...item.metadata,
      });
    }
  }
}

/**
 * Apply unrelate operation offline
 */
async function applyUnrelate(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  const resource = mutation.resource as string;
  const id = mutation.id as string;
  const relations = mutation.relations as Record<string, unknown>;

  if (!relations) return;

  for (const [relationName, payload] of Object.entries(relations)) {
    const match = findRelationMatch(schema, resource, relationName);
    if (!match) continue;
    const { relation, direction } = match;

    const items = normalizeRelationPayload(payload);

    if (relation.type === "many-one" && direction === "forward") {
      const fkField = relation.fkField || relation.foreignKey || `${relationName}Id`;
      const existing = await storage.getRecord(resource, id);
      if (existing) {
        await storage.upsertRecord(resource, {
          ...existing,
          [fkField]: null,
          ...fkResourcePatch(relation, "to", null),
        });
      }
    } else if (relation.type === "many-one" && direction === "inverse") {
      const fkField = relationFkFieldForManyOne(relation);
      for (const item of items) {
        const targetResource = resolveEndpointResource(relation.from, item.toId, schema);
        if (!targetResource) continue;
        const targetRecord = await storage.getRecord(targetResource, item.toId);
        if (targetRecord) {
          await storage.upsertRecord(targetResource, {
            ...targetRecord,
            [fkField]: null,
            ...fkResourcePatch(relation, "to", null),
          });
        }
      }
    } else if (relation.type === "one-many" && direction === "forward") {
      const fkField =
        relation.fkField || relation.foreignKey || relation.inverse || `${resource}Id`;

      for (const item of items) {
        const targetResource = resolveEndpointResource(relation.to, item.toId, schema);
        if (!targetResource) continue;
        const targetRecord = await storage.getRecord(
          targetResource,
          item.toId,
        );
        if (targetRecord) {
          await storage.upsertRecord(targetResource, {
            ...targetRecord,
            [fkField]: null,
            ...fkResourcePatch(relation, "from", null),
          });
        }
      }
    } else if (relation.type === "one-many" && direction === "inverse") {
      const fkField = relation.fkField || relation.foreignKey || relation.inverse || `${firstEndpoint(relation.from)}Id`;
      const existing = await storage.getRecord(resource, id);
      if (existing) {
        await storage.upsertRecord(resource, {
          ...existing,
          [fkField]: null,
          ...fkResourcePatch(relation, "from", null),
        });
      }
    } else if (relation.type === "htree") {
      const isForward =
        endpointIncludes(relation.from, resource) &&
        relation.relation === relationName;
      const treeResource = isForward
        ? firstEndpoint(relation.to)
        : firstEndpoint(relation.from);
      for (const item of items) {
        await setHtreeParent(
          storage,
          schema,
          treeResource,
          isForward ? item.toId : id,
          null,
          null,
          relation,
        );
      }
    } else if (relation.type === "many-many") {
      for (const item of items) {
        const join = resolveManyManyJoin(
          schema,
          relation,
          direction,
          resource,
          id,
          item.toId,
          `relations.${relationName}`,
        );
        await storage.deleteJoinRow(join.joinStore, join.fromId, join.toId);
      }
    }
  }
}
