---
title: Canonical-gateway multi-region
description: One stable AuthFn authority, canonical identity placement, signed cell forwarding, migrations, and an operator runbook.
---

# Canonical-gateway multi-region

Use this mode when every browser, OAuth provider, native app, and API client must see one authority such as `https://account.example.com`, while identity state remains pinned to a regional cell.

## Trust boundaries

The gateway, placement directory, cell registry, dispatcher, and signing-key resolver are server-side infrastructure. Never accept an identity key, region, epoch, cell URL, or internal routing header as a trusted client hint.

The gateway:

1. Classifies the route and derives a stable identity key from trusted request material. Email/password and OTP flows may use a normalized, keyed email digest; session, refresh, revoke, API-key, OAuth-callback, handoff, deletion, and email-change flows should use a verified opaque routing handle.
2. Reads or atomically claims `{ identityKey, regionId, epoch, state }` in the placement directory.
3. Resolves the region through a private cell registry. The registry owns the destination handle; placement never contains a URL or service binding.
4. Removes every incoming `x-authfn-routing-*` header and creates a short-lived HMAC assertion bound to identity, region, epoch, request id, method, path and query, audience, nonce, and request-body digest.
5. Dispatches internally. A cell verifies the assertion, atomically claims its nonce, and rereads placement before rate limiting, authentication hooks, database reads/writes, OTP delivery, token issuance, or any other auth side effect.

The cell returns a signed mismatch only when it can prove `executionStarted: false`. The gateway refreshes placement and retries exactly once. Other failures, an unsigned mismatch, a second mismatch, or any response after execution began are returned without retry.

## TypeScript setup

```ts
import {
  authFnMultiRegionEnvironment,
  authFnMultiRegionPlugin,
  createAuthFnCanonicalGateway,
  createInMemoryAuthFnRoutingReplayStore,
} from '@authfn/multi-region';
import { authFnPlugins, authfn } from 'authfn';
import { createDynamoDbIdentityPlacementDirectory } from '@authfn/lookup-dynamodb';
import type { Adapter } from '@superfunctions/db';

const placementWriterRegion = process.env.AUTHFN_PLACEMENT_WRITER_REGION!;
const placementDirectory = createDynamoDbIdentityPlacementDirectory({
  tableName: process.env.AUTHFN_PLACEMENT_TABLE!,
  consistencyModel: 'single-writer-strong',
  writerRegion: placementWriterRegion,
  region: placementWriterRegion,
});

const keyring = {
  active: {
    keyId: process.env.AUTHFN_ROUTING_KEY_ID!,
    secret: await secrets.resolve(process.env.AUTHFN_ROUTING_KEY_ID!),
  },
  previous: await secrets.resolveVerificationKeys(),
};

// Configure this independently in each regional cell.
const environment = authFnMultiRegionEnvironment({
  regions,
  routing: {
    mode: 'gateway',
    publicAuthority: 'https://account.example.com',
    canonicalCookie: { prefix: 'authfn', domain: '.example.com', sameSite: 'lax' },
    canonicalOAuth: oauthConfig,
    placementDirectory,
    identityKeyForIdentifier: identityKeys.fromEmail,
    identityKeyForUserId: identityKeys.fromUserId,
    cell: {
      regionId: process.env.REGION_ID!,
      audience: `authfn-cell:${process.env.REGION_ID}`,
      keyring,
      replayStore: createInMemoryAuthFnRoutingReplayStore(), // use an atomic shared store per cell in production
    },
  },
});

export function createRegionalCell(database: Adapter) {
  return authfn({
    plugins: authFnPlugins(authFnMultiRegionPlugin()),
  }).createServer({ database, environment });
}

const gateway = createAuthFnCanonicalGateway({
  publicAuthority: 'https://account.example.com',
  basePath: '/auth',
  placementDirectory,
  keyring,
  resolveIdentity: resolveTrustedIdentity, // set allowInitialPlacement only for approved first-use routes
  selectInitialRegion: placementPolicy.select,
  resolveCell: cellRegistry.resolve, // { regionId, audience, target: opaqueBinding }
  dispatch: (target, request) => internalTransport.fetch(target, request),
  handleGlobal: globalAuthMetadata.handle,
});
```

