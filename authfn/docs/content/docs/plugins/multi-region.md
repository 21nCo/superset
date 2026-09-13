---
title: Multi-region plugin
description: Region pinning, lookup, runtime overlays, and wrong-authority redirects.
---

# Multi-region plugin

`authFnMultiRegionPlugin` is the operational backbone of authfn's data-residency story. Read [Concepts → Regions](../core-concepts/regions) first for the mental model — this page is the reference.

```ts
import {
  authFnMultiRegionEnvironment,
  authFnMultiRegionPlugin,
} from '@authfn/multi-region';

const plugin = authFnMultiRegionPlugin();
const environment = authFnMultiRegionEnvironment({
  defaultRegionId: 'us-east-1',
  regions: [
    { regionId: 'us-east-1', authority: 'https://api.us.example.com', cookie: { domain: '.us.example.com' } },
    { regionId: 'eu-west-1', authority: 'https://api.eu.example.com', cookie: { domain: '.eu.example.com' } },
  ],
  lookupStore,
});
```

Add `plugin` to the AuthFn plugin list and pass `environment` to
`createServer`. Routing and store settings are request-runtime configuration;
they are intentionally separate from the plugin's schema contribution.

## Configuration

```ts
interface MultiRegionPluginRuntimeConfig {
  regions?: AuthFnMultiRegionRegionConfig[];
  defaultRegionId?: string;
  lookupStore?: ConditionalKVStoreAdapter;
  routing?: AuthFnCanonicalRoutingConfig;
  observability?: ObservabilityInput<AuthFnEvent>;
}

interface AuthFnMultiRegionRegionConfig {
  regionId: string;
  authority: string;                               // e.g. https://api.us.example.com
  domain?: string;
  hosts?: string[];                                // additional hostnames that map to this region
  issuer?: string;                                 // overrides authority for OIDC issuer
  baseUrl?: string;                                // overrides authority for redirect/url construction
  cookie?: Partial<AuthFnCookieConfig>;
  oauth?: AuthFnRuntimeResolution['oauth'];
}
```

| Option | Notes |
| --- | --- |
| `defaultRegionId` | Fallback region for requests that don't match by host. |
| `regions` | Array of region configs. Order is irrelevant. |
| `lookupStore` | Recommended when regional databases do not replicate region profiles globally. |
| `routing` | Selects explicit `direct` or canonical `gateway` routing. Gateway mode requires a public authority, placement directory, and identity-key derivation function; cells also require a shared atomic replay store. |
| `observability` | Optional sink for lookup-store instrumentation. |

## Lookup store

```ts
interface ConditionalKVStoreAdapter {
  get(key: string): Promise<string | null>;
  set(input: { key: string; value: string; ttlSeconds?: number }): Promise<void>;
  setIfAbsent(input: { key: string; value: string; ttlSeconds?: number }): Promise<{
    inserted: boolean;
    existing?: string;
  }>;
  compareAndSet?(input: {
    key: string;
    expected: string | null;
    value: string;
    ttlSeconds?: number;
  }): Promise<{ updated: boolean; existing?: string }>;
  delete(key: string): Promise<void>;
}

interface AuthFnRegionLookupRecord {
  identifier: string;                  // typically lowercase email
  userId?: string;
  regionId: string;
  authority: string;
  domain?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}
```

AuthFn normalizes the identifier, uses the key
`authfn:region:<normalized-identifier>`, and serializes the lookup record as the
string value. `setIfAbsent` must be atomic across every writer that may claim
an identifier. Gateway placement additionally requires atomic `compareAndSet`
for fenced epoch/state transitions. Bundled implementations are available as
`@authfn/lookup-dynamodb` and `@authfn/lookup-cloudflare-do`; a custom
conditional KV implementation can target another backend.

Common implementations:

- **DynamoDB** (AWS): use the bundled composite `PK`/`SK` layout and route canonical placement through one declared writer region. Global Table replicas may be recovery/shadow-read replicas, not independent placement writers.
- **Cloudflare Durable Objects**: use a key-named object to serialize claims and placement CAS operations.
- **Postgres or Redis-backed services**: expose one coordinator/leader for the atomic conditional operations; replication or streams alone are not an atomic ownership primitive.

