/**
 * DataFn Server Factory
 * Creates a Router with datafn endpoints
 */

import type { DatafnError, RetentionConfig, RateLimitConfig, ObservabilityConfig } from "./core-types.js";
import type {
  DatafnPlugin,
  DatafnRelationSchema,
  DatafnResourceSchema,
  DatafnSchema,
} from "@datafn/core/types";
import type { SearchProvider } from "./search-provider.js";
import { parseDatafnRequest, collectStructuralResourceSelectors, validateSchema, ensureBuiltinKv, ensureBuiltinTemporal, isNamespaced } from "@datafn/core";
import {
  createObservabilityMiddleware,
  createRouter,
  executeMiddlewareChain,
  type Router,
  type Route,
  type RouteHandler,
} from "@superfunctions/http";
import type { Adapter, RowLevelNamespaceConfig, RuntimeStores } from "@superfunctions/db";
import { instrumentAdapter, instrumentKVStore, wrapWithRowLevelNamespace } from "@superfunctions/db";
import { normalizeObservability, type ObservabilityInput, type ObservationLogger } from "@superfunctions/observability";
import type { SequenceStore, SequenceStorePolicy } from "./execution/sync/sequence-store.js";
import { createSequenceStore } from "./execution/sync/sequence-store.js";
import { createStatusHandler } from "./routes/status.js";
import { createQueryHandler } from "./routes/query.js";
import { createMutationHandler } from "./routes/mutation.js";
import { createTransactHandler } from "./routes/transact.js";
import {
  createCloneHandler,
  createPullHandler,
  createPushHandler,
  createReconcileHandler,
} from "./routes/sync.js";
import { createSeedHandler } from "./routes/seed.js";
import { createSearchHandler } from "./routes/search.js";
import { executeCrossResourceSearch } from "./execution/search/cross-resource.js";
import {
  executeDbNativeCrossResourceSearch,
  hasDbNativeSearchSupport,
  NO_PROVIDER_NATIVE_UNSUPPORTED_MESSAGE,
} from "./execution/search/native-fallback.js";
import { DbIdempotencyStore } from "./execution/idempotency-db.js";
import { ChangeTrackingService } from "./execution/sync/change-tracking.js";
import { errorResponse, errorToEnvelope } from "./http/errors.js";
import { createRestRoutes, sanitizePathSegment } from "./routes/rest.js";
import { checkPayloadLimit, readBodyWithLimit } from "./http/middleware.js";
import { parseJsonBody } from "./http/json.js";
import { WebSocketManager, type WebSocketClient, type WsAuthContext } from "./ws.js";
import type { WsManagerConfig } from "./ws.js";
import {
  AtomicRateLimiter,
  CacheRateLimiter,
  MemoryRateLimiter,
  createRateLimitMiddleware,
} from "./middleware/rate-limit.js";
import { createTimingEmitter, type TimingEmitter } from "./middleware/timing.js";
import { createDefaultLogger, type DatafnLogger } from "./logger.js";
import { DatafnExecutionError } from "./execution/errors.js";
import { DatafnExecutorError, type DatafnExecutor } from "./executor.js";
import {
  setSpv2MigrationRuntimeConfig,
  type Spv2MigrationRuntimeConfig,
} from "./execution/migration/spv2.js";
import type { DatafnPublicLinksPlugin } from "./plugins/public-links.js";
import { getDatafnMultiRegionRuntimeConfig } from "./plugins/multi-region.js";
import {
  DatafnRoutingError,
  prepareDatafnRoutingRequest,
  type PreparedDatafnRoutingRequest,
  validateDatafnPlacement,
} from "./multi-region-routing.js";
import type {
  DataFnAction,
  DataFnAuthorizationDeniedMetadata,
  DataFnEvent,
  DataFnPayloadRejectedMetadata,
  DataFnRateLimitedMetadata,
  DataFnRequestEventMetadata,
  DataFnRequestFailedMetadata,
} from "./events.js";
import {
  drainPermissionDirectoryOutbox,
  ensurePermissionDirectoryOutbox,
} from "./execution/mutation/permission-directory-outbox.js";

type IndexConfig = { search?: readonly string[] };

/** Per-request data available to DataFn route response hooks. */
export interface DatafnRouteHookInput<TContext = any> {
  action: DataFnAction;
  request: Request;
  context: TContext & { parsedBody?: unknown };
  payload: unknown;
  response: Response;
}

/** Transforms a DataFn HTTP response after route execution. */
export type DatafnRouteResponseHook<TContext = any> = (
  input: DatafnRouteHookInput<TContext>,
) => Response | Promise<Response>;

/** Header tuple entries accepted by DataFn route header hooks. */
export type DatafnRouteHeaderEntries = [string, string][];

/** Header input accepted by DataFn route header hooks. */
export type DatafnRouteHeaderInput = Headers | Record<string, string> | DatafnRouteHeaderEntries;

/** Static or computed response headers applied after DataFn route hooks. */
export type DatafnRouteHeaders<TContext = any> =
  | DatafnRouteHeaderInput
  | ((
    input: DatafnRouteHookInput<TContext>,
  ) => DatafnRouteHeaderInput | null | undefined | Promise<DatafnRouteHeaderInput | null | undefined>);

/** Route lifecycle hooks for framework-level DataFn HTTP behavior. */
export interface DatafnRouteHooks<TContext = any> {
  afterResponse?: DatafnRouteResponseHook<TContext> | readonly DatafnRouteResponseHook<TContext>[];
  headers?: DatafnRouteHeaders<TContext>;
}

export type DatafnPluginRoutePlacementResult = string | Response;

/**
 * Placement declaration required for custom plugin routes in regional-cell
 * mode. Returning a Response lets authentication/not-found handling stop
 * before any regional database access.
 */
export interface DatafnPluginRoutePlacement<TContext = any> {
  resolveNamespace(
    request: Request,
    context: TContext,
  ): DatafnPluginRoutePlacementResult | Promise<DatafnPluginRoutePlacementResult>;
  /** Transfers validated resolver state from the body-safe clone to the handler request. */
  bindHandlerRequest?(
    placementRequest: Request,
    handlerRequest: Request,
    context: TContext,
  ): void | Promise<void>;
}

export type DatafnComposableRoute<TContext = any> = Route<TContext> & {
  meta?: Route<TContext>["meta"] & {
    datafnPlacement?: "none" | DatafnPluginRoutePlacement<TContext>;
  };
};

/** Data provided to server plugins before a DataFn action is authorized and executed. */
export interface DatafnPluginAuthorizationInput<TContext = any> {
  action: DataFnAction;
  request: Request;
  context: TContext & { parsedBody?: unknown };
  payload: unknown;
}

/** Server plugin authorization decisions are fail-closed only when false or an error is returned. */
export type DatafnPluginAuthorizationResult = boolean | void;

type DatafnServerComposablePlugin = DatafnPlugin & {
  internalResources?: readonly string[];
  modelName?: string;
  withSchema?: (schema: DatafnSchema) => DatafnSchema;
  permissionDirectoryRuntime?: import("./plugins/multi-region.js").DatafnMultiRegionRuntimeConfig;
  routes?: (input: {
    database: Adapter;
    crossNamespaceDatabase?: Adapter;
    schema: DatafnSchema;
  }) => DatafnComposableRoute[];
  authorize?: (
    input: DatafnPluginAuthorizationInput,
  ) => Promise<DatafnPluginAuthorizationResult> | DatafnPluginAuthorizationResult;
};

function isIndexConfig(value: unknown): value is IndexConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excludeInternalResources(
  schema: DatafnSchema,
  internalResourceNames: ReadonlySet<string>,
): DatafnSchema {
  if (internalResourceNames.size === 0) {
    return schema;
  }
  return {
    ...schema,
    resources: schema.resources.filter((resource) => !internalResourceNames.has(resource.name)),
    relations: (schema.relations ?? []).filter(
      (relation) => !relationReferencesInternalResource(relation, internalResourceNames),
    ),
  };
}

