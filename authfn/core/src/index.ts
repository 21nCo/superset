import type { AuthProvider } from '@superfunctions/auth';
import { instrumentAdapter, instrumentKVStore, wrapWithSchema } from '@superfunctions/db';
import { normalizeObservability } from '@superfunctions/observability';
import { createPluginRunner } from './plugin-runner.js';
import { cookieNamesForRequest, createAuthFnRouter } from './http/router.js';
import {
  assertValidCsrf,
  authenticateRequest,
  getCookieSessionState,
  requireCookieSession,
  revokeSessionById
} from './core/sessions.js';
import { getSchema } from './schema.js';
import { createAuthFnOpenApiDocument } from './openapi.js';
import type {
  AuthFnApp,
  AuthFnConfig,
  AuthFnRuntimeConfig,
  AuthFnServer,
  AuthFnServerConfig,
  AuthFnPluginList,
  AuthFnSession
} from './types.js';
import { AuthFnConfigError, AuthFnUnauthenticatedError } from './types.js';

const superfunctionsAppMetadata = Symbol.for('superfunctions.app');

export type * from './types.js';
export type {
  AuthFnApiKeyRecord,
  AuthFnAccountDeletionResult,
  AuthFnConfig,
  AuthFnErrorEnvelope,
  AuthFnApp,
  AuthFnAnyPlugin,
  AuthFnRuntimeConfig,
  AuthFnServer,
  AuthFnServerConfig,
  AuthFnNativeHandoffCodeRecord,
  AuthFnPasswordCredentialRecord,
  AuthFnPlugin,
  AuthFnPluginList,
  AuthFnPluginRuntimeConfigFor,
  AuthFnSchemaDefinition,
  AuthFnSession,
  AuthFnSessionRecord,
  AuthFnSuccessEnvelope,
  AuthFnUserRecord
} from './types.js';
export {
  AuthFnAdminAmbiguousUserError,
  AuthFnAdminConfigError,
  AuthFnAdminUnauthorizedError,
  AuthFnApiKeyRevokedError,
  AuthFnConfigError,
  AuthFnConflictError,
  AuthFnCsrfInvalidError,
  AuthFnEmailNotVerifiedError,
  AuthFnError,
  AuthFnInternalError,
  AuthFnInvalidCredentialsError,
  AuthFnNotFoundError,
  AuthFnNotImplementedError,
  AuthFnOAuthCallbackInvalidError,
  AuthFnOAuthProviderUnsupportedError,
  AuthFnOAuthStateInvalidError,
  AuthFnOAuthStateReplayedError,
  AuthFnPlacementContextInvalidError,
  AuthFnPlacementDirectoryUnavailableError,
  AuthFnPlacementMovingError,
  AuthFnPluginAbortedError,
  AuthFnRateLimitedError,
  AuthFnRedirectUriDisallowedError,
  AuthFnRegionMismatchError,
  AuthFnRegionNotFoundError,
  AuthFnRoutingAssertionInvalidError,
  AuthFnRoutingCellUnavailableError,
  AuthFnSessionExpiredError,
  AuthFnSessionRevokedError,
  AuthFnTwoFactorInvalidCodeError,
  AuthFnTwoFactorRequiredError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from './types.js';
export {
  AUTHFN_SCHEMA_VERSION,
  createCoreTables,
  getSchema
} from './schema.js';
export { createAuthFnOpenApiDocument } from './openapi.js';
export {
  createAuthFnPlacementContextIssuer,
  createAuthFnPlacementContextVerifier,
  freezeAuthFnPlacementContext
} from './core/placement-context.js';
export type {
  AuthFnPlacementBoundAuthContext,
  AuthFnPlacementContextDeriveInput,
  AuthFnPlacementContextIssuer,
  AuthFnPlacementContextIssuerOptions,
  AuthFnPlacementContextVerifier,
  AuthFnPlacementContextVerifierOptions,
  AuthFnSignedPlacementContext
} from './core/placement-context.js';

/**
 * Preserves exact plugin identity so AuthFn can infer runtime dependencies.
 */
export function authFnPlugins<const TPlugins extends AuthFnPluginList>(
  ...plugins: TPlugins
): TPlugins {
  return plugins;
}

/**
 * Declares a side-effect-free AuthFn app for codegen and runtime use.
 */
export function authfn<const TPlugins extends AuthFnPluginList>(
  config: AuthFnConfig<TPlugins>
): AuthFnApp<TPlugins> {
  const app: AuthFnApp<TPlugins> = {
    config,
    getSchema: () => getSchema(config),
    createServer: (server) => createServer(config, server)
  };
  Object.defineProperty(app, superfunctionsAppMetadata, {
    value: {
      libraryName: 'authfn',
      packageName: 'authfn'
    }
  });
  return app;
}

function createServer(
  config: AuthFnConfig<AuthFnPluginList>,
  server: AuthFnServerConfig
): AuthFnServer {
  const plugins = config.plugins;
  if (!Array.isArray(plugins)) {
    throw new AuthFnConfigError('authfn plugins must be provided as an array');
  }

  const schema = getSchema(config);
  const observability = normalizeObservability(server.observability)?.child({ component: 'authfn' });
  const database = instrumentAdapter(wrapWithSchema(server.database, schema), {
    observability: observability?.child({ component: 'authfn.db' }),
    kind: 'db'
  });
  const stores = {
    kv: server.stores?.kv
      ? instrumentKVStore(server.stores.kv, {
          observability: observability?.child({ component: 'authfn.cache' }),
          kind: 'cache'
        })
      : undefined,
    atomicKv: server.stores?.atomicKv
      ? instrumentKVStore(server.stores.atomicKv, {
          observability: observability?.child({ component: 'authfn.atomic' }),
          kind: 'cache'
        })
      : undefined
  };
  const resolvedConfig: AuthFnRuntimeConfig = {
    ...config,
    ...server,
    plugins: [...plugins],
    database,
    stores,
    observability
  };

  const runner = createPluginRunner(resolvedConfig);
  const router = createAuthFnRouter(resolvedConfig, runner.hooks, runner.routes);

  const provider: AuthProvider<AuthFnSession> = {
    authenticate: async (request: Request) => authenticateRequest(resolvedConfig, request),
    authorize: async () => false,
    revoke: async () => undefined
  };

  const instance: AuthFnServer = {
    router,
    provider,
    authorizeMutation: async (request) => {
      const cookieState = await getCookieSessionState(resolvedConfig, request);
      // Cookie credential presence wins even when Authorization is also sent:
      // an expired/revoked/invalid cookie must not become a CSRF bypass.
      if (cookieState.sessionToken) {
        const authenticated = cookieState.session && cookieState.sessionRecord
          ? cookieState
          : await requireCookieSession(resolvedConfig, request);
        assertValidCsrf(request, authenticated);
        return authenticated.session!;
      }
      const session = await authenticateRequest(resolvedConfig, request);
      if (!session) throw new AuthFnUnauthenticatedError();
      return session;
    },
    revokeSession: async (sessionId, options) => {
      await revokeSessionById(resolvedConfig, sessionId, options);
    },
    cookieNamesForRequest: async (request) => cookieNamesForRequest(resolvedConfig, request),
    getSchema: () => schema
  };

  if (resolvedConfig.openApi) {
    instance.openApi = () => createAuthFnOpenApiDocument(resolvedConfig, router);
  }

  return instance;
}
