/**
 * DataFn Table Handle
 *
 * Represents a table/resource from the schema with methods for query, mutation, signals, and subscriptions.
 */

import type {
  DatafnSchema,
  DatafnResourceSchema,
  DatafnSchemaLiteral,
  DatafnSignal,
  DfqlQueryFragment,
  DfqlMutationFragment,
  DfqlTransact,
} from "@datafn/core";
import { resolveCapabilities } from "@datafn/core";
import { createClientError } from "../errors.js";
import type { EventHandler } from "../events/bus.js";
import type { EventFilter } from "../events/filter.js";
import type { SignalRegistry } from "../signals/querySignal.js";
import type { DatafnSignalOptions } from "../signals/options.js";
import {
  buildTableOperationMutation,
  buildShareMutation,
  buildUnshareMutation,
  buildPrincipalShareMutation,
  buildPrincipalUnshareMutation,
  type PrincipalShareMutationInput,
  type PrincipalUnshareMutationInput,
  type TableOperation,
} from "../mutate.js";
import {
  buildGetPermissionsQuery,
  type PermissionEntry,
} from "../query.js";

type QueryMetadata = {
  includeTrashed?: boolean;
  includeArchived?: boolean;
  includeAncestorInactive?: boolean;
};

type SelectOptions = {
  select?: readonly string[];
  metadata?: QueryMetadata;
  signal?: AbortSignal;
};

type DatafnEnumValue<Field> = Field extends { readonly enum: readonly (infer Value)[] }
  ? Extract<Value, string | number | boolean>
  : never;

type DatafnFieldValue<Type, Field = unknown> =
  [DatafnEnumValue<Field>] extends [never] ? (
  Type extends "string" | "file" ? string :
  Type extends "number" ? number :
  Type extends "boolean" ? boolean :
  Type extends "date" ? string | Date :
  Type extends "array" ? any[] :
  Type extends "object" | "json" ? any :
  unknown
  ) : DatafnEnumValue<Field>;

type FieldName<Field> = Field extends { readonly name: infer Name extends string }
  ? Name
  : never;

type NullableFieldValue<Field, Value> = Field extends {
  readonly nullable?: infer Nullable;
}
  ? "nullable" extends keyof Field
    ? true extends Nullable
      ? Value | null
      : Value
    : Value
  : Value;

type IsAny<T> = 0 extends (1 & T) ? true : false;
type RequiredFields<Fields> = Extract<Fields, { readonly required: true }>;
type OptionalFields<Fields> = Exclude<Fields, { readonly required: true }>;

type DatafnSchemaResources<S extends DatafnSchema> =
  IsAny<S> extends true
    ? DatafnResourceSchema
    : DatafnSchema extends S
      ? DatafnResourceSchema
      : DatafnSchemaLiteral<S> extends { readonly resources: readonly (infer Resource)[] }
        ? Resource
        : S extends { readonly resources: readonly (infer Resource)[] }
          ? Resource
          : never;

type ResourceByName<S extends DatafnSchema, Name extends string> = Extract<
  DatafnSchemaResources<S>,
  { readonly name: Name }
>;

export type DatafnResourceName<S extends DatafnSchema> =
  DatafnSchemaResources<S> extends { readonly name: infer Name extends string }
    ? Name
    : never;

type DatafnCapabilityRecord = {
  createdAt: string | Date;
  updatedAt: string | Date;
  createdBy?: string | null;
  updatedBy?: string | null;
  trashedAt?: string | Date | null;
  trashedBy?: string | null;
  isArchived?: boolean;
  visibility?: string;
};

export type DatafnResourceRecord<
  S extends DatafnSchema,
  Name extends string,
> =
  ResourceByName<S, Name> extends { readonly fields: readonly (infer Field)[] }
    ? {
        [F in RequiredFields<Field> as FieldName<F>]: F extends {
          readonly type: infer Type;
        }
          ? NullableFieldValue<F, DatafnFieldValue<Type, F>>
          : unknown;
      } & {
        [F in OptionalFields<Field> as FieldName<F>]?: F extends {
          readonly type: infer Type;
        }
          ? NullableFieldValue<F, DatafnFieldValue<Type, F>>
          : unknown;
      }
      & DatafnCapabilityRecord
    : Record<string, unknown> & DatafnCapabilityRecord;

