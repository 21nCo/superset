/**
 * Mutation Execution Utilities
 *
 * Handles mutation execution via remote adapter with event emission.
 */

import type { DatafnRemoteAdapter } from "./client.js";
import type { DatafnStorageAdapter } from "./storage.js";
import type { EventBus } from "./events/bus.js";
import type { DatafnPlugin, DatafnSchema, SearchProvider } from "@datafn/core";
import { unwrapRemoteSuccess } from "./remote/unwrap.js";
import { isTransportError } from "./errors.js";
import {
  applyOptimisticMutationToStorage,
  handleOfflineMutation,
  validateOfflineMutation,
} from "./offline/mutate.js";
import { runBeforeMutation, runAfterMutation } from "./plugins/run-hooks.js";
import { serializeDateFields } from "./codecs/date.js";
import {
  assertNoSystemFieldWrite,
  sanitizeCapabilityReadonlyFields,
} from "./capability-fields.js";
import {
  encryptMutationPayloadForE2ee,
  type DatafnE2eeConfig,
} from "./e2ee.js";

import type {
  DebouncerMap,
  DfqlMutation as DebouncedMutation,
} from "./debounce.js";

export type MutationPushScheduler = () => void | Promise<void>;

export type TableOperation =
  | "delete"
  | "trash"
  | "restore"
  | "archive"
  | "unarchive";

export type ShareScope = "record" | "resource";

export type PrincipalShareMutationInput = {
  principalId: string;
  level: string;
  scope?: ShareScope;
  id?: string;
};

export type PrincipalUnshareMutationInput = {
  principalId: string;
  scope?: ShareScope;
  id?: string;
};

/**
 * Build a table-scoped mutation payload for operation convenience methods.
 */
export function buildTableOperationMutation(
  resource: string,
  version: number,
  operation: TableOperation,
  id: string,
): Record<string, unknown> {
  return {
    resource,
    version,
    operation,
    id,
  };
}

export function buildShareMutation(
  resource: string,
  version: number,
  id: string,
  userId: string,
  level: string,
): Record<string, unknown> {
  return {
    resource,
    version,
    operation: "share",
    id,
    shareWith: { userId, level },
  };
}

export function buildUnshareMutation(
  resource: string,
  version: number,
  id: string,
  userId: string,
): Record<string, unknown> {
  return {
    resource,
    version,
    operation: "unshare",
    id,
    shareWith: { userId },
  };
}

export function buildPrincipalShareMutation(
  resource: string,
  version: number,
  input: PrincipalShareMutationInput,
): Record<string, unknown> {
  const scope = input.scope ?? "record";
  const payload: Record<string, unknown> = {
    resource,
    version,
    operation: "share",
    scope,
    shareWith: {
      principalId: input.principalId,
      level: input.level,
    },
  };

  if (scope === "record") {
    payload.id = input.id;
  }

  return payload;
}

export function buildPrincipalUnshareMutation(
  resource: string,
  version: number,
  input: PrincipalUnshareMutationInput,
): Record<string, unknown> {
  const scope = input.scope ?? "record";
  const payload: Record<string, unknown> = {
    resource,
    version,
    operation: "unshare",
    scope,
    shareWith: {
      principalId: input.principalId,
    },
  };

  if (scope === "record") {
    payload.id = input.id;
  }

  return payload;
}

async function schedulePushFailSoft(
  schedulePush: MutationPushScheduler | undefined,
): Promise<void> {
  if (!schedulePush) return;

  try {
    await schedulePush();
  } catch (error) {
    console.warn("Mutation push scheduling failed (non-fatal)", {
      operation: "mutation-push-schedule",
      error: String(error),
    });
  }
}

function isDebounceableMutationOperation(operation: unknown): boolean {
  return (
    operation === "merge" ||
    operation === "relate" ||
    operation === "modifyRelation"
  );
}

/**
 * Generate a unique mutation ID
 */
