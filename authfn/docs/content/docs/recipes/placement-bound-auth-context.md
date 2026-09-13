---
title: Placement-bound auth context
description: Trusted in-process and private-service AuthFn context for regional application data planes.
---

# Placement-bound auth context

Use this contract when a canonical application gateway has already authenticated an AuthFn session and needs a **non-spoofable, placement-bound routing context** for a downstream data plane such as DataFn. AuthFn authenticates and exposes trusted context. It does not mint DataFn tickets, select DataFn URLs, or return a regional AuthFn authority to the browser.

The API is **opt-in**. Public AuthFn routes, cookies, OAuth issuer behavior, and regional table ownership are unchanged. Enable it only in trusted server-side consumer code.

Issuance runs against the authoritative **regional** AuthFn database. Set `regionId` (`region_id` in Python) to the region owning that database; TypeScript may infer it from `routing.cell.regionId`. A gateway-only config cannot issue context from a local stale database copy. Use AUTH-1's trusted regional dispatch or a private regional exchange, then verify its signed context at the gateway. If placement moves to another region, the old issuer fails closed; retry authentication in the new owning region. The issuer does not automatically dispatch or copy auth tables.

## Trust boundary

| Actor | May see | Must not do |
| --- | --- | --- |
| Browser / native client | Canonical AuthFn authority, cookies, OAuth | Choose a region, carry placement epoch, or learn a regional AuthFn URL |
| Canonical AuthFn / application gateway | Verified session, placement directory, opaque subject | Treat client headers or body fields as region/epoch/subject authority |
| Nucleum (or another consumer) | Immutable context or a short-lived audience-bound assertion | Reconstruct routing from session email, request host, or private internals |
| Remote HMAC verifier | Dedicated placement-context keyring | Reuse gateway-routing keys, or treat verification as unprivileged |
| Regional DataFn cell | Consumer-minted ticket derived from this context | Trust a client-supplied region or an AuthFn internal routing assertion |

Derive subject, home region, and placement epoch **only after** AuthFn session validation succeeds. Strip every incoming `x-authfn-routing-*` header. Ignore client-supplied subject, region, epoch, issuer, and audience values.

## TypeScript

```ts
import {
  createAuthFnPlacementContextIssuer,
  createAuthFnPlacementContextVerifier,
  createInMemoryAuthFnPlacementDirectory,
} from '@authfn/multi-region';

const issuer = createAuthFnPlacementContextIssuer({
  regionId: 'us-east-1', // region owning config.database
  config: runtimeConfig,
  publicAuthority: 'https://account.example.com',
  placementDirectory,
  identityKeyForUserId: identityKeys.fromUserId,
  subjectSecret: await secrets.resolve('authfn-placement-subject'),
  audiences: ['nucleum-datafn'],
  keyring, // optional; required only for the signed private-service form
  ttlSeconds: 60,
});

// In-process Nucleum gateway: immutable context after a valid session.
const context = await issuer.derive(request);
const ticket = await datafnTickets.mint({
  subject: context.subject,
  regionId: context.homeRegion,
  epoch: context.placementEpoch,
  audience: 'datafn-sync',
  expiresAt: context.expiresAt,
});

// Same value through a consumer callback.
await issuer.withContext(request, async (context) => {
  return datafnTickets.mint(context);
});

// Private remote consumer: audience-bound HMAC assertion, not a browser bearer token.
// Anyone with this keyring can also mint, so provision a dedicated keyring and treat
// every verifier as a trusted co-issuer. Do not reuse gateway-routing keys.
const { assertion } = await issuer.issueSigned(request);
const remote = createAuthFnPlacementContextVerifier({
  audiences: ['nucleum-datafn'],
  publicAuthority: 'https://account.example.com',
  keyring, // dedicated placement-context keys only
});
const verified = remote.verifySigned(assertion);
```

The context is frozen and contains:

| Claim | Meaning |
| --- | --- |
| `subject` | HMAC-derived opaque user subject. Stable for the same AuthFn user id and subject-secret bytes. |
| `homeRegion` | Authoritative placement region. |
| `placementEpoch` | Placement fence. Downstream grants should copy this. |
| `issuer` | Canonical AuthFn public authority. |
| `sessionBinding` | HMAC of the AuthFn session or API-key id. |
| `sessionVersion` | HMAC of the credential record `id` and `createdAt`. Stable across last-seen updates; changes when the session or API-key row is replaced. |
| `authenticatedAt` | Stored last-authentication time (`lastAuthenticatedAt` / `lastUsedAt`, else `createdAt`). Derivation does not refresh this claim. |
| `issuedAt` / `expiresAt` | Context lifetime. Capped by both `ttlSeconds` and session expiry. |
| `audience` | Consumer allowlist entry such as `nucleum-datafn`. |
| `assurance` | AuthFn methods on the session (`password`, `email-otp`, …). |
| `scopes` | Present for user-owned API keys. |
| `requestId` | Correlation id. |
| `actorType` | `user` or `api-key`. |
| `userId` | Omitted unless `includeUserId: true`. |

Raw email, phone, cookie material, signing secrets, and internal cell destinations are never included.