export type DatafnFilter<TRecord = Record<string, unknown>> =
  Partial<Record<keyof TRecord & string, unknown>> & Record<string, unknown>;

export type DatafnTableQueryFragment<TRecord = Record<string, unknown>> =
  Omit<DfqlQueryFragment, "select" | "omit" | "filters" | "sort" | "groupBy"> & {
    select?: readonly string[];
    omit?: readonly string[];
    filters?: DatafnFilter<TRecord>;
    sort?: readonly string[];
    groupBy?: readonly string[];
    metadata?: QueryMetadata;
  };

export type DatafnRelationQueryFragment =
  Omit<
    DfqlQueryFragment,
    | "relation"
    | "id"
    | "filters"
    | "search"
    | "groupBy"
    | "aggregations"
    | "having"
    | "temporal"
    | "cursor"
    | "select"
    | "omit"
    | "sort"
  > & {
    select?: readonly string[];
    omit?: readonly string[];
    sort?: readonly string[];
    metadata?: QueryMetadata;
  };

type SelectToken<Q> = Q extends { readonly select: readonly (infer Token)[] }
  ? Token
  : never;

type StringSelectToken<Q> = Extract<SelectToken<Q>, string>;
type SelectedFieldName<Q> = Exclude<StringSelectToken<Q>, "*" | `${string}.${string}`>;
type HasWildcardSelect<Q> = Extract<StringSelectToken<Q>, "*"> extends never
  ? false
  : true;
type HasSelect<Q> = Q extends { readonly select: readonly unknown[] }
  ? true
  : false;

type SelectedRecord<TRecord, Q> =
  HasSelect<Q> extends false
    ? TRecord
    : HasWildcardSelect<Q> extends true
      ? TRecord & Record<string, unknown>
      : [SelectedFieldName<Q>] extends [never]
        ? Partial<TRecord> & Record<string, unknown>
        : Pick<TRecord, Extract<keyof TRecord, SelectedFieldName<Q>>> &
            Partial<TRecord> &
            Record<Exclude<SelectedFieldName<Q>, keyof TRecord>, unknown>;

export type DatafnQueryResult<TRecord, Q> =
  Q extends { readonly aggregations: Record<string, unknown> }
    ? { data: Array<Record<string, unknown>>; count?: number; nextCursor?: string | null }
    : { data: Array<SelectedRecord<TRecord, Q>>; count?: number; nextCursor?: string | null };

export type DatafnSignalValue<TRecord, Q> =
  Q extends { readonly count: true }
    ? { count?: number; data?: Array<SelectedRecord<TRecord, Q>> } | Array<SelectedRecord<TRecord, Q>>
    : Q extends { readonly aggregations: Record<string, unknown> }
      ? Array<Record<string, unknown>>
      : Array<SelectedRecord<TRecord, Q>>;

const DFQL_PRINCIPAL_INVALID_CODE = "DFQL_PRINCIPAL_INVALID" as any;
const DFQL_SHARE_SCOPE_INVALID_CODE = "DFQL_SHARE_SCOPE_INVALID" as any;
const LEGACY_SHARE_WARNING =
  "Deprecated shareWith.userId is accepted for compatibility; use shareWith.principalId";

export interface DatafnTable<
  S extends DatafnSchema = DatafnSchema,
  Name extends string = DatafnResourceName<S>,
  TRecord = DatafnResourceRecord<S, Name>,