function generateMutationId(): string {
  return `mut-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Apply outbound date codec to mutation record (CODEC-001)
 */
function applyDateCodecToMutation(
  schema: DatafnSchema | undefined,
  mutation: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || !mutation.record) {
    return mutation;
  }

  const resource = mutation.resource as string;
  if (!resource) {
    return mutation;
  }

  try {
    const serializedRecord = serializeDateFields(
      schema,
      resource,
      mutation.record as Record<string, unknown>,
    );
    return {
      ...mutation,
      record: serializedRecord,
    };
  } catch (err) {
    // Propagate codec errors
    throw err;
  }
}

function sanitizeCapabilityFieldsInMutationPayload(
  schema: DatafnSchema | undefined,
  payload: unknown | unknown[],
): unknown | unknown[] {
  if (!schema) return payload;
  if (Array.isArray(payload)) {
    return payload.map((entry) => {
      assertNoSystemFieldWrite(schema, entry as Record<string, unknown>);
      return sanitizeCapabilityReadonlyFields(schema, entry as Record<string, unknown>);
    });
  }
  assertNoSystemFieldWrite(schema, payload as Record<string, unknown>);
  return sanitizeCapabilityReadonlyFields(
    schema,
    payload as Record<string, unknown>,
  );
}

const SEARCH_INDEX_UPSERT_OPS = new Set([
  "insert",
  "merge",
  "replace",
  "trash",
  "restore",
  "archive",
  "unarchive",
]);

function resolveSearchIndexOperation(
  operation: unknown,
): "upsert" | "delete" | undefined {
  if (operation === "delete") return "delete";
  if (typeof operation === "string" && SEARCH_INDEX_UPSERT_OPS.has(operation)) {
    return "upsert";
  }
  return undefined;
}

function isNativeBackedSearchProvider(
  searchProvider: SearchProvider | undefined,
): boolean {
  return (
    typeof searchProvider === "object" &&
    searchProvider !== null &&
    (searchProvider as { __datafnNativeBacked?: unknown }).__datafnNativeBacked === true
  );
}

function isRemoteMutationResultFullyApplied(result: unknown): boolean {
  if (Array.isArray(result)) {
    return result.every((entry) => isRemoteMutationResultFullyApplied(entry));
  }
  if (typeof result !== "object" || result === null) return true;
  const value = result as Record<string, unknown>;
  if (value.ok === false) return false;
  if (Array.isArray(value.errors) && value.errors.length > 0) return false;
  if (Array.isArray(value.results)) {
    return value.results.every((entry) => isRemoteMutationResultFullyApplied(entry));
  }
  return true;
}

function getMutationId(mutation: unknown): string | undefined {
  const value = mutation as Record<string, unknown>;
  return typeof value?.mutationId === "string" ? value.mutationId : undefined;
}

function resolveRemoteResultForMutation(
  result: unknown,
  mutation: unknown,
  index: number,
): unknown {
  if (Array.isArray(result)) {
    return result[index] ?? { ok: false, errors: [{ code: "UNKNOWN", message: "Missing mutation result", path: "$" }] };
  }

  if (typeof result !== "object" || result === null) {
    return result;
  }

  const value = result as Record<string, unknown>;
  const mutationId = getMutationId(mutation);
  const errors = Array.isArray(value.errors) ? value.errors as Record<string, unknown>[] : [];
  const matchedError = mutationId
    ? errors.find((error) => error.mutationId === mutationId)
    : undefined;
  if (matchedError) {
    return { ok: false, errors: [matchedError] };
  }

  if (
    value.ok === false &&
    typeof value.mutationId === "string" &&
    (!mutationId || value.mutationId === mutationId)
  ) {
    return value;
  }

  const applied = Array.isArray(value.applied) ? value.applied : [];
  if (mutationId && applied.includes(mutationId)) {
    return { ok: true, mutationId };
  }

  if (value.ok === true && errors.length === 0 && applied.length === 0) {
    return { ok: true, mutationId };
  }

  if (value.ok === true && !mutationId) {
    return { ok: true };
  }

  return { ok: false, errors: [{ code: "UNKNOWN", message: "Mutation was not applied", path: "$" }] };
}

function isRemoteMutationApplied(result: unknown, mutation: unknown, index: number): boolean {
  return isRemoteMutationResultFullyApplied(
    resolveRemoteResultForMutation(result, mutation, index),
  );
}

async function applyRemoteSuccessToLocalStorage(
  storage: DatafnStorageAdapter | undefined,
  schema: DatafnSchema | undefined,
  offlinability: boolean | undefined,
  clientId: string | undefined,
  searchProvider: SearchProvider | undefined,
  mutationForRemote: unknown | unknown[],
  result: unknown,
  getTimestamp: () => number,
): Promise<void> {
  if (!storage || !schema || !offlinability || !clientId) return;

  const mutations = Array.isArray(mutationForRemote)
    ? mutationForRemote
    : [mutationForRemote];
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index];
    if (!isRemoteMutationApplied(result, mutation, index)) continue;
    const mutationRecord = mutation as Record<string, unknown>;
    if (isRemoteOnlyMutation(schema, mutationRecord)) continue;
    await applyOptimisticMutationToStorage(
      storage,
      schema,
      mutationRecord,
      getTimestamp(),
      clientId,
    );
    await tryUpdateSearchIndex(
      searchProvider,
      storage,
      mutationRecord,
    );
  }
}

function isRemoteOnlyMutation(
  schema: DatafnSchema | undefined,
  mutation: Record<string, unknown>,
): boolean {
  const resource = mutation.resource;
  return (
    typeof resource === "string" &&
    schema?.resources.some((item) => item.name === resource && item.isRemoteOnly) === true
  );
}

function hasRemoteOnlyMutation(
  schema: DatafnSchema | undefined,
  mutation: unknown | unknown[],
): boolean {
  const mutations = Array.isArray(mutation) ? mutation : [mutation];
  return mutations.some(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      isRemoteOnlyMutation(schema, item as Record<string, unknown>),
  );
}

async function tryUpdateSearchIndex(
  searchProvider: SearchProvider | undefined,
  storage: DatafnStorageAdapter | undefined,
  mutation: Record<string, unknown>,
  resolvedRecord?: Record<string, unknown>,
): Promise<void> {
  if (!searchProvider || isNativeBackedSearchProvider(searchProvider)) return;

  const resource = mutation.resource;
  const id = mutation.id;
  const searchOp = resolveSearchIndexOperation(mutation.operation);
  if (typeof resource !== "string" || typeof id !== "string" || !searchOp) return;

  try {
    if (searchOp === "delete") {
      await searchProvider.updateIndices({
        resource,
        records: [{ id }],
        operation: "delete",
      });
      return;
    }

    const fromStorage = storage ? await storage.getRecord(resource, id) : null;
    const fallbackRecord =
      typeof mutation.record === "object" &&
      mutation.record !== null &&
      !Array.isArray(mutation.record)
        ? (mutation.record as Record<string, unknown>)
        : {};
    const finalRecord = {
      id,
      ...(resolvedRecord ?? (fromStorage as Record<string, unknown> | null) ?? fallbackRecord),
    };
    await searchProvider.updateIndices({
      resource,
      records: [finalRecord],
      operation: "upsert",
    });
  } catch (error) {
    // Search indexing is non-fatal for mutation durability.
    console.warn("Search index update failed (non-fatal)", {
      operation: "search-index-update",
      resource,
      error: String(error),
    });
  }
}

/**
 * Execute a mutation (single or batch) via the remote adapter.
 * Unwraps responses, emits events, and returns mutation result(s).
 */
export async function executeMutation(
  remote: DatafnRemoteAdapter,
  eventBus: EventBus,
  getTimestamp: () => number,
  m: unknown | unknown[],
  storage?: DatafnStorageAdapter,
  plugins: DatafnPlugin[] = [],
  schema?: DatafnSchema,
  schedulePush?: MutationPushScheduler,
  offlinability?: boolean,
  clientId?: string,
  debouncerMap?: DebouncerMap,
  searchProvider?: SearchProvider,
  e2ee?: DatafnE2eeConfig,
): Promise<unknown> {
  // Validate clientId is provided when offline functionality is needed
  if ((offlinability || storage) && !clientId) {
    throw new Error(
      "clientId is required when offlinability or storage is enabled",
    );
  }

  // Validate context is JSON-serializable (API-002)
  const mutationsToValidate = Array.isArray(m) ? m : [m];
  for (const mut of mutationsToValidate) {
    const mutation = mut as any;
    if (mutation.context !== undefined) {
      try {
        // Test JSON serializability
        JSON.stringify(mutation.context);
        // Check for non-serializable types
        if (
          typeof mutation.context === "function" ||
          typeof mutation.context === "symbol" ||
          typeof mutation.context === "bigint"
        ) {
          throw new Error(
            "Invalid mutation: context must be JSON-serializable",
          );
        }
      } catch (err) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid mutation: context must be JSON-serializable",
          details: { path: "context" },
        };
      }
    }
  }

  if (
    !Array.isArray(m) &&
    debouncerMap &&
    storage &&
    schema &&
    offlinability &&
    clientId
  ) {
    const mutation = m as Record<string, unknown>;
    const debounceKey =
      typeof mutation.debounceKey === "string"
        ? mutation.debounceKey
        : undefined;
    const debounceMs =
      typeof mutation.debounceMs === "number" ? mutation.debounceMs : 1500;

    if (
      debounceKey &&
      typeof mutation.resource === "string" &&
      typeof mutation.operation === "string" &&
      typeof mutation.id === "string" &&
      isDebounceableMutationOperation(mutation.operation)
    ) {
      const mutationId =
        typeof mutation.mutationId === "string"
          ? mutation.mutationId
          : generateMutationId();
      const sanitizedMutation = sanitizeCapabilityReadonlyFields(
        schema,
        mutation as Record<string, unknown>,
      );
      const enrichedMutation: DebouncedMutation = {
        ...sanitizedMutation,
        resource: mutation.resource,
        operation: mutation.operation,
        id: mutation.id,
        clientId,
        mutationId,
      };

      const state = await storage.getHydrationState(mutation.resource);
      if (state === "ready") {
        await validateOfflineMutation(storage, schema, enrichedMutation);
        await applyOptimisticMutationToStorage(
          storage,
          schema,
          enrichedMutation,
          getTimestamp(),
          clientId,
        );
        await tryUpdateSearchIndex(searchProvider, storage, enrichedMutation);

        debouncerMap.set(
          debounceKey,
          enrichedMutation,
          debounceMs,
          async (debouncedMutation) => {
            try {
              // Append to changelog (AUD-001: with timestamp enrichment)
              await storage.changelogAppend({
                clientId: debouncedMutation.clientId as string,
                mutationId: debouncedMutation.mutationId as string,
                mutation: debouncedMutation,
                timestampMs: getTimestamp(),
                timestamp: new Date().toISOString(),
              });

              // Emit mutation_applied event
              emitMutationEvents(
                eventBus,
                getTimestamp,
                debouncedMutation,
                { ok: true, mutationId: debouncedMutation.mutationId },
              );

              // Scheduling push is best-effort once the durable local write succeeded.
              await schedulePushFailSoft(schedulePush);
            } catch (err) {
              // If changelog append fails, emit rejection event
              const errorContext = {
                code: "INTERNAL",
                message: "Failed to append to changelog",
                path: "$",
              };
              eventBus.emit({
                type: "mutation_rejected",
                resource: debouncedMutation.resource as string,
                ids: [debouncedMutation.id as string],
                mutationId: debouncedMutation.mutationId as string,
                clientId: debouncedMutation.clientId as string,
                timestampMs: getTimestamp(),
                action: debouncedMutation.operation as string,
                context: errorContext,
              } as any);
              // Don't re-throw - we've emitted the rejection event
              // and the debouncer promise will be rejected anyway
            }
          },
        );

        return {
          ok: true,
          mutationId,
          affectedIds: [mutation.id],
          deduped: false,
        };
      }
    }
  }

  // Run beforeMutation hooks (fail-closed)
  const transformedMutation = schema
    ? await runBeforeMutation(plugins, schema, m)
    : m;

  // Apply outbound date codec (CODEC-001)
  // Serialize Date fields to ISO strings before any processing
  let codecAppliedMutation = transformedMutation;
  if (schema) {
    if (Array.isArray(transformedMutation)) {
      codecAppliedMutation = transformedMutation.map((mut) =>
        applyDateCodecToMutation(schema, mut as Record<string, unknown>),
      );
    } else {
      codecAppliedMutation = applyDateCodecToMutation(
        schema,
        transformedMutation as Record<string, unknown>,
      );
    }
  }

  const capabilitySanitizedMutation = sanitizeCapabilityFieldsInMutationPayload(
    schema,
    codecAppliedMutation,
  );

  // Local-first path (SYNC-MUT-001)
  // Only use local-first when hydration is ready to avoid data integrity issues
  // (e.g., editing a record that exists on remote but not yet synced locally)
  if (offlinability && storage) {
    const mutations = Array.isArray(capabilitySanitizedMutation)
      ? capabilitySanitizedMutation
      : [capabilitySanitizedMutation];

    // Check hydration state for all mutations
    let allReady = true;
    for (const mut of mutations) {
      const resource = (mut as any).resource;
      if (!resource) continue;
      if (isRemoteOnlyMutation(schema, mut as Record<string, unknown>)) {
        allReady = false;
        break;
      }
      const state = await storage.getHydrationState(resource);
      if (state !== "ready") {
        allReady = false;
        break;
      }
    }

    if (allReady) {
      // Enrich mutations with clientId and mutationId
      const enrichedMutations = mutations.map((mut) => {
        const mutation = mut as Record<string, unknown>;
        return {
          ...mutation,
          clientId: clientId!, // clientId is validated above
          mutationId: mutation.mutationId || generateMutationId(),
        };
      });

      const results: unknown[] = [];
      for (const mut of enrichedMutations) {
        const mutationRecord = mut as Record<string, unknown>;
        let result = await handleOfflineMutation(
          storage,
          schema!,
          mutationRecord,
          getTimestamp(),
        );

        // Run afterMutation hooks
        result = schema
          ? await runAfterMutation(plugins, schema, mut, result)
          : result;
        await tryUpdateSearchIndex(
          searchProvider,
          storage,
          mutationRecord,
        );

        results.push(result);
        emitMutationEvents(eventBus, getTimestamp, mut, result);
      }

      // Scheduling push is best-effort once the durable local write succeeded.
      await schedulePushFailSoft(schedulePush);

      return Array.isArray(m) ? results : results[0];
    }
  }

  let result: unknown;
  let usedOfflinePath = false;

  // If storage is available, enrich mutations before remote call
  // so they're ready for offline handling if remote fails.
  let mutationForRemote = capabilitySanitizedMutation;
  let mutationForLocal = capabilitySanitizedMutation;
  if (storage && clientId) {
    const mutations = Array.isArray(capabilitySanitizedMutation)
      ? capabilitySanitizedMutation
      : [capabilitySanitizedMutation];
    const enriched = mutations.map((mut) => {
      const mutation = mut as Record<string, unknown>;
      return {
        ...mutation,
        clientId: clientId,
        mutationId: mutation.mutationId || generateMutationId(),
      };
    });
    mutationForLocal = Array.isArray(capabilitySanitizedMutation)
      ? enriched
      : enriched[0];
    mutationForRemote = await encryptMutationPayloadForE2ee(
      schema!,
      e2ee,
      mutationForLocal,
    );
  } else if (schema) {
    mutationForRemote = await encryptMutationPayloadForE2ee(
      schema,
      e2ee,
      mutationForRemote,
    );
  }

  // Extract retryIndividual option from first mutation if batch
  let retryIndividualBatch = false;
  if (Array.isArray(mutationForRemote) && mutationForRemote.length > 0) {
    const firstMut = mutationForRemote[0] as any;
    retryIndividualBatch = firstMut.retryIndividual === true;
  }

  try {
    const response = await remote.mutation(mutationForRemote);
    result = unwrapRemoteSuccess(response);
    try {
      await applyRemoteSuccessToLocalStorage(
        storage,
        schema,
        offlinability,
        clientId,
        searchProvider,
        mutationForLocal,
        result,
        getTimestamp,
      );
    } catch (error) {
      // The remote mutation is already committed. Local reconciliation is
      // best-effort and the next pull remains the source of repair.
      console.warn("Local storage reconciliation failed after remote mutation", {
        operation: "apply-remote-success-to-local-storage",
        error: String(error),
      });
    }
    // Run afterMutation hooks (fail-open)
    result = schema
      ? await runAfterMutation(plugins, schema, mutationForRemote, result)
      : result;
  } catch (err: unknown) {
    // BULK-001: If batch fails and retryIndividual is true, retry each individually
    if (retryIndividualBatch && Array.isArray(mutationForRemote) && clientId) {
      const localMutations = Array.isArray(mutationForLocal)
        ? mutationForLocal
        : [mutationForLocal];
      const results: any[] = [];
      for (const mutation of mutationForRemote) {
        try {
          // Retry this mutation individually via remote.mutation
          const singleMutationResponse = await remote.mutation(mutation);
          const singleResult = unwrapRemoteSuccess(singleMutationResponse);
          results.push({
            mutationId: (mutation as any).mutationId,
            ok: true,
            result: singleResult,
          });
        } catch (mutErr) {
          results.push({
            mutationId: (mutation as any).mutationId,
            ok: false,
            error: mutErr,
          });
        }
      }

      // Aggregate results: ok only if ALL succeeded
      const allSucceeded = results.every((r) => r.ok);
      const errors = results.filter((r) => !r.ok).map((r) => r.error);

      result = {
        ok: allSucceeded,
        results,
        errors: allSucceeded ? [] : errors,
      };

      // Emit events for each mutation based on result
      for (let i = 0; i < mutationForRemote.length; i++) {
        if (results[i].ok) {
          emitMutationEvents(
            eventBus,
            getTimestamp,
            localMutations[i],
            { ok: true, mutationId: (localMutations[i] as any).mutationId },
          );
        } else {
          emitRejectionForError(
            eventBus,
            getTimestamp,
            localMutations[i],
            results[i].error,
          );
        }
      }

      return result;
    }

    // REL-012: Do NOT emit rejection here if we are about to attempt offline handling.
    // Rejection is emitted only when no offline path is available (else branch below)
    // or when offline handling itself fails.

    // Check if we can failover to offline handling
    // OFF-001: Batch offline handling
    if (
      storage &&
      schema &&
      isTransportError(err) &&
      !hasRemoteOnlyMutation(schema, mutationForRemote)
    ) {
      try {
        if (Array.isArray(mutationForLocal)) {
          // Batch offline handling: iterate through each mutation
          const results: any[] = [];
          for (const mutation of mutationForLocal) {
            const mutationRecord = mutation as Record<string, unknown>;
            try {
              const mutResult = await handleOfflineMutation(
                storage,
                schema,
                mutationRecord,
                getTimestamp(),
              );
              await tryUpdateSearchIndex(
                searchProvider,
                storage,
                mutationRecord,
              );
              // Emit mutation_applied event (unless silent)
              emitMutationEvents(eventBus, getTimestamp, mutation, mutResult);
              results.push({ ok: true, ...mutResult });
            } catch (mutErr) {
              results.push({ ok: false, error: mutErr });
            }
          }
          // Return aggregated batch results
          result = results;
          usedOfflinePath = true;
        } else {
          // Single mutation offline handling
          const mutationToUse = mutationForLocal as Record<string, unknown>;
          result = await handleOfflineMutation(
            storage,
            schema,
            mutationToUse,
            getTimestamp(),
          );
          await tryUpdateSearchIndex(
            searchProvider,
            storage,
            mutationToUse,
          );
          // REL-012: Emit applied here so only one event fires (no double-emit with final path)
          emitMutationEvents(eventBus, getTimestamp, mutationToUse, result);
          usedOfflinePath = true;
        }
      } catch (offlineErr) {
        // REL-012: Offline path also failed — emit rejection now and rethrow
        if (!Array.isArray(mutationForLocal)) {
          emitRejectionForError(eventBus, getTimestamp, mutationForLocal as any, offlineErr);
        } else {
          for (const mut of mutationForLocal as any[]) {
            emitRejectionForError(eventBus, getTimestamp, mut, offlineErr);
          }
        }
        throw offlineErr;
      }
    } else {
      // REL-012: No offline path available — emit rejection now and rethrow
      // CLIENT-EVENT-001: Emit mutation_rejected for thrown errors
      if (!Array.isArray(mutationForLocal)) {
        emitRejectionForError(
          eventBus,
          getTimestamp,
          mutationForLocal as any,
          err,
        );
      } else {
        // For batch mutations, emit rejection for each
        for (const mut of mutationForLocal as any[]) {
          emitRejectionForError(eventBus, getTimestamp, mut, err);
        }
      }
      throw err;
    }
  }

  // Handle single mutation result
  // REL-012: Skip final emit for offline path — events already emitted inside offline handling
  if (!Array.isArray(mutationForLocal)) {
    if (!usedOfflinePath) {
      emitMutationEvents(
        eventBus,
        getTimestamp,
        mutationForLocal as any,
        resolveRemoteResultForMutation(result, mutationForLocal, 0) as any,
      );
    }
    return result;
  }

  // Handle batch mutation results
  // REL-012: Skip final emit for offline path — events already emitted inside the offline loop
  const mutations = mutationForLocal as any[];

  if (!usedOfflinePath) {
    for (let i = 0; i < mutations.length; i++) {
      emitMutationEvents(
        eventBus,
        getTimestamp,
        mutations[i],
        resolveRemoteResultForMutation(result, mutations[i], i) as any,
      );
    }
  }

  return result;
}

/**
 * Emit mutation events based on result
 * CLIENT-EVENT-001: Include action and fields metadata
 * MUT-001: Skip emission if silent: true
 * MUT-002: Include system flag in event payload
 */
function emitMutationEvents(
  eventBus: EventBus,
  getTimestamp: () => number,
  mutation: any,
  result: any,
): void {
  // MUT-001: If silent: true, suppress event emission entirely
  if (mutation.silent === true) {
    return;
  }

  // Derive action from mutation.operation (CLIENT-EVENT-001)
  const action = mutation.operation;

  // Derive fields from mutation.record keys, excluding 'id' (CLIENT-EVENT-001)
  let fields: string[] | undefined;
  if (mutation.operation !== "delete" && mutation.record) {
    fields = Object.keys(mutation.record)
      .filter((k) => k !== "id")
      .sort(); // deterministic order
  }

  const baseEvent = {
    resource: mutation.resource,
    ids: Array.isArray(mutation.id) ? mutation.id : [mutation.id],
    mutationId: mutation.mutationId,
    clientId: mutation.clientId,
    timestampMs: getTimestamp(),
    action, // NEW: CLIENT-EVENT-001
    fields, // NEW: CLIENT-EVENT-001
    ...(mutation.record && { record: mutation.record }), // SIG-003: include record for optimistic patching
    ...(mutation.context !== undefined && { context: mutation.context }), // API-002: propagate context
    ...(mutation.system === true && { system: true }), // MUT-002: propagate system flag
  };

  if (result.ok) {
    // Successful mutation - emit mutation_applied
    eventBus.emit({
      type: "mutation_applied",
      ...baseEvent,
    });
  } else {
    // Failed mutation - emit mutation_rejected with error context
    const errorContext = result.errors?.[0] || {
      code: "UNKNOWN",
      message: "Mutation failed",
      path: "$",
    };

    eventBus.emit({
      type: "mutation_rejected",
      ...baseEvent,
      context: errorContext,
    } as any);
  }
}

/**
 * Emit mutation_rejected for thrown errors (CLIENT-EVENT-001)
 * MUT-001: Skip emission if silent: true
 * MUT-002: Include system flag in event payload
 */
function emitRejectionForError(
  eventBus: EventBus,
  getTimestamp: () => number,
  mutation: any,
  error: any,
): void {
  // MUT-001: If silent: true, suppress event emission entirely
  if (mutation.silent === true) {
    return;
  }

  // Derive action and fields same as above
  const action = mutation.operation;
  let fields: string[] | undefined;
  if (mutation.operation !== "delete" && mutation.record) {
    fields = Object.keys(mutation.record)
      .filter((k) => k !== "id")
      .sort();
  }

  const errorContext = {
    code: error.code || "INTERNAL",
    message: error.message || "Remote error",
    path: error.path || "$",
  };

  eventBus.emit({
    type: "mutation_rejected",
    resource: mutation.resource,
    ids: Array.isArray(mutation.id) ? mutation.id : [mutation.id],
    mutationId: mutation.mutationId,
    clientId: mutation.clientId,
    timestampMs: getTimestamp(),
    action,
    fields,
    context: errorContext,
    ...(mutation.system === true && { system: true }), // MUT-002: propagate system flag
  } as any);
}
