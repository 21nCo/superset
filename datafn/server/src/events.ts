import type { DatafnRequestAction } from '@datafn/core';
import type { ObservationEvent } from '@superfunctions/observability';

export type DataFnEventType =
  | 'datafn.authorization.denied'
  | 'datafn.payload.rejected'
  | 'datafn.rate_limited'
  | 'datafn.request.failed'
  | 'datafn.retention.pruned'
  | 'datafn.retention.prune_failed';

export type DataFnAction = DatafnRequestAction;

export interface DataFnRequestEventMetadata extends Record<string, unknown> {
  action?: DataFnAction;
  path?: string;
  method?: string;
}

export interface DataFnAuthorizationDeniedMetadata extends DataFnRequestEventMetadata {
  reason: 'internal-resource' | 'plugin-authorize' | 'authorize-callback';
}

export interface DataFnPayloadRejectedMetadata extends DataFnRequestEventMetadata {
  reason: 'payload-too-large' | 'invalid-json';
  code: string;
}

export interface DataFnRateLimitedMetadata extends DataFnRequestEventMetadata {
  reason: 'rate-limit';
}

export interface DataFnRequestFailedMetadata extends DataFnRequestEventMetadata {
  error: string;
}

export interface DataFnRetentionPrunedMetadata extends Record<string, unknown> {
  mode: 'startup' | 'periodic';
  target: 'changes' | 'idempotency';
  deleted: number;
}

export interface DataFnRetentionPruneFailedMetadata extends Record<string, unknown> {
  mode: 'startup' | 'periodic';
  error: string;
}

export type DataFnAuthorizationDeniedEvent = ObservationEvent<
  'datafn',
  'datafn.authorization.denied',
  DataFnAuthorizationDeniedMetadata
>;

export type DataFnPayloadRejectedEvent = ObservationEvent<
  'datafn',
  'datafn.payload.rejected',
  DataFnPayloadRejectedMetadata
>;

export type DataFnRateLimitedEvent = ObservationEvent<
  'datafn',
  'datafn.rate_limited',
  DataFnRateLimitedMetadata
>;

export type DataFnRequestFailedEvent = ObservationEvent<
  'datafn',
  'datafn.request.failed',
  DataFnRequestFailedMetadata
>;

export type DataFnRetentionPrunedEvent = ObservationEvent<
  'datafn',
  'datafn.retention.pruned',
  DataFnRetentionPrunedMetadata
>;

export type DataFnRetentionPruneFailedEvent = ObservationEvent<
  'datafn',
  'datafn.retention.prune_failed',
  DataFnRetentionPruneFailedMetadata
>;

export interface DataFnEventMap {
  'datafn.authorization.denied': DataFnAuthorizationDeniedEvent;
  'datafn.payload.rejected': DataFnPayloadRejectedEvent;
  'datafn.rate_limited': DataFnRateLimitedEvent;
  'datafn.request.failed': DataFnRequestFailedEvent;
  'datafn.retention.pruned': DataFnRetentionPrunedEvent;
  'datafn.retention.prune_failed': DataFnRetentionPruneFailedEvent;
}

export type DataFnEvent = DataFnEventMap[DataFnEventType];
