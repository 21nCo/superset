// Re-export server factory and types
export { datafn } from "./app.js";
export type { DatafnApp, DatafnAppConfig, DatafnAppServerConfig } from "./app.js";
export { createDatafnServer } from "./server.js";
export { DatafnExecutorError } from "./executor.js";
export type { DatafnExecutor, DatafnExecutorAction } from "./executor.js";
export type {
  DatafnRouteHeaderEntries,
  DatafnRouteHeaderInput,
  DatafnRouteHeaders,
  DatafnRouteHookInput,
  DatafnRouteHooks,
  DatafnRouteResponseHook,
  DatafnPluginAuthorizationInput,
  DatafnPluginAuthorizationResult,
  DatafnComposableRoute,
  DatafnPluginRoutePlacement,
  DatafnPluginRoutePlacementResult,
  DatafnServerConfig,
  DatafnServer,
} from "./server.js";
export type { RateLimitConfig } from "./core-types.js";
export type {
  DataFnAction,
  DataFnAuthorizationDeniedEvent,
  DataFnAuthorizationDeniedMetadata,
  DataFnEvent,
  DataFnEventMap,
  DataFnEventType,
  DataFnPayloadRejectedEvent,
  DataFnPayloadRejectedMetadata,
  DataFnRateLimitedEvent,
  DataFnRateLimitedMetadata,
  DataFnRequestEventMetadata,
  DataFnRequestFailedEvent,
  DataFnRequestFailedMetadata,
  DataFnRetentionPruneFailedEvent,
  DataFnRetentionPruneFailedMetadata,
  DataFnRetentionPrunedEvent,
  DataFnRetentionPrunedMetadata,
} from "./events.js";
export {
  createDatafnPublicLinksPlugin,
  withDatafnPublicLinksSchema,
  readDatafnPublicLinkToken,
  resolveDatafnPublicLink,
  DatafnPublicLinkInputError,
} from "./plugins/public-links.js";
export type {
  CreateDatafnPublicLinkInput,
  DatafnPublicLinkAuthorizationInput,
  DatafnPublicLinkGrant,
  DatafnPublicLinkPrincipal,
  DatafnPublicLinkRecord,
  DatafnPublicLinksPlugin,
  DatafnPublicLinksPluginConfig,
  DatafnPublicLinkShareLevel,
  DatafnPublicLinkShareScope,
} from "./plugins/public-links.js";
export {
  createDatafnMultiRegionPlugin,
  datafnMultiRegionPlugin,
} from "./plugins/multi-region.js";
export type {
  DatafnMultiRegionDirectory,
  DatafnMultiRegionPluginConfig,
  DatafnMultiRegionRuntimeConfig,
  DatafnPermissionDirectoryGrant,
  DatafnGatewayCellRegistry,
  DatafnGatewayDispatcher,
  DatafnGatewayRouter,
  DatafnGatewayRouterConfig,
  DatafnNamespaceMigrationContext,
  DatafnNamespaceMigrationHooks,
  DatafnNamespaceMigrationState,
  DatafnNamespacePlacement,
  DatafnPlacementDirectoryAdapter,
  DatafnPlacementRuntimeConfig,
  DatafnPlacementState,
  DatafnRoutingAssertionClaims,
  DatafnRoutingAssertionSigner,
  DatafnRoutingAssertionVerifier,
  DatafnRoutingReplayStore,
  DatafnRoutingEvent,
  DatafnRoutingEventType,
} from "./plugins/multi-region.js";
export {
  DATAFN_MULTI_REGION_CAPABILITY,
  DATAFN_ROUTING_ASSERTION_HEADER,
  DATAFN_ROUTING_INTERNAL_HEADERS,
  DatafnRoutingError,
  claimDatafnNamespacePlacement,
  createConditionalKvDatafnPlacementDirectory,
  createDatafnGatewayRouter,
  createDatafnHmacRoutingAssertions,
  createMemoryDatafnPlacementDirectory,
  createMemoryDatafnRoutingReplayStore,
  migrateDatafnNamespace,
  validateDatafnRoutingBodyLimit,
  validateDatafnPlacement,
  withDatafnRoutingAssertion,
} from "./plugins/multi-region.js";
export type {
  DatafnPlacementConstraint,
  DatafnPlacementConstraintContext,
  DatafnPlacementDecision,
  DatafnPlacementDecisionSource,
  DatafnPlacementLocation,
  DatafnPlacementRankingInput,
  DatafnPlacementRegionCandidate,
  DatafnPlacementSelectionInput,
} from "./placement-policy.js";
export {
  rankDatafnPlacementRegions,
  readDatafnCloudflarePlacementLocation,
  selectDatafnPlacementRegion,
} from "./placement-policy.js";

// Re-export SearchProvider for consumer use
export type { SearchProvider } from "./search-provider.js";

// Re-export status types
export type { StatusResult } from "./routes/status.js";

// Re-export cross-resource search types
export type { SearchResult, SearchResultItem, CrossResourceSearchParams } from "./execution/search/cross-resource.js";

// Re-export sequence store types for secondary database support
export type {
  SequenceStore,
  SequenceStorePolicy,
} from "./execution/sync/sequence-store.js";
export {
  createSequenceStore,
  AtomicSequenceStore,
  DatabaseSequenceStore,
  ChainedSequenceStore,
} from "./execution/sync/sequence-store.js";

// Re-export inherited-inactivity recompute (one-shot backfill for existing rows)
export {
  recomputeAncestorInactive,
  recomputeAncestorInactiveAll,
  ancestorInactiveResources,
} from "./execution/migration/ancestor-inactive.js";
export type {
  AncestorInactiveCursor,
  RecomputeAncestorInactiveOptions,
  RecomputeAncestorInactiveResult,
  RecomputeAncestorInactiveAllResult,
} from "./execution/migration/ancestor-inactive.js";