Gateway-mode servers can omit `placementDirectory`, `identityKeyForUserId`, and `publicAuthority` when those already exist on `authFnMultiRegionEnvironment({ routing })`. Direct regional-authority mode keeps working for AuthFn traffic; this issuer still requires an explicit placement directory so a client host cannot become placement authority.

## Python

```python
from authfn import create_placement_context_issuer, create_placement_context_verifier

issuer = create_placement_context_issuer(
    region_id="us-east-1",  # region owning config.database
    config=config,
    public_authority="https://account.example.com",
    placement_directory=directory,
    identity_key_for_user_id=identity_keys.from_user_id,
    subject_secret=subject_secret,
    audiences=["nucleum-datafn"],
    keyring=keyring,
)

context = await issuer.derive(request)
issued = await issuer.issue_signed(request)
remote = create_placement_context_verifier(
    audiences=["nucleum-datafn"],
    public_authority="https://account.example.com",
    keyring=keyring,
)
verified = remote.verify_signed(issued["assertion"])
```

## Opaque subject lifecycle

Provision the **same `subjectSecret` / `subject_secret` bytes in every regional issuer**
for one canonical authority, including a newly provisioned destination region.
For the same user id, moving placement or advancing its epoch must keep this secret
unchanged; the subject then remains stable. Different regional secrets identify the
same user differently and must not be used for a rolling regional deployment.

Treat the subject secret as identity infrastructure, separate from assertion signing
keys. Rotating the signing `keyring` does not change subjects. Rotating the subject
secret changes `subject`, `sessionBinding`, and `sessionVersion` for existing records.
There is no subject-key id, automatic aliasing, or dual-secret lookup in this API.
Before replacing it, use a trusted migration to compute old/new subjects from the
same internal user ids, migrate or alias downstream user-home/namespace mappings,
and coordinate the switch across all issuers and consumers. Never create replacement
product users solely because a newly derived subject is unknown. Retain any required
old aliases until all old context and downstream tickets have expired, then remove
the old mapping/key according to the consumer's migration plan. Emergency rotation
may intentionally invalidate sessions/tickets; it still requires identity migration.

Consumers should key persisted mappings by canonical issuer and opaque subject.
Authority normalization compatibility is covered by explicit TypeScript/Python
fixtures; it is not a claim of exhaustive parity for every Unicode hostname.

## Session revocation semantics

| Event | New grants | Already-issued context / signed assertion |
| --- | --- | --- |
| Logout, session revoke, API-key revoke | Fail closed (`AUTHFN_SESSION_REVOKED` / `AUTHFN_API_KEY_REVOKED`) | Remain verifiable until `expiresAt`. Bind DataFn tickets to `sessionVersion` and keep TTL short. |
| Session expiry | `AUTHFN_SESSION_EXPIRED` | Same bounded expiry. |
| Identity deleted / missing user row | `AUTHFN_UNAUTHENTICATED` | Existing grants expire; do not mint new tickets. |
| Placement `moving` or `deleting` | `AUTHFN_PLACEMENT_MOVING` | Downstream cells should fence on epoch. Re-bootstrap through the canonical gateway. |
| Tombstone / missing placement | `AUTHFN_REGION_NOT_FOUND` | Fail closed. |
| Directory unavailable | `AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE` | Fail closed. Do not guess a region. |
| Placement epoch advance | Old-region issuer rejects; reauthenticate in the current owning region before issuing | Old assertions still verify until TTL; DataFn must reject a stale epoch. |

There is no public AuthFn introspection route. Immediate revocation of downstream tickets is a consumer concern: short TTL, epoch fencing, or a private lookup the consumer owns.

## Nucleum integration

1. Keep browser/native traffic on the canonical AuthFn authority from [AUTH-1](https://linear.app/21n/issue/AUTH-1/support-canonical-gateway-routing-in-authfn-multi-region).
2. After the gateway validates the AuthFn session, call `derive` or `issueSigned` in trusted process or service-bound code.
3. Map `context.subject` to the product user-home / DataFn namespace. Do not use email.
4. Select the DataFn cell from **server-owned** configuration keyed by `homeRegion` + `placementEpoch`.
5. Mint the DataFn regional route ticket in Nucleum/DataFn. Return only that short-lived descriptor to the client.
6. On ticket expiry, mismatch, or WebSocket close, the client returns to the canonical bootstrap path.

AuthFn and DataFn placement records can drift. Nucleum should treat one product-level user-home authority as canonical and reject mismatched epochs rather than picking either copy.

## Observability

| Event | When |
| --- | --- |
| `authfn.placement_context.issued` | Context derived from a valid session and active placement. |
| `authfn.placement_context.rejected` | Unauthenticated, revoked, expired, moving, missing, or invalid audience. `metadata.errorType` is the AuthFn error code. |
| `authfn.placement_context.verified` | Signed assertion verified. |
| `authfn.placement_context.verification_failed` | Bad signature, audience, issuer, expiry, or key. |

Events hash the opaque subject. They must not contain email, tokens, or cell destinations.

## Related

- [Canonical-gateway multi-region](./canonical-gateway-multi-region)
- [Concepts → Regions](../core-concepts/regions)
- [Plugins → Multi-region](../plugins/multi-region)