The internal dispatcher must preserve cookies, CSRF headers, and the signed `x-request-id`. Normalize `Forwarded`, `X-Forwarded-For`, and equivalent client-IP headers at the canonical ingress according to one documented trusted-proxy policy; do not accept an arbitrary client-provided forwarding chain.

An AuthFn runtime configured for gateway mode without `routing.cell` is gateway-only: discovery and the non-enumerating lookup route may execute there, while every identity-scoped route fails closed. Regional runtimes add `routing.cell` and are reachable only through a valid signed assertion.

`createCloudflareIdentityPlacementDirectory` provides the same placement contract over a key-named Durable Object. The DynamoDB convenience adapter deliberately requires `consistencyModel: 'single-writer-strong'` and forces consistent reads: every cell and gateway must address the same writer region. Local DynamoDB Global Table replicas are eventually consistent with one another and do not, by themselves, provide globally atomic first claims or epoch moves. Global Tables may replicate the directory for recovery or shadow reads, but routing decisions must not use a local replica until a stronger coordinator establishes ownership. `createStoreBackedAuthFnPlacementDirectory` composes placement over another `ConditionalKVStoreAdapter` only when that adapter implements atomic `compareAndSet` across every writer.

Python exposes the equivalent `CanonicalGateway`, `CanonicalRoutingConfig`, `InMemoryIdentityPlacementDirectory`, `InMemoryRoutingReplayStore`, `RoutingKeyring`, `create_cell_routing_middleware`, and `move_identity_placement` contracts from `authfn.plugins.gateway_routing`.

After a request is authenticated at the canonical authority, trusted application code can derive placement-bound context for a downstream data plane. See [Placement-bound auth context](./placement-bound-auth-context). AuthFn still does not mint DataFn tickets or expose regional AuthFn URLs to clients.

## Route ownership matrix

| Route family | Gateway action | Identity source | Cell behavior |
| --- | --- | --- | --- |
| Discovery and `/regions/lookup` | Terminate globally with the canonical authority and no existence/region signal. | None | Not consulted. |
| Password and OTP start/verify/reset | Route. Atomically claim on first use if policy allows. | Normalized keyed identifier derived from the body. | Validate before lookup, challenge creation, delivery, verification, or session issue. |
| Session read/list/revoke/sign-out | Route. | Verified opaque session routing handle. | Validate before session reads, last-seen updates, or revocation. |
| API-key create/list/revoke/authenticate | Route. | Verified session handle or API-key routing prefix/MAC. | Validate before key lookup or mutation. |
| Social OAuth start, GET/POST callback, disconnect, and native Apple start/complete | Route. | Verified session, OAuth state, or native handshake routing handle. | Keep issuer and callback canonical; validate before state consumption or identity mutation. |
| Native/web handoff | Route. | Signed handoff routing handle. | Validate before code creation or exchange. |
| Account deletion and email change | Route. | Verified session handle for self-service; `identityKeyForUserId` for an administrator's target, independent of whether the admin authorizer supplies an `actorId`. | Validate routing before mutation. Account deletion CAS-fences `active` to durable `deleting` before the cascade, restores `active` if the cascade fails, and publishes `tombstoned` only after success. A second deletion attempt is rejected while that fence exists, preventing concurrent cascades from restoring or finalizing each other's state. After inspecting the cascade outcome, an operator may repair a stranded fence with `restoreAuthFnIdentityDeletion` or `finalizeAuthFnIdentityDeletion`; email-change flows must update placement with an application-level transaction/outbox protocol. |

Do not fall back to a default cell for an established identity whose placement is absent. Initial placement is only for explicitly classified first-use flows. Public lookup responses must be identical for present and absent identities.