function relationReferencesInternalResource(
  relation: DatafnRelationSchema,
  internalResourceNames: ReadonlySet<string>,
): boolean {
  return [
    ...normalizeResourceEndpoint(relation.from),
    ...normalizeResourceEndpoint(relation.to),
  ].some((resource) => internalResourceNames.has(resource));
}

function normalizeResourceEndpoint(endpoint: string | readonly string[]): string[] {
  return typeof endpoint === "string" ? [endpoint] : [...endpoint];
}

function normalizePluginAuthorizationError(
  error: unknown,
  pluginName: string,
): { code: "FORBIDDEN"; message: string; details: Record<string, unknown> } {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    return {
      code: "FORBIDDEN",
      message: typeof candidate.message === "string" ? candidate.message : "Authorization denied",
      details: {
        path:
          candidate.details &&
          typeof candidate.details === "object" &&
          !Array.isArray(candidate.details) &&
          typeof (candidate.details as Record<string, unknown>).path === "string"
            ? String((candidate.details as Record<string, unknown>).path)
            : "$",
        plugin: pluginName,
      },
    };
  }
  return {
    code: "FORBIDDEN",
    message: "Authorization denied",
    details: { path: "$", plugin: pluginName },
  };
}

/**
 * Runtime configuration for a DataFn HTTP server.
 */
export interface DatafnServerConfig<TContext = any> {
  /** DataFn schema used to validate resources, relations, fields, permissions, and generated routes at startup. */
  schema: DatafnSchema;

  /** Database adapter used for resource persistence, query execution, mutations, sync change logs, and internal tables. */
  database?: Adapter;

  /** @deprecated Use `database`. Retained for compatibility with the original DataFn server API. */
  db?: Adapter;

  /** Runtime plugins that extend schema, add internal resources, register routes, or provide DataFn capabilities. */
  plugins?: DatafnPlugin[];

  /** Public-link plugin instance used to register share-link routes and resolve link principals. */
  publicLinks?: DatafnPublicLinksPlugin;

  /** Authorizes each DataFn action after context creation and before route execution. */
  authorize?: (
    ctx: TContext & { parsedBody?: unknown },
    action:
      | "status"
      | "query"
      | "mutation"
      | "transact"
      | "seed"
      | "clone"
      | "pull"
      | "push"
      | "reconcile"
      | "search",
    payload: unknown,
  ) => Promise<boolean> | boolean;

  /** Static context or request-scoped context factory passed to authorization, namespace resolution, route handlers, and hooks. */
  context?: TContext | ((request: Request) => Promise<TContext> | TContext);

  /** Request, query, mutation, and validation limits enforced by DataFn routes. */
  limits?: {
    /** Maximum number of records a query may request unless a route applies a stricter limit. */
    maxLimit?: number;
    /** Maximum number of steps accepted in a single transact request. */
    maxTransactSteps?: number;
    /** Maximum request body size in bytes before DataFn rejects the payload. */
    maxPayloadBytes?: number;
    /** Maximum number of changes returned by a pull request. Default: 1000. */
    maxPullLimit?: number;
    /** Maximum number of select tokens accepted per query. Default: 50. */
    maxSelectTokens?: number;
    /** Maximum number of filter keys accepted at each nesting level. Default: 20. */
    maxFilterKeysPerLevel?: number;
    /** Maximum number of sort fields accepted by a query. Default: 10. */
    maxSortFields?: number;
    /** Maximum number of aggregate expressions accepted by a query. Default: 20. */
    maxAggregations?: number;
    /** Maximum resource or relation ID length accepted by routes. Default: 255. */
    maxIdLength?: number;
    /** Maximum number of items accepted by push and mutation batch endpoints. Default: 500. */
    maxBatchSize?: number;
    /** Maximum number of concurrent query executions allowed inside a batch request. Default: 20. */
    maxBatchQueryConcurrency?: number;
  };

  /**
   * Enables detailed validation errors with field names and schema details.
   * Defaults to true outside production and generic errors in production.
   */
  debug?: boolean;

  /**
   * Allows actions on resources that do not define authorization policies.
   * When false, policy-less resources return FORBIDDEN.
   */
  allowUnknownResources?: boolean;

  /** Clock source used by server routes, sync, and retention logic; primarily useful for tests. */
  getServerTime?: () => number;

  /**
   * Enables REST wrappers around DataFn resources.
   * Adds GET, POST, PATCH, and DELETE routes under /datafn/resources/:resource.
   */
  rest?: boolean;

  /**
   * Resolves per-request namespace isolation and actor attribution.
   * Without this, all data uses the default "datafn" namespace.
   *
   * @example
   * ```typescript
   * namespaceProvider: {
   *   getNamespace: (ctx) => ns(ctx.orgId, ctx.userId),
   *   getActorId: (ctx) => ctx.userId,
   * }
   * ```
   */
  namespaceProvider?: {
    /** Returns the namespace that scopes all resource, relation, sync, and search operations for the request. */
    getNamespace: (ctx: TContext) => string | Promise<string>;
    /** Returns the actor ID used for audit attribution and sync metadata, separate from namespace isolation. */
    getActorId?: (ctx: TContext) => string | undefined | Promise<string | undefined>;
  };

  /** Runtime cache and atomic stores used for rate limiting, sync coordination, and optional server state. */
  stores?: RuntimeStores;

  /** Sequence-store policy used by sync to allocate and persist server sequence numbers. */
  serverSeq?: SequenceStorePolicy;

  /**
   * Row-level namespace isolation configuration.
   * Pass false to disable database-level namespace wrapping, or an object to configure row-level scoping.
   */
  rowLevelNamespace?: false | RowLevelNamespaceConfig;

  /** Retention policy for __datafn_changes and __datafn_idempotency internal tables. */
  retention?: RetentionConfig;

  /** Rate-limit policy for DataFn HTTP endpoints. */
  rateLimit?: RateLimitConfig<TContext>;

  /** HTTP route lifecycle hooks applied after context creation, authorization, and handler execution. */
  routeHooks?: DatafnRouteHooks<TContext>;

  /** Observability sink and options for DataFn request, rate-limit, authorization, sync, retention, and failure events. */
  observability?: ObservabilityConfig;

  /**
   * WebSocket connection limits, per-namespace limits, and heartbeat timing used by the sync transport.
   */
  ws?: WsManagerConfig;

  /**
   * Graceful shutdown drain timeout in milliseconds.
   * The server waits up to this long for in-flight requests to complete before closing.
   */
  shutdownTimeoutMs?: number;

  /**
   * SPV2 migration compatibility settings for read mode, write mode, and legacy share API warnings.
   */
  spv2Migration?: Spv2MigrationRuntimeConfig;

  /**
   * Search provider for full-text and semantic search queries.
   * When provided, search routes and mutation index updates use this provider.
   */
  searchProvider?: SearchProvider;
}

/**
 * Server instance
 */
export interface DatafnServer<TContext = any> {
  router: Router<TContext>;
  /** Validated schema used by both HTTP and in-process execution. */
  readonly schema: DatafnSchema;
  /** Transport-neutral execution surface for trusted adapters such as McpFn. */
  readonly executor: DatafnExecutor<TContext>;
  search(
    params: import("./execution/search/cross-resource.js").CrossResourceSearchParams & {
      namespace?: string;
    },
    ctx?: TContext,
  ): Promise<import("./execution/search/cross-resource.js").SearchResult>;
  websocketHandler: {
    /** SEC-001: addClient requires auth context. Reject unauthenticated connections with close code 4401 before calling. */
    /** SCA-005: Returns false (and closes with code 4503) when connection limits are exceeded. */
    addClient(client: WebSocketClient, authContext: WsAuthContext): boolean;
    /** Validates and pins namespace placement during a canonical-gateway handshake. */
    addRoutedClient(
      client: WebSocketClient,
      authContext: WsAuthContext,
      handshakeRequest?: Request,
    ): Promise<boolean>;
    /** Closes stale sessions so clients reconnect through the canonical gateway. */
    fenceNamespace(namespace: string, minimumEpoch?: number): number;
    removeClient(client: WebSocketClient): void;
    handleMessage(client: WebSocketClient, data: string): void;
    /** REL-007: Called by WS transport on native pong frame receipt. */
    handlePong(client: WebSocketClient): void;
  };
  /**
   * Graceful shutdown:
   * 1. Rejects new requests with 503
   * 2. Sends WS close frame 1001 to all clients
   * 3. Waits for in-flight requests to complete (up to shutdownTimeoutMs)
   * 4. Clears timers
   * REL-009
   */
  close(): Promise<void>;
}

