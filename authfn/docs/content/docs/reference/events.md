---
title: Observability events
description: Every AuthFnEventType the kernel emits — when it fires and what's in its metadata.
---

# Observability events

Every interesting thing the kernel does emits an event through your `observability.emit` callback. Events have a stable shape:

```ts
type AuthFnEvent = {
  type: AuthFnEventType;
  requestId: string;
  actorId?: string;
  userId?: string;
  sessionId?: string;
  regionId?: string;
  provider?: 'google' | 'apple' | 'github';
  pluginName?: string;
  hookName?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
};
```

## Catalog

| Event | When | Outcome | Useful metadata |
| --- | --- | --- | --- |
| `authfn.user.created` | A new user row was inserted. | success | `primaryEmail`, `via` (`'password'`, `'oauth-google'`, …) |
| `authfn.account_linked` | Account-linking added a credential / oauth identity to an existing user. | success | `linkedKind`, `existingUserId`, `via` |
| `authfn.account_linking.conflict` | The kernel refused to link two records and returned `AUTHFN_CONFLICT`. | failure | `existingUserId`, `attemptedVia` |
| `authfn.account.deleted` | A user was cascade-deleted (self or admin). | success | `userId`, `actorId`, `counts.{table}` |
| `authfn.password.signup.rollback_failed` | After a password sign-up cascade failed and the rollback also failed. Operator alarm. | failure | `userId`, `tableErrors` |
| `authfn.session.issued` | A new session was created. | success | `methods`, `regionId` |
| `authfn.session.revoked` | A session was revoked (sign-out, manual revoke, expiry sweep). | success | `cause` |
| `authfn.otp.sent` | An OTP was sent. | success / failure | `purpose`, `provider` |
| `authfn.otp.verified` | An OTP was verified. | success / failure | `purpose`, `errorCode` |
| `authfn.otp.signup.rollback_failed` | Same as `password.signup.rollback_failed` but for OTP-driven sign-ups. | failure | `userId`, `tableErrors` |
| `authfn.oauth.started` | OAuth `start` issued a state and redirected. | success | `provider`, `intent` |
| `authfn.oauth.completed` | OAuth callback completed and a session was issued. | success | `provider` |
| `authfn.oauth.failed` | OAuth callback didn't complete. | failure | `provider`, `errorCode` |
| `authfn.api_key.created` | An API key was issued. | success | `apiKeyId`, `scopes` |
| `authfn.api_key.revoked` | An API key was revoked. | success | `apiKeyId`, `cause` |
| `authfn.2fa.enabled` | 2FA was enrolled and confirmed. | success | `userId` |
| `authfn.2fa.challenged` | A 2FA challenge was completed (or failed). | success / failure | `errorCode` |
| `authfn.region.lookup` | A region lookup was performed. | success | `regionId`, `cacheHit` |
| `authfn.region.lookup.conflict` | Two regions raced to claim the same identifier. | failure | `loserRegionId` |
| `authfn.routing.placement_lookup` | Gateway/cell placement was read or an identity-scoped request was rejected before execution. | validated / rejected | `regionId`, `epoch`, `errorType` |
| `authfn.routing.placement_claimed` | A first-use identity placement was atomically claimed. | success | `regionId`, `epoch` |
| `authfn.routing.forwarded` | The gateway dispatched to the selected private cell. | success | `regionId`, `epoch`, `family`, `attempt` |
| `authfn.routing.mismatch` | A cell proved a stale region/epoch before execution. | pre-execution | `receivedRegionId`, `receivedEpoch`, `expectedRegionId`, `expectedEpoch`, `executionStarted` |
| `authfn.routing.retry` | The gateway refreshed placement and began its one allowed retry. | started | `regionId`, `epoch`, `attempt` |
| `authfn.routing.assertion_rejected` | A cell rejected a missing, expired, replayed, or request-mismatched assertion. | rejected | `errorType` |
| `authfn.routing.directory_unavailable` | Placement storage failed closed. | rejected | `errorType` |
| `authfn.routing.cell_unavailable` | Cell resolution or internal dispatch failed. | rejected / unknown | `regionId`, `epoch`, `errorType` |
| `authfn.placement_context.issued` | Trusted consumer code derived placement-bound auth context. | success | `epoch`, `audience`, `actorType`, hashed `subjectDigest` |
| `authfn.placement_context.rejected` | Context derivation failed closed. | rejected | `errorType` |
| `authfn.placement_context.verified` | A private-service assertion verified. | success | `epoch`, `audience`, hashed `subjectDigest` |
| `authfn.placement_context.verification_failed` | Signed context failed signature, audience, issuer, or expiry checks. | rejected | `errorType`, `audience` |
| `authfn.handoff.started` | A handoff code was issued. | success | `kind` (`native` / `web`) |
| `authfn.handoff.exchanged` | A handoff code was exchanged for a session. | success | `kind` |
| `authfn.handoff.failed` | Handoff exchange failed. | failure | `kind`, `errorCode` |
| `authfn.rate_limited` | A rate limiter rejected a request. | failure | `route`, `key`, `retryAfter` |
| `authfn.request.failed` | A request failed with a non-domain error (e.g., AUTHFN_INTERNAL_ERROR). | failure | `route`, `errorCode` |
| `authfn.plugin.failed` | A plugin or config hook threw outside the domain envelope. Operator alarm. | failure | `pluginName`, `hookName`, `metadata.errorCode` |

## Wiring

Wire `observability.emit` once at construction:

```ts
createAuthFn({
  // ...
  observability: {
    emit(event) {
      logger.info({ ...event });
    },
  },
});
```

For OpenTelemetry: see [recipes → OpenTelemetry instrumentation](../recipes/observability-otel).

## Source of truth

The full type union is in `authfn/core/src/types.ts` (`AuthFnEventType`). Per-event metadata shapes are documented inline at each emission site.