`setIfAbsent` is what enforces region pinning under contention. Implement it as
an atomic conditional insert (`attribute_not_exists`, `INSERT ... ON CONFLICT
DO NOTHING ... RETURNING`, or the platform equivalent).

If you don't supply a lookup store, the plugin falls back to reading `authfn_users` + `authfn_region_profiles` from the *local* database — fine for setups where every region's database carries every user's region profile (globally-replicated table). Less suitable for setups where each region's DB only holds that region's users.

## Routes

| Method | Path | Operation ID | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/regions/lookup` | `lookupRegion` | Look up the right region for an identifier. Used by the client SDK for pre-routing. |
| `GET` | `/auth/environment` | `getEnvironment` | Returns the resolved request environment: `{ regionId, issuer, baseUrl, … }`. |

## Schema

| Table | Purpose |
| --- | --- |
| `authfn_region_profiles` | `{ id, userId, regionId, authority, domain, createdAt, updatedAt }`. One per user. |

…plus your `lookupStore`'s schema, which the kernel does not enforce.

## Region resolution algorithm

For each request:

1. **Match by host.** If `request.url`'s hostname matches one of `regions[*].hosts` (or `regions[*].authority`'s hostname), pick that region.
2. **Match by `runtime.regionId`** from your `config.runtime.resolve(request)`.
3. **Fallback to `defaultRegionId`.**

The matched region's overlays (`cookie`, `oauth`, `issuer`, `baseUrl`) are applied on top of the base runtime. See [Concepts → Runtime](../core-concepts/runtime) for how this composes with the user-supplied resolver.

## Caching

When `stores.kv` is configured on the server, region lookups are cached:

- Hits: 15 minutes (`AUTHFN_CACHE_TTL_SECONDS.regionHit`).
- Misses: 1 minute (`AUTHFN_CACHE_TTL_SECONDS.regionMiss`).

Use a shared KV store in production to share caches across replicas.

## Conflicts and races

If two regions both attempt to register the same email at the same time:

1. Both call `lookupStore.setIfAbsent(...)` for the normalized identifier key.
2. The first wins (`inserted: true`).
3. The second loses (`inserted: false`, `existing: <winner>`). The plugin throws `AUTHFN_REGION_MISMATCH` with `redirectTo` pointing at the winner's authority and emits `authfn.region.lookup.conflict`.

The losing region also rolls back any local writes it had begun. Implement
`lookupStore.setIfAbsent` *before* you do any irreversible write in custom
flows.

## Errors

| Code | When |
| --- | --- |
| `AUTHFN_REGION_MISMATCH` | This authority is not the right one for this user. `details.redirectTo` says where. |
| `AUTHFN_REGION_NOT_FOUND` | The identifier has no region pinning yet. Typically not user-visible — the kernel uses the current region. |
| `AUTHFN_VALIDATION_ERROR` | `lookupRegion` called with a bad identifier. |

## Events

- `authfn.region.lookup` — successful lookup (every privileged route).
- `authfn.region.lookup.conflict` — registration race lost.

## Client integration

`@authfn/client` automatically pre-routes by calling `POST /auth/regions/lookup` before sensitive operations when a `defaultRegionId` is configured. You can disable this if you handle routing entirely at the edge:

```ts
const client = createAuthFnClient({
  baseUrl,
  multiRegion: { preroute: false },
});
```

## Related

- [Concepts → Regions](../core-concepts/regions)
- [Concepts → Runtime](../core-concepts/runtime)
- [Recipes → Multi-region deployment](../recipes/multi-region-deployment)
- [Recipes → Canonical-gateway multi-region](../recipes/canonical-gateway-multi-region)
- [Recipes → Placement-bound auth context](../recipes/placement-bound-auth-context)
- [Examples → multi-region-routing](../examples/multi-region-routing)