## Migration and backfill

Backfill existing users by deriving the same stable identity key used at the gateway and calling `putIfAbsent` with the authoritative current region at epoch 1. Treat a conflicting existing record as an incident; never overwrite it with an unconditional write.

`moveAuthFnIdentityPlacement` performs the minimum fenced sequence:

1. CAS `active(source, epoch N)` to `moving(source → target, N+1)`.
2. Quiesce source writes and drain in-flight auth/delivery work.
3. Copy identity state and dependent credentials/tokens, validate it, and warm the target.
4. Resume target capacity and complete readiness checks while public identity traffic remains fenced by `moving`, then CAS to `active(target, N+2)`. Publishing `active` before the target is fully ready would expose an unroutable owner.
5. Before activation, failures leave placement fenced as `moving` unless a source recovery callback is supplied. With source recovery, resume the source first and only then CAS to `active(source, N+2)`; a failed source resume must never publish an active source. After target activation, ownership remains at the target.

Invalidate gateway placement caches after every claim, move, tombstone, and operator repair. Old assertions are rejected by epoch even when their TTL has not elapsed.

## Availability and fallback

- Placement directory unavailable: fail closed with `AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE`; do not guess a region.
- Placement `moving`: return `AUTHFN_PLACEMENT_MOVING`; do not start auth side effects.
- Placement `deleting`: return `AUTHFN_PLACEMENT_MOVING`; the durable deletion fence must be finalized or restored before identity traffic resumes.
- Missing/tombstoned established placement: fail closed. Do not enumerate the identity through the public lookup route.
- Cell missing or internal dispatch failure: `AUTHFN_ROUTING_CELL_UNAVAILABLE`.
- Gateway outage: restore the canonical gateway. Do not expose regional authorities as an automatic fallback because that changes issuer, callback, cookie, and topology contracts.
- Direct mode remains a separately configured compatibility mode for existing regional clients.

## Key rotation and secret handling

Keep routing keys in a KMS/HSM-backed secret resolver. Never place raw keys, assertions, identity keys, OTPs, cookies, authorization codes, or token bodies in logs. Rotation is add → sign → retire:

1. Add the new key to every cell's verification keyring.
2. Switch the gateway's `active.keyId` and signer.
3. Wait longer than assertion TTL plus clock skew and deployment propagation.
4. Remove the retired verification key.

Every cell uses an atomic replay store. The in-memory implementation is for tests or a single process; multi-instance cells need shared nonce claims with TTL.

## SLOs, dashboards, and drills

Track placement lookup latency/availability, claim/CAS conflicts, cache hit rate, dispatch latency by cell, signed mismatch rate, retry success/exhaustion, assertion rejection reason, replay rejection, moving duration, and cell-unavailable errors. Suggested starting objectives are 99.99% directory availability, p99 placement lookup under 50 ms, and fewer than 0.1% routed requests requiring the stale-placement retry; tune these to your infrastructure.

Run these drills before rollout and quarterly afterward:

- deny directory reads and confirm no regional handler or delivery provider runs;
- remove a cell binding and confirm the error contains no internal target;
- replay and body-modify a captured assertion and confirm rejection;
- move an identity during OTP, session refresh, OAuth callback, and handoff flows;
- fail each migration callback before activation and verify placement stays fenced unless source recovery succeeds;
- fail target resume and source resume independently, and verify neither region is published active before it is ready;
- rotate the signing key with mixed-version gateway/cell deployments;
- verify discovery issuer, OAuth redirect URI, cookie names/domain, browser origins, and native return paths remain canonical before and after a move.

## Rollout

Start with shadow placement reads and mismatch metrics, backfill deterministically, enable signed validation in cells, then send a small canonical-gateway cohort. Increase traffic only after retry exhaustion, assertion rejection, public topology leakage, and issuer/cookie/callback invariants are clean. Roll back gateway traffic routing without deleting placement or disabling cell validation; a later retry can resume from the same epochs.