/**
 * Create a DataFn server
 */
export async function createDatafnServer<TContext = any>(
  config: DatafnServerConfig<TContext>,
): Promise<DatafnServer<TContext>> {
  const plugins = [...(config.plugins ?? [])] as DatafnServerComposablePlugin[];
  if (config.publicLinks && !plugins.includes(config.publicLinks)) {
    plugins.push(config.publicLinks);
  }
  const multiRegionRuntime = getDatafnMultiRegionRuntimeConfig(plugins);
  const permissionDirectoryRuntimeCandidates = [
    multiRegionRuntime,
    ...plugins.map((plugin) => plugin.permissionDirectoryRuntime ?? null),
  ].filter((runtime): runtime is import("./plugins/multi-region.js").DatafnMultiRegionRuntimeConfig =>
    runtime !== null
  );
  const permissionDirectoryRuntimesByRegion = new Map<
    string,
    import("./plugins/multi-region.js").DatafnMultiRegionRuntimeConfig
  >();
  for (const runtime of permissionDirectoryRuntimeCandidates) {
    const existing = permissionDirectoryRuntimesByRegion.get(runtime.regionId);
    if (existing && existing.directory !== runtime.directory) {
      throw new Error(
        `Permission directory configuration conflict: region ${runtime.regionId} uses multiple directory adapters`,
      );
    }
    permissionDirectoryRuntimesByRegion.set(runtime.regionId, runtime);
  }
  const permissionDirectoryRetryRuntimes = [
    ...permissionDirectoryRuntimesByRegion.values(),
  ];
  const schemaWithPluginResources = plugins.reduce(
    (schema, plugin) => plugin.withSchema ? plugin.withSchema(schema) : schema,
    config.schema,
  );

  // Validate schema at startup
  const schemaValidation = validateSchema(schemaWithPluginResources);
  if (!schemaValidation.ok) {
    throw new Error(
      `Schema validation failed: ${schemaValidation.error.message}`,
    );
  }

  const internalResourceNames = new Set<string>();
  for (const plugin of plugins) {
    for (const resourceName of plugin.internalResources ?? []) {
      internalResourceNames.add(resourceName);
    }
    if (typeof plugin.modelName === "string" && plugin.modelName.length > 0) {
      internalResourceNames.add(plugin.modelName);
    }
  }

  const schemaWithBuiltins = ensureBuiltinTemporal(ensureBuiltinKv(schemaValidation.result));
  const validatedSchema = excludeInternalResources(schemaWithBuiltins, internalResourceNames);

  // VAL-009: Debug mode — default to true in non-production
  const debugMode = config.debug ?? (process.env.NODE_ENV !== "production");

  const observabilityScope = normalizeObservability<DataFnEvent>(
    config.observability as ObservabilityInput<DataFnEvent>,
  )?.child({ component: "datafn" });
  const logger = datafnLoggerFromObservability(
    observabilityScope?.logger,
    createDefaultLogger(debugMode),
  );
  const emitDataFnEvent = async (event: DataFnEvent): Promise<void> => {
    try {
      await observabilityScope?.events.emit(event);
    } catch {
    }
  };

  // COMP-001/COMP-002: configure migration compatibility mode for this server instance.
  setSpv2MigrationRuntimeConfig(config.spv2Migration);

  const configuredDatabase = config.database ?? config.db;

  // Initialize database adapter if provided and implements Adapter interface
  if (
    configuredDatabase &&
    typeof configuredDatabase === "object" &&
    "initialize" in configuredDatabase &&
    typeof configuredDatabase.initialize === "function"
  ) {
    await configuredDatabase.initialize();
  }

  // Row-level namespace auto-wrapping (DFN-001)
  // When schema has namespace isolation enabled (the default) and rowLevelNamespace is not explicitly false,
  // wrap the adapter so all CRUD operations are namespace-isolated.
  // This activates for SQL-backed adapters (which have __ns NOT NULL columns from codegen)
  // regardless of whether a namespace provider is present — without one, the default "datafn"
  // namespace is used. For in-memory adapters (no schema constraints), wrapping is only
  // applied when a namespace/auth provider is present (explicit namespace isolation).
  let db = configuredDatabase;
  const crossNamespaceDb = configuredDatabase;
  const schemaIsNamespaced = isNamespaced(validatedSchema);
  const adapterHasSchemaConstraints = db?.capabilities?.schema?.constraints === true;
  const hasNamespaceProvider = !!config.namespaceProvider;
  const shouldWrapNamespace = db && schemaIsNamespaced && config.rowLevelNamespace !== false
    && (adapterHasSchemaConstraints || hasNamespaceProvider || (typeof config.rowLevelNamespace === 'object' && config.rowLevelNamespace));
  if (shouldWrapNamespace) {
    const rlnConfig: RowLevelNamespaceConfig =
      typeof config.rowLevelNamespace === 'object' && config.rowLevelNamespace
        ? config.rowLevelNamespace
        : { enabled: true, columnName: '__ns', mandatory: true };

    if (rlnConfig.enabled && db) {
      const internal = db.internal; // preserve original internal (already bypassed by wrapper, but be explicit)
      db = wrapWithRowLevelNamespace(db, rlnConfig);
      // Ensure internal is the original unwrapped internal
      (db as any).internal = internal;
    }
  }
  if (db && observabilityScope) {
    db = instrumentAdapter(db, {
      observability: observabilityScope.child({ component: "datafn.db" }),
      kind: "db",
    });
  }
  const stores: RuntimeStores = {
    kv: config.stores?.kv && observabilityScope
      ? instrumentKVStore(config.stores.kv, {
          observability: observabilityScope.child({ component: "datafn.cache" }),
          kind: "cache",
        })
      : config.stores?.kv,
    atomicKv: config.stores?.atomicKv && observabilityScope
      ? instrumentKVStore(config.stores.atomicKv, {
          observability: observabilityScope.child({ component: "datafn.atomic" }),
          kind: "cache",
        })
      : config.stores?.atomicKv,
    directory: config.stores?.directory,
  };

  let permissionDirectoryRetryInterval: ReturnType<typeof setInterval> | null = null;
  if (db && permissionDirectoryRetryRuntimes.length > 0) {
    try {
      await ensurePermissionDirectoryOutbox(db);
    } catch (error) {
      logger.warn("Permission directory retry startup initialization failed", {
        error: String(error),
        operation: "permission-directory-outbox",
      });
    }
    for (const runtime of permissionDirectoryRetryRuntimes) {
      try {
        await drainPermissionDirectoryOutbox(db, runtime, logger);
      } catch (error) {
        logger.warn("Permission directory retry startup drain failed", {
          error: String(error),
          operation: "permission-directory-outbox",
          regionId: runtime.regionId,
        });
      }
    }
  }

  // Startup pruning (RET-004)
  if (config.retention?.pruneOnStartup && db) {
    try {
      const ct = new ChangeTrackingService(db!, "datafn", undefined, undefined, logger);
      if (config.retention.changeLogDays) {
        const deleted = await ct.pruneChanges(config.retention.changeLogDays);
        logger.info("Pruned change log entries", { deleted, operation: "startup-prune" });
        await emitDataFnEvent({
          domain: "datafn",
          type: "datafn.retention.pruned",
          severity: "info",
          outcome: "ok",
          metadata: {
            mode: "startup",
            target: "changes",
            deleted,
          },
        });
      }
      const idempotencyStoreForPrune = db
        ? new DbIdempotencyStore(db, "datafn", logger)
        : undefined;
      if (config.retention.idempotencyDays && idempotencyStoreForPrune) {
        const deleted = await idempotencyStoreForPrune.pruneIdempotency(config.retention.idempotencyDays);
        logger.info("Pruned idempotency entries", { deleted, operation: "startup-prune" });
        await emitDataFnEvent({
          domain: "datafn",
          type: "datafn.retention.pruned",
          severity: "info",
          outcome: "ok",
          metadata: {
            mode: "startup",
            target: "idempotency",
            deleted,
          },
        });
      }
    } catch (error) {
      logger.warn("Startup pruning failed", { error: String(error), operation: "startup-prune" });
      await emitDataFnEvent({
        domain: "datafn",
        type: "datafn.retention.prune_failed",
        severity: "warn",
        outcome: "error",
        metadata: {
          mode: "startup",
          error: String(error),
        },
      });
    }
  }

  // Initialize atomic store health check if provided
  if (stores.atomicKv?.isHealthy) {
    try {
      const healthy = await stores.atomicKv.isHealthy();
      if (!healthy) {
        logger.warn("Atomic store health check failed", { operation: "atomic-health" });
      }
    } catch (error) {
      logger.warn("Atomic store health check error", { error: String(error), operation: "atomic-health" });
    }
  }

  // Create sequence store based on configuration (atomic store/database)
  const sequenceStore = createSequenceStore({
    db,
    stores,
    policy: config.serverSeq,
    logger,
  });

  // VAL-001: allowUnknownResources — default false (deny-by-default)
  const allowUnknownResources = config.allowUnknownResources ?? false;

  // Compute limits with defaults
  const limits = {
    maxLimit: config.limits?.maxLimit ?? 100,
    maxTransactSteps: config.limits?.maxTransactSteps,
    maxPayloadBytes: config.limits?.maxPayloadBytes ?? 5_242_880, // VAL-010
    maxPullLimit: config.limits?.maxPullLimit ?? 1000,
    maxSelectTokens: config.limits?.maxSelectTokens ?? 50,
    maxFilterKeysPerLevel: config.limits?.maxFilterKeysPerLevel ?? 20,
    maxSortFields: config.limits?.maxSortFields ?? 10,
    maxAggregations: config.limits?.maxAggregations ?? 20,
    maxIdLength: config.limits?.maxIdLength ?? 255,
    maxBatchSize: config.limits?.maxBatchSize ?? 500,
    maxBatchQueryConcurrency: config.limits?.maxBatchQueryConcurrency ?? 20,
  };

  // Observability: create timing emitter (OBS-004)
  const timingEmitter = createTimingEmitter(readTimingConfig(config.observability), logger);

  // Rate limiting setup (RATE-001 through RATE-005)
  let rateLimitMiddleware: ((endpoint: string, ctx: TContext) => Promise<Response | null>) | null = null;
  let memoryRateLimiter: MemoryRateLimiter | null = null;

  if (config.rateLimit?.enabled) {
    const mode = config.rateLimit.mode ?? (stores.atomicKv ? "strict" : "local");
    const limiter = (() => {
      if (mode === "strict") {
        if (!stores.atomicKv) {
          throw new Error("DATAFN_ATOMIC_STORE_REQUIRED: rateLimit strict mode requires stores.atomicKv");
        }
        return new AtomicRateLimiter(stores.atomicKv);
      }
      if (mode === "best-effort" && stores.kv) {
        return new CacheRateLimiter(stores.kv);
      }
      const m = new MemoryRateLimiter();
      memoryRateLimiter = m;
      return m;
    })();

    const defaultKeyExtractor = async (ctx: TContext): Promise<string> => {
      if (config.namespaceProvider) {
        try {
          return await config.namespaceProvider.getNamespace(ctx);
        } catch (error) {
          logger.warn("Namespace provider failed for rate limiting, using anonymous", {
            error: String(error),
            operation: "rate-limit-key",
          });
        }
      }
      return "anonymous";
    };

    rateLimitMiddleware = createRateLimitMiddleware({
      limiter,
      maxRequests: config.rateLimit.maxRequests ?? 100,
      windowSeconds: config.rateLimit.windowSeconds ?? 60,
      endpoints: config.rateLimit.endpoints,
      keyExtractor: config.rateLimit.keyExtractor ?? defaultKeyExtractor,
    });
  }

  // Periodic pruning interval (RET-005)
  let pruneInterval: ReturnType<typeof setInterval> | null = null;
  if (config.retention?.pruneIntervalMs && db) {
    const intervalMs = Math.max(config.retention.pruneIntervalMs, 60000);
    const dbForInterval = db;
    const retentionForInterval = config.retention;
    pruneInterval = setInterval(async () => {
      try {
        const ct = new ChangeTrackingService(dbForInterval, "datafn", undefined, undefined, logger);
        if (retentionForInterval.changeLogDays) {
          const deleted = await ct.pruneChanges(retentionForInterval.changeLogDays);
          logger.info("Periodic prune: removed change log entries", { deleted, operation: "periodic-prune" });
          await emitDataFnEvent({
            domain: "datafn",
            type: "datafn.retention.pruned",
            severity: "info",
            outcome: "ok",
            metadata: {
              mode: "periodic",
              target: "changes",
              deleted,
            },
          });
        }
        const idStore = new DbIdempotencyStore(dbForInterval, "datafn", logger);
        if (retentionForInterval.idempotencyDays) {
          const deleted = await idStore.pruneIdempotency(retentionForInterval.idempotencyDays);
          logger.info("Periodic prune: removed idempotency entries", { deleted, operation: "periodic-prune" });
          await emitDataFnEvent({
            domain: "datafn",
            type: "datafn.retention.pruned",
            severity: "info",
            outcome: "ok",
            metadata: {
              mode: "periodic",
              target: "idempotency",
              deleted,
            },
          });
        }
      } catch (e) {
        logger.warn("Periodic prune failed", { error: String(e), operation: "periodic-prune" });
        await emitDataFnEvent({
          domain: "datafn",
          type: "datafn.retention.prune_failed",
          severity: "warn",
          outcome: "error",
          metadata: {
            mode: "periodic",
            error: String(e),
          },
        });
      }
    }, intervalMs);
    // LOW-005: Unref so this timer does not keep the Node.js process alive
    if (pruneInterval && typeof (pruneInterval as NodeJS.Timeout).unref === "function") {
      (pruneInterval as NodeJS.Timeout).unref();
    }
  }

  // Helper to extract namespace
  const extractNamespace = async (ctx: TContext): Promise<string> => {
    if (config.namespaceProvider) {
      const ns = await config.namespaceProvider.getNamespace(ctx);
      if (typeof ns !== "string" || ns === "") {
        const err = new Error("Namespace provider returned empty namespace");
        (err as any).code = "NAMESPACE_INVALID";
        throw err;
      }
      return ns;
    }
    return "datafn";
  };

  // Helper to extract actor ID (for audit attribution)
  const extractActorId = async (ctx: TContext): Promise<string | undefined> => {
    if (config.namespaceProvider?.getActorId) {
      try {
        return await config.namespaceProvider.getActorId(ctx);
      } catch (error) {
        logger.warn("Failed to extract actorId, proceeding without audit attribution", { error: String(error), operation: "extract-actor-id" });
        return undefined;
      }
    }
    return undefined;
  };

  // Create route handlers
  const statusHandler = createStatusHandler(
    validatedSchema,
    {
      maxLimit: limits.maxLimit,
      maxTransactSteps: limits.maxTransactSteps,
      maxPayloadBytes: limits.maxPayloadBytes,
      maxPullLimit: limits.maxPullLimit,
    },
    config.getServerTime,
    db,
  );

  const queryHandler = createQueryHandler(
    validatedSchema,
    limits.maxLimit,
    extractNamespace,
    extractActorId,
    db,
    plugins,
    config.searchProvider,
    timingEmitter,
    {
      maxSelectTokens: limits.maxSelectTokens,
      maxFilterKeysPerLevel: limits.maxFilterKeysPerLevel,
      maxSortFields: limits.maxSortFields,
      maxAggregations: limits.maxAggregations,
      maxBatchQueryConcurrency: limits.maxBatchQueryConcurrency,
      allowUnknownResources,
      debug: debugMode,
      hasSearchProviderFallback: hasDbNativeSearchSupport(db),
    },
    logger,
    crossNamespaceDb,
  );

  // Create mutation handler and idempotency store
  const idempotencyStore = db
    ? new DbIdempotencyStore(db, "datafn", logger)
    : undefined;

  const mutationHandler = createMutationHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    idempotencyStore,
    plugins,
    sequenceStore,
    timingEmitter,
    {
      maxIdLength: limits.maxIdLength,
      maxBatchSize: limits.maxBatchSize,
      allowUnknownResources,
      debug: debugMode,
    },
    logger,
    config.searchProvider,
  );

  const transactHandler = createTransactHandler(
    validatedSchema,
    db,
    idempotencyStore,
    limits,
    extractNamespace,
    extractActorId,
    sequenceStore,
    plugins,
    {
      allowUnknownResources,
      debug: debugMode,
    },
    logger,
  );

  const cloneHandler = createCloneHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    plugins,
    sequenceStore,
    logger,
  );
  const pullHandler = createPullHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    plugins,
    sequenceStore,
    limits.maxPullLimit,
    timingEmitter,
    logger,
  );
  const reconcileHandler = createReconcileHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    plugins,
    sequenceStore,
    logger,
  );

  // WebSocket Manager (SCA-005 limits, REL-007 heartbeat)
  const wsManager = new WebSocketManager(config.ws ?? {}, logger);

  const pushHandler = createPushHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    idempotencyStore,
    plugins,
    sequenceStore,
    (seq, namespace) => wsManager.broadcastCursor(String(seq), namespace),
    timingEmitter,
    {
      maxIdLength: limits.maxIdLength,
      maxBatchSize: limits.maxBatchSize,
      allowUnknownResources,
      debug: debugMode,
    },
    logger,
  );
  const seedHandler = createSeedHandler(db, extractNamespace, logger);

  const searchHandler = createSearchHandler(
    validatedSchema,
    extractNamespace,
    extractActorId,
    db,
    plugins,
    config.searchProvider,
    logger,
  );

  // Initialize search provider if configured
  if (config.searchProvider?.initialize) {
    const resources = validatedSchema.resources
      .map((r: DatafnResourceSchema) => ({
        name: r.name,
        searchFields:
          isIndexConfig(r.indices)
            ? [...(r.indices.search ?? [])]
            : [],
      }))
      .filter((resource: { name: string; searchFields: string[] }) => resource.searchFields.length > 0);
    try {
      await config.searchProvider.initialize({ resources });
    } catch (error) {
      throw new Error(`Search provider initialization failed: ${String(error)}`);
    }
  }

  // In-flight request tracking for graceful shutdown (REL-009)
  let inFlightCount = 0;
  let shuttingDown = false;
  let shutdownResolve: (() => void) | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;

  // Authorization wrapper
  // AUTH-001: Parse JSON BEFORE authorization. Invalid JSON returns DFQL_INVALID, not FORBIDDEN.
  const isPlainObjectContext = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const createEnrichedContext = (
    ctx: TContext,
  ): TContext & { parsedBody?: unknown } => {
    if (isPlainObjectContext(ctx)) {
      return { ...ctx } as TContext & { parsedBody?: unknown };
    }

    if (ctx && typeof ctx === "object") {
      let parsedBody: unknown;
      let hasParsedBody = false;
      const target = ctx as Record<PropertyKey, unknown>;
      return new Proxy(target, {
        get(currentTarget, prop) {
          if (prop === "parsedBody") {
            if (hasParsedBody) {
              return parsedBody;
            }
            return Reflect.get(currentTarget, prop, currentTarget);
          }
          const value = Reflect.get(currentTarget, prop, currentTarget);
          return typeof value === "function" ? value.bind(currentTarget) : value;
        },
        set(currentTarget, prop, value) {
          if (prop === "parsedBody") {
            hasParsedBody = true;
            parsedBody = value;
            return true;
          }
          return Reflect.set(currentTarget, prop, value, currentTarget);
        },
        has(currentTarget, prop) {
          if (prop === "parsedBody") {
            return hasParsedBody || Reflect.has(currentTarget, prop);
          }
          return Reflect.has(currentTarget, prop);
        },
        ownKeys(currentTarget) {
          const keys = Reflect.ownKeys(currentTarget);
          if (hasParsedBody && !keys.includes("parsedBody")) {
            return [...keys, "parsedBody"];
          }
          return keys;
        },
        getOwnPropertyDescriptor(currentTarget, prop) {
          if (prop === "parsedBody") {
            if (!hasParsedBody) {
              return Reflect.getOwnPropertyDescriptor(currentTarget, prop);
            }
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: parsedBody,
            };
          }
          return Reflect.getOwnPropertyDescriptor(currentTarget, prop);
        },
      }) as TContext & { parsedBody?: unknown };
    }

    return { parsedBody: undefined } as TContext & { parsedBody?: unknown };
  };

  const routeResponseHooks = Array.isArray(config.routeHooks?.afterResponse)
    ? [...config.routeHooks.afterResponse]
    : config.routeHooks?.afterResponse
      ? [config.routeHooks.afterResponse]
      : [];

  const completeDatafnResponse = async (input: {
    action: DataFnAction;
    request: Request;
    context: TContext & { parsedBody?: unknown };
    payload: unknown;
    response: Response;
  }): Promise<Response> => {
    let response = input.response;
    for (const hook of routeResponseHooks) {
      response = await hook({
        action: input.action,
        request: input.request,
        context: input.context,
        payload: input.payload,
        response,
      });
    }
    const configuredHeaders = typeof config.routeHooks?.headers === "function"
      ? await config.routeHooks.headers({
          action: input.action,
          request: input.request,
          context: input.context,
          payload: input.payload,
          response,
        })
      : config.routeHooks?.headers;
    if (!configuredHeaders) {
      return response;
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of new Headers(configuredHeaders).entries()) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const authorizePlugins = async (
    input: DatafnPluginAuthorizationInput<TContext>,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        error: { code: "FORBIDDEN"; message: string; details: Record<string, unknown> };
      }
  > => {
    for (const plugin of plugins) {
      if (!plugin.runsOn.includes("server") || !plugin.authorize) {
        continue;
      }
      try {
        const authorized = await plugin.authorize(input);
        if (authorized === false) {
          return {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "Authorization denied",
              details: { path: "$", plugin: plugin.name },
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: normalizePluginAuthorizationError(error, plugin.name),
        };
      }
    }
    return { ok: true };
  };

  // LOW-001: withAuth returns a handler with signature compatible with Route<TContext>.handler
  const withAuth = (
    action: DataFnAction,
    handler: (
      req: Request,
      ctx: TContext & { parsedBody?: unknown },
    ) => Promise<Response> | Response,
    rest = false,
  ): ((req: Request, ctx: TContext) => Promise<Response>) => {
    return async (req: Request, ctx: TContext): Promise<Response> => {
      const enrichedCtx = createEnrichedContext(ctx);
      // Body parsing consumes the original Request. Preserve one clone so a
      // signed routing assertion can bind the exact forwarded body.
      const placementRequest = multiRegionRuntime?.placement ? req.clone() : undefined;
      let payload: unknown = null;
      // REL-009: Reject new requests immediately when shutting down
      if (shuttingDown) {
        return completeDatafnResponse({
          action,
          request: req,
          context: enrichedCtx,
          payload,
          response: new Response(
            JSON.stringify({ ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Server is shutting down" } }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
        });
      }

      // Track in-flight request for graceful shutdown drain
      inFlightCount++;
      try {
        // Rate limiting — applied BEFORE JSON parsing and authorization (RATE-001)
        if (rateLimitMiddleware) {
          const rateLimitResponse = await rateLimitMiddleware(action, enrichedCtx);
          if (rateLimitResponse) {
            await emitDataFnEvent({
              domain: "datafn",
              type: "datafn.rate_limited",
              severity: "warn",
              requestId: requestId(req),
              outcome: "blocked",
              metadata: dataFnRateLimitedMetadata(req, action),
            });
            return completeDatafnResponse({
              action,
              request: req,
              context: enrichedCtx,
              payload,
              response: rateLimitResponse,
            });
          }
        }

        // Enforce payload limits (LIMIT-001) — single inline check, no sentinel pattern
        if (limits.maxPayloadBytes) {
          const limitError = checkPayloadLimit(req, limits.maxPayloadBytes);
          if (limitError) {
            await emitDataFnEvent({
              domain: "datafn",
              type: "datafn.payload.rejected",
              severity: "warn",
              requestId: requestId(req),
              outcome: "rejected",
              metadata: dataFnPayloadRejectedMetadata(
                req,
                action,
                "payload-too-large",
                "LIMIT_EXCEEDED",
              ),
            });
            return completeDatafnResponse({
              action,
              request: req,
              context: enrichedCtx,
              payload,
              response: limitError,
            });
          }
        }

        // For POST/PUT/PATCH endpoints, parse JSON body FIRST before authorization
        // AUTH-001: Invalid JSON must return DFQL_INVALID, never FORBIDDEN
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          // If maxPayloadBytes is set but Content-Length was missing, enforce on actual body
          if (limits.maxPayloadBytes) {
            const bodyResult = await readBodyWithLimit(req, limits.maxPayloadBytes, logger);
            if (!bodyResult.ok) {
              return completeDatafnResponse({
                action,
                request: req,
                context: enrichedCtx,
                payload,
                response: bodyResult.response,
              });
            }
            // Parse JSON from the already-read body text
            try {
              payload = JSON.parse(bodyResult.body);
            } catch {
              await emitDataFnEvent({
                domain: "datafn",
                type: "datafn.payload.rejected",
                severity: "warn",
                requestId: requestId(req),
                outcome: "rejected",
                metadata: dataFnPayloadRejectedMetadata(
                  req,
                  action,
                  "invalid-json",
                  "DFQL_INVALID",
                ),
              });
              return completeDatafnResponse({
                action,
                request: req,
                context: enrichedCtx,
                payload,
                response: errorResponse({
                  code: "DFQL_INVALID",
                  message: "Invalid JSON",
                  details: { path: "$" },
                }, 400),
              });
            }
          } else {
            const parseResult = await parseJsonBody(req);
            if (!parseResult.ok) {
              await emitDataFnEvent({
                domain: "datafn",
                type: "datafn.payload.rejected",
                severity: "warn",
                requestId: requestId(req),
                outcome: "rejected",
                metadata: dataFnPayloadRejectedMetadata(
                  req,
                  action,
                  "invalid-json",
                  parseResult.error.code,
                ),
              });
              return completeDatafnResponse({
                action,
                request: req,
                context: enrichedCtx,
                payload,
                response: errorResponse(parseResult.error, 400),
              });
            }
            payload = parseResult.data;
          }

        // Store parsed body in context so handler doesn't need to re-parse
          enrichedCtx.parsedBody = payload;
        }

        // REST bodies are application records; their resource is owned by the
        // matched URL, not a coincidentally named field in the record.
        let structuralPayload = payload;
        if (rest) {
          let resource: string;
          try {
            const segment = sanitizePathSegment(new URL(req.url).pathname.split("/")[3] ?? "");
            if (!segment.ok) throw new Error("Invalid path segment");
            resource = segment.value;
          } catch {
            return completeDatafnResponse({
              action, request: req, context: enrichedCtx, payload,
              response: errorResponse({ code: "DFQL_INVALID", message: "Invalid path segment", details: { path: "resource" } }, 400),
            });
          }
          structuralPayload = { resource };
        }
        const parsedProtocol = parseDatafnRequest(action, structuralPayload, { schema: validatedSchema });
        if (!parsedProtocol.ok) {
          return completeDatafnResponse({
            action, request: req, context: enrichedCtx, payload,
            response: errorResponse(parsedProtocol.error, 400),
          });
        }
        const selection = collectStructuralResourceSelectors(parsedProtocol.result);
        if (selection.selectors.some((resource) => internalResourceNames.has(resource))) {
          await emitDataFnEvent({
            domain: "datafn",
            type: "datafn.authorization.denied",
            severity: "warn",
            requestId: requestId(req),
            outcome: "denied",
            metadata: dataFnAuthorizationDeniedMetadata(req, action, "internal-resource"),
          });
          return completeDatafnResponse({
            action,
            request: req,
            context: enrichedCtx,
            payload,
            response: errorResponse(
              { code: "FORBIDDEN", message: "Authorization denied", details: { path: "resource" } },
              403,
            ),
          });
        }

        if (multiRegionRuntime?.placement && action !== "status") {
          try {
            await validateDatafnPlacement({
              namespace: await extractNamespace(enrichedCtx),
              regionId: multiRegionRuntime.regionId,
              runtime: multiRegionRuntime.placement,
              request: placementRequest,
            });
          } catch (error) {
            if (error instanceof DatafnRoutingError) {
              return completeDatafnResponse({
                action,
                request: req,
                context: enrichedCtx,
                payload,
                response: error.toResponse(),
              });
            }
            throw error;
          }
        }

        const pluginAuthorization = await authorizePlugins({
          action,
          request: req,
          context: enrichedCtx,
          payload: structuralPayload,
        });
        if (!pluginAuthorization.ok) {
          await emitDataFnEvent({
            domain: "datafn",
            type: "datafn.authorization.denied",
            severity: "warn",
            requestId: requestId(req),
            outcome: "denied",
            metadata: dataFnAuthorizationDeniedMetadata(req, action, "plugin-authorize"),
          });
          return completeDatafnResponse({
            action,
            request: req,
            context: enrichedCtx,
            payload,
            response: errorResponse(pluginAuthorization.error, 403),
          });
        }

        // Check authorization if configured - only called AFTER successful JSON parse
        if (config.authorize) {
          const authorized = await config.authorize(enrichedCtx, action, structuralPayload);
          if (!authorized) {
            await emitDataFnEvent({
              domain: "datafn",
              type: "datafn.authorization.denied",
              severity: "warn",
              requestId: requestId(req),
              outcome: "denied",
              metadata: dataFnAuthorizationDeniedMetadata(req, action, "authorize-callback"),
            });
            return completeDatafnResponse({
              action,
              request: req,
              context: enrichedCtx,
              payload,
              response: errorResponse(
                { code: "FORBIDDEN", message: "Authorization denied", details: { path: "$" } },
                403,
              ),
            });
          }
        }

        return completeDatafnResponse({
          action,
          request: req,
          context: enrichedCtx,
          payload,
          response: await handler(req, enrichedCtx),
        });
      } catch (error) {
        await emitDataFnEvent({
          domain: "datafn",
          type: "datafn.request.failed",
          severity: "error",
          requestId: requestId(req),
          outcome: "error",
          metadata: dataFnRequestFailedMetadata(req, action, error),
        });
        throw error;
      } finally {
        inFlightCount--;
        // If shutdown is waiting and we were the last in-flight request, signal completion
        if (shuttingDown && inFlightCount === 0 && shutdownResolve) {
          const resolve = shutdownResolve;
          shutdownResolve = null;
          if (shutdownTimer) {
            clearTimeout(shutdownTimer);
            shutdownTimer = null;
          }
          resolve();
        }
      }
    };
  };

  const executeInProcess = async <TResult>(
    action: "query" | "mutation" | "transact" | "search",
    handler: (
      req: Request,
      ctx: TContext & { parsedBody?: unknown },
    ) => Promise<Response> | Response,
    payload: unknown,
    context?: TContext,
  ): Promise<TResult> => {
    let body: string;
    try {
      body = JSON.stringify(payload) ?? "null";
    } catch {
      throw new DatafnExecutorError({
        code: "DFQL_INVALID",
        message: "Payload must be JSON serializable",
        details: { path: "$" },
      });
    }

    const signal = action === "search" && payload && typeof payload === "object" &&
      (payload as { signal?: unknown }).signal instanceof AbortSignal
      ? (payload as { signal: AbortSignal }).signal
      : undefined;
    const request = new Request(`http://datafn.internal/datafn/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });
    let response: Response;
    try {
      const configuredContext = config.context;
      const executorContext = context ?? (
        typeof configuredContext === "function"
          ? await (configuredContext as (request: Request) => Promise<TContext> | TContext)(request)
          : configuredContext ?? ({} as TContext)
      );
      response = await withAuth(action, handler)(request, executorContext);
    } catch {
      throw new DatafnExecutorError(
        { code: "INTERNAL", message: "Internal Server Error" },
        500,
      );
    }
    let envelope: {
      ok: boolean;
      result?: TResult;
      error?: DatafnError;
    };
    try {
      envelope = await response.json() as typeof envelope;
    } catch {
      throw new DatafnExecutorError(
        { code: "INTERNAL", message: "DataFn execution returned an invalid response" },
        response.status,
      );
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new DatafnExecutorError(
        { code: "INTERNAL", message: "DataFn execution returned an invalid response" },
        response.status,
      );
    }
    if (!envelope.ok || !Object.prototype.hasOwnProperty.call(envelope, "result")) {
      throw new DatafnExecutorError(
        envelope.error ?? { code: "INTERNAL", message: "DataFn execution failed" },
        response.status,
      );
    }
    return envelope.result as TResult;
  };

  const executor: DatafnExecutor<TContext> = {
    schema: validatedSchema,
    query: (payload, context) => executeInProcess("query", queryHandler, payload, context),
    mutate: (payload, context) => executeInProcess("mutation", mutationHandler, payload, context),
    transact: (payload, context) => executeInProcess("transact", transactHandler, payload, context),
    search: (payload, context) => executeInProcess("search", searchHandler, payload, context),
  };

  const withPluginRoutePlacement = (
    route: DatafnComposableRoute<TContext>,
    placement: DatafnPluginRoutePlacement<TContext>,
  ): DatafnComposableRoute<TContext> => {
    const {
      handler: originalHandler,
      middleware: originalMiddleware,
      ...routeDefinition
    } = route;
    return {
      ...routeDefinition,
      handler: async (request, context) => {
        let prepared: PreparedDatafnRoutingRequest;
        try {
          prepared = await prepareDatafnRoutingRequest(
            request,
            multiRegionRuntime!.placement!.maxBodyBytes,
          );
        } catch (error) {
          if (error instanceof DatafnRoutingError) return error.toResponse();
          throw error;
        }
        const assertionRequest = prepared.createRequest();
        const placementRequest = prepared.createRequest();
        const handlerRequest = prepared.createRequest();
        const resolution = await placement.resolveNamespace(placementRequest, context);
        if (resolution instanceof Response) return resolution;
        try {
          await validateDatafnPlacement({
            namespace: resolution,
            regionId: multiRegionRuntime!.regionId,
            runtime: multiRegionRuntime!.placement!,
            request: assertionRequest,
          });
        } catch (error) {
          if (error instanceof DatafnRoutingError) return error.toResponse();
          throw error;
        }
        await placement.bindHandlerRequest?.(placementRequest, handlerRequest, context);
        return executeMiddlewareChain(
          originalMiddleware ?? [],
          handlerRequest,
          context,
          async () => originalHandler(handlerRequest, context),
        );
      },
    };
  };

  // Define routes
  const routes: Route<TContext>[] = [
    {
      method: "GET",
      path: "/datafn/status",
      handler: withAuth("status", statusHandler),
    },
    {
      method: "POST",
      path: "/datafn/query",
      handler: withAuth("query", queryHandler),
    },
    {
      method: "POST",
      path: "/datafn/mutation",
      handler: withAuth("mutation", mutationHandler),
    },
    {
      method: "POST",
      path: "/datafn/transact",
      handler: withAuth("transact", transactHandler),
    },
    {
      method: "POST",
      path: "/datafn/clone",
      handler: withAuth("clone", cloneHandler),
    },
    {
      method: "POST",
      path: "/datafn/pull",
      handler: withAuth("pull", pullHandler),
    },
    {
      method: "POST",
      path: "/datafn/push",
      handler: withAuth("push", pushHandler),
    },
    {
      method: "POST",
      path: "/datafn/reconcile",
      handler: withAuth("reconcile", reconcileHandler),
    },
    {
      method: "POST",
      path: "/datafn/seed",
      handler: withAuth("seed", seedHandler),
    },
    {
      method: "POST",
      path: "/datafn/search",
      handler: withAuth("search", searchHandler),
    },
  ];

  if (configuredDatabase) {
    for (const plugin of plugins) {
      if (!plugin.routes) {
        continue;
      }
      const pluginRoutes = plugin.routes({
        database: db ?? configuredDatabase,
        crossNamespaceDatabase: crossNamespaceDb,
        schema: validatedSchema,
      }) as DatafnComposableRoute<TContext>[];
      for (const route of pluginRoutes) {
        if (!multiRegionRuntime?.placement || route.meta?.datafnPlacement === "none") {
          routes.push(route);
          continue;
        }
        const declaration = route.meta?.datafnPlacement;
        if (!declaration) {
          throw new Error(
            `DATAFN_PLUGIN_ROUTE_PLACEMENT_REQUIRED: ${plugin.name} ${route.method} ${route.path}`,
          );
        }
        routes.push(withPluginRoutePlacement(route, declaration));
      }
    }
  }

  // Register REST routes if config.rest is true
  if (config.rest) {
    // FIX-SRV-001: Direct internal execution helpers — no synthetic Request construction.
    // Handlers use ctx.parsedBody exclusively; the Request parameter is never read in this path.
    const internalMutate = async (
      m: unknown,
      ctx?: TContext & { parsedBody?: unknown },
    ): Promise<unknown> => {
      const res = await mutationHandler(undefined as any, {
        ...(ctx ?? {} as TContext),
        parsedBody: m,
      });
      const env = await res.json() as { ok: boolean; error?: unknown; result?: unknown };
      if (!env.ok) throw env.error;
      return env.result;
    };
    const internalQuery = async (
      q: unknown,
      ctx?: TContext & { parsedBody?: unknown },
    ): Promise<unknown> => {
      const res = await queryHandler(undefined as any, {
        ...(ctx ?? {} as TContext),
        parsedBody: q,
      });
      const env = await res.json() as { ok: boolean; error?: unknown; result?: unknown };
      if (!env.ok) throw env.error;
      return env.result;
    };

    const restRoutes = createRestRoutes(
      validatedSchema,
      internalMutate,
      internalQuery,
      logger,
    );

    // Map REST routes to router format and apply auth if needed
    // REST wrappers are just alternative interfaces to mutation/query, so we check "mutation"/"query" action?
    // Or introduce "rest" action.
    // For granularity, let's map: GET -> "query", POST/PATCH/DELETE -> "mutation".
    for (const route of restRoutes) {
      const action: DataFnAction = route.method === "GET" ? "query" : "mutation";
      routes.push({
        method: route.method,
        path: route.path,
        meta: route.meta,
        // withAuth and the REST handler validate URL segments and complete DataFn response hooks.
        decodeParams: false,
        handler: withAuth(action, route.handler as any, true),
      });
    }
  }

  // Create router
  const router = createRouter<TContext>({
    routes,
    basePath: "/",
    context: config.context,
    middleware: observabilityScope
      ? [
          createObservabilityMiddleware({
            observability: observabilityScope,
            serverTiming: true,
            headers: { prefix: "x-datafn" },
          }),
        ]
      : undefined,
  });

  // REL-009: Graceful shutdown implementation
  const serverClose = async (): Promise<void> => {
    // Idempotent guard — safe to call from both direct close() and signal handlers
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("SIGTERM", sigHandler);
    process.off("SIGINT", sigHandler);

    // Send WS close 1001 (Going Away) to all connected clients
    wsManager.close();

    // Drain in-flight requests (up to shutdownTimeoutMs)
    if (inFlightCount > 0) {
      const timeoutMs = config.shutdownTimeoutMs ?? 10_000;
      await new Promise<void>((resolve) => {
        shutdownResolve = resolve;
        shutdownTimer = setTimeout(() => {
          // Timeout reached — force-resolve even if requests are still in-flight
          if (shutdownResolve === resolve) {
            shutdownResolve = null;
            shutdownTimer = null;
            resolve();
          }
        }, timeoutMs);
        shutdownTimer.unref?.();
      });
    }

    // Dispose search provider
    if (config.searchProvider?.dispose) {
      try {
        await config.searchProvider.dispose();
      } catch (error) {
        logger.error("Search provider dispose failed", { error: String(error), operation: "search-dispose" });
      }
    }

    // Clean up timers
    if (pruneInterval) {
      clearInterval(pruneInterval);
      pruneInterval = null;
    }
    if (permissionDirectoryRetryInterval) {
      clearInterval(permissionDirectoryRetryInterval);
      permissionDirectoryRetryInterval = null;
    }
    if (memoryRateLimiter) {
      memoryRateLimiter.destroy();
      memoryRateLimiter = null;
    }
  };

  // REL-009: Register signal handlers for automatic graceful shutdown
  // process.once ensures each fires at most once; shuttingDown guard prevents double-execution
  const sigHandler = () => serverClose().catch((e) => logger.error("Graceful shutdown error", { error: String(e), operation: "shutdown" }));
  process.on("SIGTERM", sigHandler);
  process.on("SIGINT", sigHandler);

  const serverSearch = async (
    params: import("./execution/search/cross-resource.js").CrossResourceSearchParams & {
      namespace?: string;
    },
    _ctx?: TContext,
  ): Promise<import("./execution/search/cross-resource.js").SearchResult> => {
    if (!db) {
      throw new Error("Database is not configured");
    }
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (query === "") {
      throw new DatafnExecutionError(
        "DFQL_INVALID",
        "Search query must not be empty",
        "query",
      );
    }
    if (query.length > 1000) {
      throw new DatafnExecutionError(
        "LIMIT_EXCEEDED",
        "Search query exceeds maximum length",
        "query",
      );
    }
    const limit = Math.min(params.limit ?? 50, 10_000);
    const limitPerResource = Math.min(params.limitPerResource ?? limit, 1_000);
    const namespace =
      params.namespace && params.namespace.trim() !== ""
        ? params.namespace
        : await extractNamespace(_ctx as TContext);
    if (multiRegionRuntime?.placement) {
      await validateDatafnPlacement({
        namespace,
        regionId: multiRegionRuntime.regionId,
        runtime: multiRegionRuntime.placement,
        trustedInternal: true,
      });
    }
    const actorId = await extractActorId(_ctx as TContext);

    const searchParams = {
      ...params,
      query,
      limit,
      limitPerResource,
      actorId,
    };

    if (config.searchProvider) {
      return executeCrossResourceSearch(
        searchParams,
        config.searchProvider,
        db,
        validatedSchema,
        namespace,
        logger,
        multiRegionRuntime,
      );
    }
    if (!hasDbNativeSearchSupport(db)) {
      throw new DatafnExecutionError(
        "DFQL_UNSUPPORTED",
        NO_PROVIDER_NATIVE_UNSUPPORTED_MESSAGE,
      );
    }
    return executeDbNativeCrossResourceSearch(
      searchParams,
      db,
      validatedSchema,
      namespace,
      logger,
    );
  };

  // Start recurring work only after every fallible construction step has
  // completed and the close path is available to own the timer.
  if (db && permissionDirectoryRetryRuntimes.length > 0) {
    permissionDirectoryRetryInterval = setInterval(() => {
      for (const runtime of permissionDirectoryRetryRuntimes) {
        void drainPermissionDirectoryOutbox(db!, runtime, logger).catch((error) => {
          logger.warn("Permission directory retry drain failed", {
            error: String(error),
            operation: "permission-directory-outbox",
            regionId: runtime.regionId,
          });
        });
      }
    }, 60_000);
    permissionDirectoryRetryInterval.unref?.();
  }

  return {
    router,
    schema: validatedSchema,
    executor,
    search: serverSearch,
    websocketHandler: {
      addClient: (client, authContext) => {
        if (multiRegionRuntime?.placement) {
          try {
            client.close?.(
              4409,
              "Placement validation required; use addRoutedClient",
            );
          } catch {
          }
          return false;
        }
        return wsManager.addClient(client, authContext);
      },
      addRoutedClient: async (client, authContext, handshakeRequest) => {
        if (!multiRegionRuntime?.placement) {
          return wsManager.addClient(client, authContext);
        }
        if (typeof client.close !== "function") {
          return false;
        }
        const fenceGeneration = wsManager.getNamespaceFenceGeneration(
          authContext.namespace,
        );
        let added = false;
        try {
          const validated = await validateDatafnPlacement({
            namespace: authContext.namespace,
            regionId: multiRegionRuntime.regionId,
            runtime: multiRegionRuntime.placement,
            request: handshakeRequest,
            trustedInternal:
              !handshakeRequest && !multiRegionRuntime.placement.requireRoutingAssertion,
          });
          added = wsManager.addClient(client, {
            ...authContext,
            regionId: validated.placement.regionId,
            routingEpoch: validated.placement.epoch,
          });
          if (!added) return false;
          if (
            wsManager.getNamespaceFenceGeneration(authContext.namespace) !==
              fenceGeneration
          ) {
            wsManager.removeClient(client);
            try {
              client.close(
                4510,
                "DATAFN_REGION_MISMATCH: reconnect through canonical gateway",
              );
            } catch {
            }
            return false;
          }
          return true;
        } catch (error) {
          if (added) wsManager.removeClient(client);
          try {
            client.close(
              error instanceof DatafnRoutingError ? 4510 : 1011,
              error instanceof Error ? error.message : "Placement validation failed",
            );
          } catch {
          }
          return false;
        }
      },
      fenceNamespace: (namespace, minimumEpoch) =>
        wsManager.fenceNamespace(namespace, minimumEpoch),
      removeClient: (client) => wsManager.removeClient(client),
      handleMessage: (client, data) => wsManager.handleMessage(client, data),
      handlePong: (client) => wsManager.handlePong(client),
    },
    close: serverClose,
  };
}

function readTimingConfig(
  observability: ObservabilityConfig | undefined,
): { timing?: boolean; onTiming?: import("./middleware/timing.js").TimingEmitter } | undefined {
  if (!observability || typeof observability !== "object") {
    return undefined;
  }
  return {
    timing: "timing" in observability ? observability.timing : undefined,
    onTiming: "onTiming" in observability ? observability.onTiming : undefined,
  };
}

function requestId(request: Request): string | undefined {
  return request.headers.get("x-request-id") ?? undefined;
}

function baseRequestEventMetadata(
  request: Request,
  action: DataFnAction,
): DataFnRequestEventMetadata {
  return {
    action,
    path: new URL(request.url).pathname,
    method: request.method,
  };
}

function dataFnRateLimitedMetadata(
  request: Request,
  action: DataFnAction,
): DataFnRateLimitedMetadata {
  return {
    ...baseRequestEventMetadata(request, action),
    reason: "rate-limit",
  };
}

function dataFnPayloadRejectedMetadata(
  request: Request,
  action: DataFnAction,
  reason: DataFnPayloadRejectedMetadata["reason"],
  code: string,
): DataFnPayloadRejectedMetadata {
  return {
    ...baseRequestEventMetadata(request, action),
    reason,
    code,
  };
}

function dataFnAuthorizationDeniedMetadata(
  request: Request,
  action: DataFnAction,
  reason: DataFnAuthorizationDeniedMetadata["reason"],
): DataFnAuthorizationDeniedMetadata {
  return {
    ...baseRequestEventMetadata(request, action),
    reason,
  };
}

function dataFnRequestFailedMetadata(
  request: Request,
  action: DataFnAction,
  error: unknown,
): DataFnRequestFailedMetadata {
  return {
    ...baseRequestEventMetadata(request, action),
    error: String(error),
  };
}

function datafnLoggerFromObservability(
  logger: ObservationLogger | undefined,
  fallback: DatafnLogger,
): DatafnLogger {
  return {
    info: (message, context) => logger?.info ? logger.info(message, context) : fallback.info(message, context),
    warn: (message, context) => logger?.warn ? logger.warn(message, context) : fallback.warn(message, context),
    error: (message, context) => logger?.error ? logger.error(message, context) : fallback.error(message, context),
    debug: (message, context) => logger?.debug ? logger.debug(message, context) : fallback.debug(message, context),
  };
}
