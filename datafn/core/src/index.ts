// Re-export types from types.ts
export type {
  DatafnSchema,
  DatafnResourceSchema,
  DatafnFieldSchema,
  DatafnRelationSchema,
  DatafnRelationIntegrityMode,
  DatafnRelationDeletePolicy,
  DatafnRelationDeletePolicies,
  DatafnDefaultPermissionsFieldMode,
  DatafnDefaultPermissionsPolicy,
  DatafnPermissionsPolicy,
  DatafnDefinedSchema,
  DatafnSchemaLiteral,
  RelationSimpleCapability,
  DatafnEvent,
  DatafnEventFilter,
  DatafnSignal,
  DatafnHookContext,
  DatafnPlugin,
  DatafnLogger,
  DatafnLimitsConfig,
  DatafnWsConfig,
} from "./types.js";

// Re-export defineSchema helper
export { defineSchema } from "./types.js";

// Re-export const-safe field builders
export { field } from "./field.js";
export type {
  DatafnArrayFieldOptions,
  DatafnBooleanFieldOptions,
  DatafnBuiltField,
  DatafnDateFieldOptions,
  DatafnFieldOptionsByType,
  DatafnFileFieldOptions,
  DatafnJsonFieldOptions,
  DatafnJsonValue,
  DatafnNumberFieldOptions,
  DatafnObjectFieldOptions,
  DatafnStringFieldOptions,
} from "./field.js";

// Re-export capability types and helpers
export type {
  SimpleCapability,
  AccessLevel,
  ShareableCapability,
  CapabilityEntry,
  SchemaCapabilities,
  ResourceCapabilities,
} from "./capabilities.js";
export {
  CAPABILITY_FIELD_DEFS,
  resolveCapabilities,
  getCapabilityFields,
  RELATION_CAPABILITY_FIELD_DEFS,
  getRelationCapabilityFieldNames,
} from "./capabilities.js";

// Re-export error types and helpers
export type { DatafnErrorCode, DatafnError, DatafnEnvelope } from "./errors.js";
export { DATAFN_ERROR_CODES, isDatafnErrorCode, ok, err } from "./errors.js";

// Re-export schema validation
export { validateSchema, isNamespaced, resolveRelationCapabilities } from "./schema.js";

// Re-export namespace helper
export { ns } from "./ns.js";

// Re-export DFQL normalization
export { normalizeDfql, dfqlKey } from "./normalize.js";

// Re-export envelope utilities
export { unwrapEnvelope } from "./envelope.js";

export * from "./dfql.js";

// Re-export KV utilities
export { ensureBuiltinKv, kvId, KV_RESOURCE_NAME } from "./kv.js";

export {
  DATAFN_E2EE_ENVELOPE_MARKER,
  isDatafnE2eeEnvelope,
  type DatafnE2eeCipherEnvelope,
} from "./e2ee.js";

export {
  createBuiltinPublicLinkResource,
  ensureBuiltinPublicLinks,
  PUBLIC_LINK_RESOURCE_NAME,
  type DatafnPublicLinkSchemaOptions,
} from "./public-links.js";

// Re-export join store utilities
export {
  getJoinStoreKey,
  getJoinTableName,
  getRelationJoinTableName,
  getRelationName,
  enumerateJoinStoreKeys,
} from "./joins.js";

export {
  type DatafnRelationEndpoint,
  type DatafnRelationDirection,
  type DatafnRelationMatch,
  endpointList,
  endpointIncludes,
  firstEndpoint,
  resourceNameFromId,
  resolveEndpointResource,
  relationMatchesForward,
  relationMatchesInverse,
  findRelationMatch,
  relationSourceEndpoint,
  relationTargetEndpoint,
  relationKeyFor,
} from "./relation-endpoints.js";

export {
  type DatafnRelationFkField,
  getRelationFkFieldsForResource,
  normalizeRelationFkRecord,
  relationFkFieldForManyOne,
  relationFkFieldForOneMany,
} from "./relation-fks.js";

// Re-export schema index utilities
export {
  type SchemaIndex,
  buildSchemaIndex,
  getResource,
  getField,
  getRelationsFrom,
  getRelation,
  getRelationTarget,
  findRelationBidirectional,
} from "./schema-index.js";

// Re-export filter evaluation + operator normalization
export {
  type FilterEvalOptions,
  evaluateFilter,
  OP_REMAP,
  normalizeFilterOps,
} from "./filters.js";

// Re-export relation payload normalization
export {
  type NormalizedRelation,
  normalizeRelationPayload,
} from "./relations.js";

// Re-export record read-path normalization
export { stripNullsForNonNullableFields } from "./records.js";

// Re-export aggregation utilities
export { calculateAggregation } from "./aggregate.js";

// Re-export temporal query utilities
export {
  type DatafnTemporalScale,
  type DatafnTemporalStorage,
  type DatafnTemporalRangeInput,
  type DatafnTemporalLocalTimeInput,
  type DatafnTemporalDateParts,
  type DatafnTemporalPeriodInput,
  type DatafnTemporalGroupInput,
  type DatafnTemporalBucketInput,
  type DatafnTemporalClause,
  type DatafnTemporalConfig,
  type DatafnTemporalTimezoneResolver,
  type DatafnResolvedTemporalGroup,
  type DatafnTimezoneChangeRecord,
  TIMEZONE_CHANGE_RESOURCE_NAME,
  TIMEZONE_CHANGE_ID_PREFIX,
  normalizeTemporalQuery,
  getTemporalClauses,
  hasTemporalGrouping,
  getTemporalGroups,
  getTemporalGroupAliases,
  resolveTemporalBucketValue,
  resolveTemporalBucketKey,
  resolveTemporalPeriodRange,
  startOfTemporalPeriod,
  addTemporalPeriod,
  resolveTemporalDateParts,
  resolveTemporalLocalTime,
  toTemporalStorageValue,
  resolveTemporalInputMs,
  createTimezoneResolver,
  timezoneChangeId,
  ensureBuiltinTemporal,
  createTemporalPlugin,
  time,
  temporal,
} from "./temporal.js";

// Re-export sort utilities
export {
  type SortInputTerm,
  type SortTerm,
  parseSortTerm,
  parseSortTerms,
  sortRecords,
} from "./sort.js";

// Re-export select token parsing
export { type SelectToken, parseSelectToken } from "./select.js";

// Re-export date conversion utilities
export {
  toEpochMs,
  fromEpochMs,
  coerceDateFieldsToEpoch,
  parseDateFieldsToDate,
  toBoundsEpochMs,
  formatBoundEpochMs,
} from "./date.js";

// Re-export validation primitives
export { checkPrototypePollution, validateFieldValue } from "./validate.js";

// Re-export plugin hook runner
export {
  type HookError,
  type BeforeHookResult,
  runBeforeHook,
  runAfterHook,
} from "./hooks.js";

// Re-export search provider interface
export type { SearchProvider } from "./search-provider.js";