> {
  name: Name;
  version: number;

  query<const Q extends DatafnTableQueryFragment<TRecord>>(
    q: Q,
  ): Promise<DatafnQueryResult<TRecord, Q>>;
  select<const O extends SelectOptions | undefined = undefined>(
    id: string,
    options?: O,
  ): Promise<SelectedRecord<TRecord, O> | undefined>;
  mutate(m: DfqlMutationFragment | DfqlMutationFragment[]): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  trash?: (id: string) => Promise<unknown>;
  restore?: (id: string) => Promise<unknown>;
  archive?: (id: string) => Promise<unknown>;
  unarchive?: (id: string) => Promise<unknown>;
  share?: {
    (id: string, userId: string, level: string): Promise<unknown>;
    (input: PrincipalShareMutationInput): Promise<unknown>;
  };
  unshare?: {
    (id: string, userId: string): Promise<unknown>;
    (input: PrincipalUnshareMutationInput): Promise<unknown>;
  };
  getPermissions?: (id: string) => Promise<PermissionEntry[]>;
  transact(payload: DfqlTransact): Promise<unknown>;
  signal<const Q extends DatafnTableQueryFragment<TRecord>>(
    q: Q,
    options?: DatafnSignalOptions,
  ): DatafnSignal<DatafnSignalValue<TRecord, Q>>;
  relation(relationName: string): {
    query<const Q extends DatafnRelationQueryFragment>(
      id: string,
      q?: Q,
    ): Promise<DatafnQueryResult<Record<string, unknown>, Q>>;
    signal<const Q extends DatafnRelationQueryFragment>(
      id: string,
      q?: Q,
      options?: DatafnSignalOptions,
    ): DatafnSignal<DatafnSignalValue<Record<string, unknown>, Q>>;
  };
  subscribe(handler: EventHandler, filter?: EventFilter): () => void;
}

// Forward declaration for client interface
interface ClientWithQuery {
  query(q: unknown | unknown[]): Promise<unknown>;
  mutate(m: unknown | unknown[]): Promise<unknown>;
  transact(payload: unknown): Promise<unknown>;
  subscribe(handler: EventHandler, filter?: EventFilter): () => void;
}

/**
 * Create a table handle (internal factory)
 */
