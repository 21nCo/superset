---
title: "authfn"
description: The Node server kernel — declare an app with authfn(), then inject runtime dependencies with createServer().
---

# authfn

The `authfn` package is the server kernel and plugin contract. It uses a two-stage API: declare a side-effect-free app, then create a server with runtime dependencies.

```bash
npm install authfn
```

## `authfn(config)`

```ts
function authfn<TPlugins extends AuthFnPluginList>(
  config: AuthFnConfig<TPlugins>
): AuthFnApp<TPlugins>;

interface AuthFnConfig<TPlugins> {
  namespace?: string;
  basePath?: string;
  cookie?: AuthFnCookieConfig;
  accountLinking?: AuthFnAccountLinkingConfig;
  plugins: TPlugins;
  openApi?: boolean | { title: string; version: string };
}
```

Use `authFnPlugins(...)` when declaring plugins so TypeScript preserves their exact names and infers the matching `pluginRuntime` shape.

```ts
import { authfn, authFnPlugins } from "authfn";
import { authFnPasswordPlugin } from "@authfn/password";

const app = authfn({
  namespace: "authfn",
  plugins: authFnPlugins(authFnPasswordPlugin()),
});
```

`app.getSchema()` is available without creating a server. Tooling such as schema generation can therefore load the declaration without opening database or network connections.

## `app.createServer(config)`

```ts
interface AuthFnServerConfig {
  database: Adapter;
  stores?: RuntimeStores;
  rateLimit?: AuthFnRateLimitConfig;
  environment?: AuthFnEnvironmentResolver;
  hooks?: Partial<AuthFnHooks>;
  pluginRuntime?: AuthFnPluginRuntimeConfigMap;
  observability?: ObservabilityInput<AuthFnEvent>;
}

interface AuthFnServer {
  router: Router;
  provider: AuthProvider<AuthFnSession>;
  getSchema(): AuthFnSchemaDefinition;
  openApi?(): Record<string, unknown>;
}
```

The server wraps the incoming database with authfn's combined schema before any service uses it. Shared stores, rate limiting, hooks, environment resolution, provider credentials, and observability belong to this runtime stage.

| Property | Notes |
| --- | --- |
| `router` | Framework-neutral router mounted through an `@superfunctions/http-*` adapter. |
| `provider` | Auth provider for authenticating requests inside other Superfunctions or application routes. |
| `getSchema()` | Combined core and plugin schema. |
| `openApi()` | OpenAPI document for the enabled plugin set; present only when `openApi` is enabled on the app. |

## Plugin packages

Plugins are published independently and are not re-exported by the kernel:

| Plugin | Package |
| --- | --- |
| Password | `@authfn/password` |
| Email OTP | `@authfn/email-otp` |
| Social OAuth | `@authfn/social-oauth` |
| API keys | `@authfn/api-keys` |
| Two-factor authentication | `@authfn/two-factor` |
| Multi-region routing | `@authfn/multi-region` |
| Native handoff | `@authfn/native-handoff` |

Schema and policy options are passed to each plugin factory in `authfn({...})`. Runtime dependencies such as OTP delivery, OAuth secrets, shared stores, and clocks are passed under `.createServer({ pluginRuntime })`.

## Authentication helper

```ts
const session = await auth.provider.authenticate(request);
if (!session) {
  return new Response("unauthorized", { status: 401 });
}
```

## Placement-bound auth context

Trusted gateway code can derive an immutable, privacy-preserving routing context after a valid session. This is opt-in and is not a public AuthFn route. See [Placement-bound auth context](../recipes/placement-bound-auth-context).

```ts
import { createAuthFnPlacementContextIssuer } from "authfn";

const issuer = createAuthFnPlacementContextIssuer({
  regionId: 'us-east-1', // region owning config.database
  config,
  placementDirectory,
  identityKeyForUserId: (userId) => `person:${userId}`,
  publicAuthority: "https://account.example.com",
  subjectSecret,
  audiences: ["nucleum-datafn"],
});
const context = await issuer.derive(request);
```

## Hooks and observability

Hooks and observability are runtime dependencies:

```ts
const auth = app.createServer({
  database,
  hooks: {
    beforeUserCreate(ctx, input) {
      // validate or replace input
    },
    afterSessionIssue(ctx, session) {
      auditSession(session);
    },
  },
  observability: {
    emit(event) {
      logger.info(event.type, event);
    },
  },
});
```

## Public types and errors

Core types and the canonical error hierarchy are exported from `authfn`:

```ts
import {
  AuthFnConfigError,
  AuthFnInvalidCredentialsError,
  AuthFnPluginAbortedError,
  AuthFnRateLimitedError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError,
  type AuthFnApp,
  type AuthFnConfig,
  type AuthFnHooks,
  type AuthFnPlugin,
  type AuthFnServer,
  type AuthFnServerConfig,
  type AuthFnSession,
} from "authfn";
```

See [Errors](../core-concepts/errors), [Hooks](../core-concepts/hooks), and [Observability](../core-concepts/observability) for behavior and examples.

## Versioning

`authfn` is the canonical Node kernel package. Plugin and client packages release independently while tracking its public plugin and wire contracts.
