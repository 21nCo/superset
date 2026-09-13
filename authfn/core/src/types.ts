import type { AuthProvider, AuthSession } from '@superfunctions/auth';
import type { DeliveryProvider, DeliveryResult, EmailDeliveryRequest } from '@superfunctions/delivery';
import type { Adapter, RuntimeStores, TableSchema } from '@superfunctions/db';
import type { Route, Router } from '@superfunctions/http';
import type { ObservationEvent, ObservabilityInput, SuperfunctionObservability } from '@superfunctions/observability';
import type { AuthFnErrorCode } from './core/errors.js';
export {
  AuthFnAdminAmbiguousUserError,
  AuthFnAdminConfigError,
  AuthFnAdminUnauthorizedError,
  AuthFnApiKeyRevokedError,
  AuthFnConfigError,
  AuthFnConflictError,
  AuthFnCsrfInvalidError,
  AuthFnDeliveryFailedError,
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
  AuthFnOtpExpiredError,
  AuthFnOtpInvalidError,
  AuthFnOtpReplayedError,
  AuthFnPlacementDirectoryUnavailableError,
  AuthFnPlacementMovingError,
  AuthFnPluginAbortedError,
  AuthFnRateLimitedError,
  AuthFnRedirectUriDisallowedError,
  AuthFnRegionMismatchError,
  AuthFnRegionNotFoundError,
  AuthFnPlacementContextInvalidError,
  AuthFnRoutingAssertionInvalidError,
  AuthFnRoutingCellUnavailableError,
  AuthFnSessionExpiredError,
  AuthFnSessionRevokedError,
  AuthFnTwoFactorInvalidCodeError,
  AuthFnTwoFactorRequiredError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from './core/errors.js';

export interface AuthFnSchemaDefinition {
  version: number;
  schemas: TableSchema[];
}

export type AuthFnActorType = 'user' | 'api-key';
export type AuthFnAuthMethod =
  | 'password'
  | 'email-otp'
  | 'oauth-google'
  | 'oauth-apple'
  | 'oauth-github'
  | 'api-key'
  | 'two-factor';

export type AuthFnOtpPurpose = 'verify-email' | 'sign-in' | 'sign-up' | 'reset-password';
export type AuthFnSocialProviderId = 'google' | 'apple' | 'github';

export interface AuthFnSession extends AuthSession {
  id: string;
  type: 'session' | 'api-key';
  subject: {
    actorId: string;
    actorType: AuthFnActorType;
    tenantId?: string;
    regionId?: string;
    email?: string;
    attributes?: Record<string, unknown>;
  };
  actorType: AuthFnActorType;
  actorId: string;
  tenantId?: string;
  regionId?: string;
  methods: AuthFnAuthMethod[];
  primaryEmail?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface AuthFnUserRecord {
  id: string;
  primaryEmail?: string;
  emailVerifiedAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  csrfHash?: string;
  methods: AuthFnAuthMethod[];
  metadata?: Record<string, unknown>;
  expiresAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastAuthenticatedAt?: Date | null;
}

export interface AuthFnApiKeyRecord {
  id: string;
  userId?: string | null;
  secretHash: string;
  name?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnTwoFactorEnrollmentRecord {
  id: string;
  userId: string;
  secretEncrypted: string;
  lastUsedCounter?: number | null;
  confirmedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnTwoFactorRecoveryCodeRecord {
  id: string;
  enrollmentId: string;
  codeHash: string;
  usedAt?: Date | null;
  createdAt: Date;
}

export interface AuthFnTwoFactorChallengeRecord {
  id: string;
  userId: string;
  primaryMethod: Exclude<AuthFnAuthMethod, 'two-factor' | 'api-key'>;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnPasswordCredentialRecord {
  id: string;
  userId: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnRegionProfileRecord {
  id: string;
  userId: string;
  regionId: string;
  authority: string;
  domain?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnNativeHandoffCodeRecord {
  id: string;
  codeHash: string;
  sourceSessionId: string;
  target: string;
  regionId: string;
  userId: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface AuthFnOtpChallengeRecord {
  id: string;
  purpose: AuthFnOtpPurpose;
  email: string;
  codeHash: string;
  attemptCount: number;
  deliveryMetadata?: Record<string, unknown>;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthFnAccountDeletionResult {
  deleted: true;
  userId: string;
  primaryEmail?: string;
  delegated: boolean;
  counts: Record<string, number>;
}

export interface AuthFnAccountDeletionFailure {
  userId: string;
  primaryEmail?: string;
  sessionId?: string;
  delegated: boolean;
  error: unknown;
}

export interface AuthFnOtpChallengeLifecycleEvent {
  type: 'authfn.otp.sent' | 'authfn.otp.verified';
  challengeId: string;
  purpose: AuthFnOtpPurpose;
  email: string;
  outcome: 'sent' | 'verified';
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export type AuthFnEventType =
  | 'authfn.user.created'
  | 'authfn.account_linked'
  | 'authfn.account_linking.conflict'
  | 'authfn.account.deleted'
  | 'authfn.password.signup.rollback_failed'
  | 'authfn.session.issued'
  | 'authfn.session.revoked'
  | 'authfn.otp.sent'
  | 'authfn.otp.verified'
  | 'authfn.otp.signup.rollback_failed'
  | 'authfn.oauth.started'
  | 'authfn.oauth.completed'
  | 'authfn.oauth.failed'
  | 'authfn.oauth.token_exchange'
  | 'authfn.api_key.created'
  | 'authfn.api_key.revoked'
  | 'authfn.2fa.enabled'
  | 'authfn.2fa.challenged'
  | 'authfn.region.lookup'
  | 'authfn.region.lookup.conflict'
  | 'authfn.routing.placement_lookup'
  | 'authfn.routing.placement_claimed'
  | 'authfn.routing.forwarded'
  | 'authfn.routing.mismatch'
  | 'authfn.routing.retry'
  | 'authfn.routing.assertion_rejected'
  | 'authfn.routing.directory_unavailable'
  | 'authfn.routing.cell_unavailable'
  | 'authfn.placement_context.issued'
  | 'authfn.placement_context.rejected'
  | 'authfn.placement_context.verified'
  | 'authfn.placement_context.verification_failed'
  | 'authfn.handoff.started'
  | 'authfn.handoff.exchanged'
  | 'authfn.handoff.failed'
  | 'authfn.rate_limited'
  | 'authfn.request.failed'
  | 'authfn.plugin.failed';

export type AuthFnEvent = ObservationEvent<'authfn', AuthFnEventType> & {
  requestId: string;
  actorId?: string;
  sessionId?: string;
  userId?: string;
  regionId?: string;
  provider?: AuthFnSocialProviderId;
  pluginName?: string;
  hookName?: keyof AuthFnHooks | string;
  outcome?: string;
  metadata?: Record<string, unknown>;
};

export type AuthFnEventInput = Omit<AuthFnEvent, 'domain'> & {
  domain?: 'authfn';
};

export interface AuthFnDeliveryRequest extends EmailDeliveryRequest {
  channel: 'email';
  kind: 'authfn.otp';
  challengeId: string;
  purpose: AuthFnOtpPurpose;
  email: string;
  code: string;
}

export interface AuthFnDeliveryResult extends DeliveryResult {
}

export type AuthFnDeliveryMessage = Partial<
  Pick<
    EmailDeliveryRequest,
    'subject' | 'html' | 'text' | 'cc' | 'bcc' | 'attachments' | 'tags' | 'metadata'
  >
>;

export type AuthFnDeliveryMessageResolver = (
  input: AuthFnDeliveryRequest
) => Promise<AuthFnDeliveryMessage | undefined> | AuthFnDeliveryMessage | undefined;

export type AuthFnDeliveryProvider = DeliveryProvider<
  AuthFnDeliveryRequest,
  AuthFnDeliveryResult,
  AuthFnOtpChallengeLifecycleEvent
>;

export interface AuthFnSocialProfile {
  providerAccountId: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  profile?: Record<string, unknown>;
}

export interface AuthFnPasswordCompromiseCheckInput {
  password: string;
  email?: string;
  purpose: 'sign-up' | 'reset-password' | 'update-password';
  request?: Request;
  environment?: AuthFnEnvironment;
}

export type AuthFnPasswordCompromiseCheckResult =
  | boolean
  | {
      compromised: boolean;
      count?: number;
    };

export type AuthFnPasswordCompromiseChecker = (
  input: AuthFnPasswordCompromiseCheckInput
) => Promise<AuthFnPasswordCompromiseCheckResult> | AuthFnPasswordCompromiseCheckResult;

export interface AuthFnAccountLinkingConfig {
  /**
   * Link an OAuth identity to an existing AuthFn user when both sides prove the
   * same verified email address. Provider-level linkByVerifiedEmail overrides
   * this global policy.
   */
  oauthByVerifiedEmail?: boolean | {
    providers?: AuthFnSocialProviderId[];
    requireExistingEmailVerified?: boolean;
    requireProviderEmailVerified?: boolean;
  };
  /**
   * Treat OTP sign-up for an already registered email as sign-in/linking.
   * The OTP itself proves control of the email address.
   */
  otpSignUpExistingUser?: boolean;
  /**
   * Allow an already authenticated user to add a password credential for their
   * own email through the password sign-up endpoint when no password exists.
   */
  passwordForAuthenticatedUser?: boolean | {
    requireExistingEmailVerified?: boolean;
  };
}

export interface AuthFnSuccessEnvelope<TData = Record<string, unknown>> {
  ok: true;
  data: TData;
  requestId: string;
}

export interface AuthFnErrorEnvelope {
  ok: false;
  error: {
    code: AuthFnErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

export interface AuthFnCookieConfig {
  prefix?: string;
  domain?: string | ((input: { request: Request; regionId?: string }) => string | undefined);
  secure?: boolean | ((request: Request) => boolean);
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  sessionMaxAgeSeconds?: number;
  csrfMaxAgeSeconds?: number;
}

export interface AuthFnEnvironment {
  issuer: string;
  baseUrl: string;
  regionId?: string;
  cookie?: Partial<AuthFnCookieConfig>;
  oauth?: Record<string, unknown>;
}

export interface AuthFnRegionLookup {
  userId?: string;
  regionId: string;
  authority: string;
  domain?: string;
}

export interface AuthFnRegionLookupResult extends AuthFnRegionLookup {
  identifier: string;
  continueLocally: boolean;
  redirectTo?: string;
}

export interface AuthFnEnvironmentResolver {
  resolve(request: Request): Promise<AuthFnEnvironment> | AuthFnEnvironment;
}

export interface AuthFnHookContext {
  config?: AuthFnRuntimeConfig;
  request?: Request;
  environment?: AuthFnEnvironment;
  pluginName?: string;
  session?: AuthFnSession;
  actorId?: string;
  /** Mutable state scoped to one hook-driven operation. */
  operationState?: Map<symbol, unknown>;
}

export interface AuthFnHooks {
  beforeUserCreate(
    ctx: AuthFnHookContext,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  afterUserCreate(
    ctx: AuthFnHookContext,
    user: Record<string, unknown>
  ): Promise<void> | void;
  beforeSessionIssue(
    ctx: AuthFnHookContext,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  afterSessionIssue(
    ctx: AuthFnHookContext,
    session: AuthFnSession
  ): Promise<void> | void;
  beforeChallengeSend(
    ctx: AuthFnHookContext,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  afterChallengeSend(
    ctx: AuthFnHookContext,
    result: Record<string, unknown>
  ): Promise<void> | void;
  beforeOAuthStart(
    ctx: AuthFnHookContext,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  afterOAuthCallback(
    ctx: AuthFnHookContext,
    result: Record<string, unknown>
  ): Promise<void> | void;
  beforeAccountDelete(
    ctx: AuthFnHookContext,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  afterAccountDelete(
    ctx: AuthFnHookContext,
    result: AuthFnAccountDeletionResult
  ): Promise<void> | void;
  afterAccountDeleteFailure(
    ctx: AuthFnHookContext,
    failure: AuthFnAccountDeletionFailure
  ): Promise<void> | void;
}

export type AuthFnHookFailurePolicy = 'observe' | 'fail';

export interface AuthFnPluginRuntimeContext {
  config: AuthFnRuntimeConfig;
  namespace: string;
  basePath: string;
  hooks: Partial<AuthFnHooks>;
  environment?: AuthFnEnvironmentResolver;
}

export interface AuthFnPlugin<
  TName extends string = string,
  TRuntimeConfig extends object = never,
  TRuntimeRequired extends boolean = false
> {
  name: TName;
  readonly __runtimeConfig?: TRuntimeConfig;
  readonly __runtimeRequired?: TRuntimeRequired;
  schema?: (config: AuthFnConfig) => AuthFnSchemaDefinition['schemas'];
  routes?: (ctx: AuthFnPluginRuntimeContext) => Route[];
  hooks?: Partial<AuthFnHooks>;
  hookFailurePolicy?: Partial<Record<keyof AuthFnHooks, AuthFnHookFailurePolicy>>;
  validateConfig?: (config: AuthFnRuntimeConfig) => void;
}

export type AuthFnAnyPlugin = AuthFnPlugin<string, object, boolean>;

export type AuthFnPluginList = readonly AuthFnAnyPlugin[];

type AuthFnPluginRuntimeEntry<TPlugin> =
  TPlugin extends AuthFnPlugin<infer TName, infer TRuntimeConfig, infer TRuntimeRequired>
    ? [TRuntimeConfig] extends [never]
      ? {}
      : TRuntimeRequired extends true
      ? { [TKey in TName]: TRuntimeConfig }
      : { [TKey in TName]?: TRuntimeConfig }
    : {};

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (input: TUnion) => void : never
) extends (input: infer TIntersection) => void
  ? TIntersection
  : never;

type Simplify<TValue> = {
  [TKey in keyof TValue]: TValue[TKey];
} & {};

export type AuthFnPluginRuntimeConfigFor<TPlugins extends AuthFnPluginList> = Simplify<
  UnionToIntersection<AuthFnPluginRuntimeEntry<TPlugins[number]>>
>;

type RequiredRuntimeKeys<TPlugins extends AuthFnPluginList> = {
  [TKey in keyof AuthFnPluginRuntimeConfigFor<TPlugins>]-?: undefined extends AuthFnPluginRuntimeConfigFor<TPlugins>[TKey]
    ? never
    : TKey;
}[keyof AuthFnPluginRuntimeConfigFor<TPlugins>];

type AuthFnNoPluginRuntimeConfigInput = {
  /**
   * Runtime configuration for AuthFn plugins declared on the app.
   * Apps with no runtime-configurable plugins must omit this property.
   */
  pluginRuntime?: never;
};

type AuthFnOptionalPluginRuntimeConfigInput<TPlugins extends AuthFnPluginList> = {
  /**
   * Runtime configuration for AuthFn plugins declared on the app.
   * Keys are plugin names and values are the runtime dependencies or policy overrides each plugin consumes.
   */
  pluginRuntime?: AuthFnPluginRuntimeConfigFor<TPlugins>;
};

type AuthFnRequiredPluginRuntimeConfigInput<TPlugins extends AuthFnPluginList> = {
  /**
   * Runtime configuration for AuthFn plugins declared on the app.
   * Required plugin entries must be provided before the server can handle requests.
   */
  pluginRuntime: AuthFnPluginRuntimeConfigFor<TPlugins>;
};

type AuthFnPluginRuntimeConfigInput<TPlugins extends AuthFnPluginList> =
  keyof AuthFnPluginRuntimeConfigFor<TPlugins> extends never
    ? AuthFnNoPluginRuntimeConfigInput
    : RequiredRuntimeKeys<TPlugins> extends never
      ? AuthFnOptionalPluginRuntimeConfigInput<TPlugins>
      : AuthFnRequiredPluginRuntimeConfigInput<TPlugins>;

export interface AuthFnConfig<TPlugins extends AuthFnPluginList = AuthFnPluginList> {
  namespace?: string;
  basePath?: string;
  cookie?: AuthFnCookieConfig;
  accountLinking?: AuthFnAccountLinkingConfig;
  plugins: TPlugins;
  openApi?: boolean | { title: string; version: string };
}

export type AuthFnRateLimitMode = 'strict' | 'best-effort' | 'local';

export interface AuthFnRateLimitCategory {
  ipLimit: number;
  identifierLimit?: number;
  windowSeconds: number;
}

export interface AuthFnRateLimitConfig {
  /** Enables request rate limiting for AuthFn HTTP routes. */
  enabled: boolean;
  /**
   * Resolves the client IP from trusted platform or proxy context.
   * Forwarding headers are ignored unless this explicit trust boundary reads them.
   */
  resolveClientIp?: (request: Request) => string | undefined | Promise<string | undefined>;
  /**
   * Storage consistency used for counters.
   * Use strict with an atomic store, best-effort with a shared cache, or local for process-local protection.
   */
  mode?: AuthFnRateLimitMode;
  /** Per-category limits for password, OTP, OAuth, handoff, region lookup, and account routes. */
  policies?: Partial<Record<
    | 'password'
    | 'otp-send'
    | 'otp-verify'
    | 'password-reset'
    | 'social-start'
    | 'handoff'
    | 'region-lookup'
    | 'account',
    AuthFnRateLimitCategory
  >>;
}

export interface AuthFnServerConfig {
  /** Database adapter used to persist AuthFn users, sessions, credentials, OAuth accounts, OTPs, and plugin tables. */
  database: Adapter;
  /** Runtime stores used for caching, atomic coordination, rate limiting, and plugin-specific shared state. */
  stores?: RuntimeStores;
  /** Rate-limit policy for AuthFn routes; omit to disable rate limiting. */
  rateLimit?: AuthFnRateLimitConfig;
  /** Resolves request-specific authority, base URL, region, cookie, and OAuth environment values. */
  environment?: AuthFnEnvironmentResolver;
  /** Lifecycle hooks for overriding or observing core AuthFn user, session, account, and plugin behavior. */
  hooks?: Partial<AuthFnHooks>;
  /** Runtime dependencies and options for AuthFn plugins when the app is used without typed plugin inference. */
  pluginRuntime?: AuthFnPluginRuntimeConfigMap;
  /** Observability sink for AuthFn request, session, OAuth, OTP, 2FA, rate-limit, and plugin events. */
  observability?: ObservabilityInput<AuthFnEvent>;
}

export type AuthFnTypedServerConfig<TPlugins extends AuthFnPluginList> = Omit<AuthFnServerConfig, 'pluginRuntime'>
  & AuthFnPluginRuntimeConfigInput<TPlugins>;

export interface AuthFnRuntimeConfig extends Omit<AuthFnConfig<AuthFnPluginList>, 'plugins'>, Omit<AuthFnServerConfig, 'observability'> {
  plugins: AuthFnAnyPlugin[];
  observability?: SuperfunctionObservability<AuthFnEvent>;
}

export type AuthFnPluginRuntimeConfigMap = Record<string, unknown>;

export interface AuthFnServer {
  router: Router;
  provider: AuthProvider<AuthFnSession>;
  /**
   * Authenticates an unsafe request and enforces AuthFn's CSRF contract when
   * cookie credentials are present. Bearer/API-key requests do not require
   * CSRF, and an invalid cookie can never downgrade to another credential.
   */
  authorizeMutation(request: Request): Promise<AuthFnSession>;
  /** Revoke one AuthFn session through the instance's resolved schema/config. */
  revokeSession(sessionId: string, options?: { userId?: string }): Promise<void>;
  /** Resolve the active runtime/cookie policy through the instance schema. */
  cookieNamesForRequest(request: Request): Promise<{
    sessionCookieName: string;
    csrfCookieName: string;
  }>;
  getSchema(): AuthFnSchemaDefinition;
  openApi?(): Record<string, unknown>;
}

/**
 * Side-effect-free AuthFn app object that can expose schema or create runtime auth.
 */
export interface AuthFnApp<TPlugins extends AuthFnPluginList = AuthFnPluginList> {
  readonly config: AuthFnConfig<TPlugins>;
  getSchema(): AuthFnSchemaDefinition;
  /**
   * Creates an AuthFn server runtime from the side-effect-free app declaration.
   * The server config supplies persistence, stores, environment resolution, hooks, observability, and plugin runtime dependencies.
   */
  createServer(server: AuthFnTypedServerConfig<TPlugins>): AuthFnServer;
}