export function createTable<S extends DatafnSchema>(
  name: string,
  version: number,
  client: ClientWithQuery,
  signalRegistry: SignalRegistry,
  generateId: (params: { resource: string; idPrefix?: string }) => string,
  schema: S,
): DatafnTable<S, string> {
  const resource = schema.resources.find((r) => r.name === name);
  const resolvedCapabilities = resource
    ? resolveCapabilities(
        schema.capabilities as any,
        resource.capabilities as any,
      )
    : [];

  const executeOperation = async (
    operation: TableOperation,
    id: string,
  ): Promise<unknown> =>
    client.mutate(buildTableOperationMutation(name, version, operation, id));

  const table: DatafnTable<S, string> = {
    name,
    version,

    /**
     * Execute a query with resource/version merged (CLIENT-QUERY-001)
     */
    async query<const Q extends DatafnTableQueryFragment<DatafnResourceRecord<S, string>>>(
      q: Q,
    ): Promise<DatafnQueryResult<DatafnResourceRecord<S, string>, Q>> {
      // Merge query fragment with table resource/version
      const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
        string,
        unknown
      >;

      // Remove resource/version from fragment if present (table is authoritative)
      const { resource: _r, version: _v, ...rest } = fragment;

      // Build full query
      const fullQuery = {
        resource: name,
        version,
        ...rest,
      };

      // Delegate to client.query and return single result
      return client.query(fullQuery) as Promise<
        DatafnQueryResult<DatafnResourceRecord<S, string>, Q>
      >;
    },

    async select<const O extends SelectOptions | undefined = undefined>(
      id: string,
      options?: O,
    ): Promise<SelectedRecord<DatafnResourceRecord<S, string>, O> | undefined> {
      const result = (await table.query({
        select: options?.select,
        filters: { id },
        limit: 1,
        metadata: options?.metadata,
        signal: options?.signal,
      } as any)) as { data?: unknown[] };
      return result.data?.[0] as
        | SelectedRecord<DatafnResourceRecord<S, string>, O>
        | undefined;
    },

    /**
     * Execute a mutation with resource/version merged (CLIENT-MUT-001)
     */
    async mutate(
      m: DfqlMutationFragment | DfqlMutationFragment[],
    ): Promise<unknown> {
      // Normalize to array for processing if needed, but here we just pass through
      // Since executeMutation handles single or array, we just need to preserve that structure
      // But we need to inject resource/version into each item if it's an array, or the item itself

      const mutations = Array.isArray(m) ? m : [m];

      const fullMutations = mutations.map((fragment) => {
        const {
          resource: _r,
          version: _v,
          ...rest
        } = fragment as Record<string, unknown>;
        const mutation = {
          resource: name,
          version,
          ...rest,
        } as Record<string, unknown>;

        // Auto-generate ID for insert operations if not provided (API-001)
        if (mutation.operation === "insert" && !mutation.id) {
          // Find resource in schema to get idPrefix
          const resource = schema.resources.find((r) => r.name === name);
          const idPrefix = resource?.idPrefix;

          // Generate ID with resource and idPrefix
          const generatedId = generateId({ resource: name, idPrefix });

          // Validate prefix (API-001)
          const expectedPrefix = idPrefix || name;
          if (!generatedId.startsWith(`${expectedPrefix}:`)) {
            throw createClientError(
              "DFQL_INVALID",
              "Invalid id: does not match required prefix",
              { path: "id" },
            );
          }

          mutation.id = generatedId;
        }

        return mutation;
      });

      // Delegate to client.mutate and return single result (or array if input was array)
      const result = await client.mutate(
        Array.isArray(m) ? fullMutations : fullMutations[0],
      );
      return result;
    },

    async delete(id: string): Promise<unknown> {
      return executeOperation("delete", id);
    },

    /**
     * Execute a transaction (CLIENT-TX-001)
     */
    async transact(payload: DfqlTransact): Promise<unknown> {
      // Delegate directly to client.transact without modification
      // Note: client.transact expects unknown but at runtime/logic level it handles it.
      // Ideally client.transact should also be typed; cast here to keep table API ergonomic.
      return client.transact(payload as any);
    },

    /**
     * Create reactive query signal (CLIENT-SIGNAL-001, SIG-003)
     */
    signal<const Q extends DatafnTableQueryFragment>(
      q: Q,
      options?: DatafnSignalOptions,
    ): DatafnSignal<DatafnSignalValue<DatafnResourceRecord<S, string>, Q>> {
      // Merge query fragment with table resource/version
      const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
        string,
        unknown
      >;

      // Remove resource/version from fragment if present (table is authoritative)
      const { resource: _r, version: _v, ...rest } = fragment;

      // Build full query
      const fullQuery = {
        resource: name,
        version,
        ...rest,
      };

      // Get or create signal from registry (ensures caching by dfqlKey)
      return signalRegistry.getSignal<
        DatafnSignalValue<DatafnResourceRecord<S, string>, Q>
      >(fullQuery, options);
    },

    relation(relationName: string) {
      return {
        async query<const Q extends DatafnRelationQueryFragment>(
          id: string,
          q?: Q,
        ): Promise<DatafnQueryResult<Record<string, unknown>, Q>> {
          const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
            string,
            unknown
          >;
          const {
            resource: _r,
            version: _v,
            relation: _relation,
            id: _id,
            ...rest
          } = fragment;
          return client.query({
            resource: name,
            version,
            relation: relationName,
            id,
            ...rest,
          }) as Promise<DatafnQueryResult<Record<string, unknown>, Q>>;
        },
        signal<const Q extends DatafnRelationQueryFragment>(
          id: string,
          q?: Q,
          options?: DatafnSignalOptions,
        ): DatafnSignal<DatafnSignalValue<Record<string, unknown>, Q>> {
          const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
            string,
            unknown
          >;
          const {
            resource: _r,
            version: _v,
            relation: _relation,
            id: _id,
            ...rest
          } = fragment;
          return signalRegistry.getSignal<
            DatafnSignalValue<Record<string, unknown>, Q>
          >(
            {
              resource: name,
              version,
              relation: relationName,
              id,
              ...rest,
            },
            options,
          );
        },
      };
    },

    /**
     * Subscribe to events for this table's resource (CLIENT-SUB-001)
     */
    subscribe(handler: EventHandler, filter?: EventFilter): () => void {
      // Inject resource filter (table is authoritative)
      const tableFilter: EventFilter = {
        ...filter,
        resource: name, // Always use table's resource, ignore user-provided
      };

      return client.subscribe(handler, tableFilter);
    },
  };

  if (resolvedCapabilities.some((capability) => capability === "trash")) {
    table.trash = async (id: string): Promise<unknown> =>
      executeOperation("trash", id);
    table.restore = async (id: string): Promise<unknown> =>
      executeOperation("restore", id);
  }

  if (resolvedCapabilities.some((capability) => capability === "archivable")) {
    table.archive = async (id: string): Promise<unknown> =>
      executeOperation("archive", id);
    table.unarchive = async (id: string): Promise<unknown> =>
      executeOperation("unarchive", id);
  }

  const hasShareableCapability = resolvedCapabilities.some(
    (capability) =>
      typeof capability === "object" &&
      capability !== null &&
      "shareable" in (capability as Record<string, unknown>),
  );
  if (hasShareableCapability) {
    table.share = (async (...args: unknown[]): Promise<unknown> => {
      if (
        args.length === 3 &&
        typeof args[0] === "string" &&
        typeof args[1] === "string" &&
        typeof args[2] === "string"
      ) {
        console.warn(LEGACY_SHARE_WARNING, {
          code: "DFQL_LEGACY_API_DEPRECATED",
          operation: "share",
          path: "shareWith.userId",
          replacement: "shareWith.principalId",
        });
        return client.mutate(
          buildShareMutation(name, version, args[0], args[1], args[2]),
        );
      }

      const input = args[0] as PrincipalShareMutationInput | undefined;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw createClientError("DFQL_INVALID", "Invalid share arguments", {
          path: "shareWith",
        });
      }
      if (typeof input.principalId !== "string" || input.principalId.trim().length === 0) {
        throw createClientError(DFQL_PRINCIPAL_INVALID_CODE, "principalId must be non-empty string", {
          path: "shareWith.principalId",
        });
      }
      if (typeof input.level !== "string") {
        throw createClientError("DFQL_INVALID", "Invalid DFQL: shareWith.level must be string", {
          path: "shareWith.level",
        });
      }
      const scope = input.scope ?? "record";
      if (scope !== "record" && scope !== "resource") {
        throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "scope must be either record or resource", {
          path: "scope",
        });
      }
      if (scope === "record") {
        if (typeof input.id !== "string" || input.id.length === 0) {
          throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "record scope share must include id", {
            path: "id",
          });
        }
      } else if (input.id !== undefined) {
        throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "resource scope share must omit id", {
          path: "id",
        });
      }

      return client.mutate(
        buildPrincipalShareMutation(name, version, {
          id: input.id,
          scope,
          principalId: input.principalId,
          level: input.level,
        }),
      );
    }) as DatafnTable<S, string>["share"];
    table.unshare = (async (...args: unknown[]): Promise<unknown> => {
      if (
        args.length === 2 &&
        typeof args[0] === "string" &&
        typeof args[1] === "string"
      ) {
        console.warn(LEGACY_SHARE_WARNING, {
          code: "DFQL_LEGACY_API_DEPRECATED",
          operation: "unshare",
          path: "shareWith.userId",
          replacement: "shareWith.principalId",
        });
        return client.mutate(buildUnshareMutation(name, version, args[0], args[1]));
      }

      const input = args[0] as PrincipalUnshareMutationInput | undefined;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw createClientError("DFQL_INVALID", "Invalid unshare arguments", {
          path: "shareWith",
        });
      }
      if (typeof input.principalId !== "string" || input.principalId.trim().length === 0) {
        throw createClientError(DFQL_PRINCIPAL_INVALID_CODE, "principalId must be non-empty string", {
          path: "shareWith.principalId",
        });
      }
      const scope = input.scope ?? "record";
      if (scope !== "record" && scope !== "resource") {
        throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "scope must be either record or resource", {
          path: "scope",
        });
      }
      if (scope === "record") {
        if (typeof input.id !== "string" || input.id.length === 0) {
          throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "record scope share must include id", {
            path: "id",
          });
        }
      } else if (input.id !== undefined) {
        throw createClientError(DFQL_SHARE_SCOPE_INVALID_CODE, "resource scope share must omit id", {
          path: "id",
        });
      }

      return client.mutate(
        buildPrincipalUnshareMutation(name, version, {
          id: input.id,
          scope,
          principalId: input.principalId,
        }),
      );
    }) as DatafnTable<S, string>["unshare"];
    table.getPermissions = async (id: string): Promise<PermissionEntry[]> =>
      client.query(buildGetPermissionsQuery(name, version, id)) as Promise<PermissionEntry[]>;
  }

  return table;
}
