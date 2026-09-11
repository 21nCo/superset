import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthFnIdentityPlacement,
  AuthFnIdentityPlacementDirectoryAdapter,
  AuthFnRoutingKeyring
} from '../plugin-types.js';
import type {
  AuthFnActorType,
  AuthFnApiKeyRecord,
  AuthFnAuthMethod,
  AuthFnEventInput,
  AuthFnRuntimeConfig,
  AuthFnSessionRecord,
  AuthFnUserRecord
} from '../types.js';
import {
  AuthFnApiKeyRevokedError,
  AuthFnConfigError,
  AuthFnPlacementContextInvalidError,
  AuthFnPlacementDirectoryUnavailableError,
  AuthFnPlacementMovingError,
  AuthFnRegionNotFoundError,
  AuthFnSessionExpiredError,
  AuthFnSessionRevokedError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError,
  toAuthFnError
} from './errors.js';
import { emitAuthEvent, eventRequestId } from './observability.js';
import { getMultiRegionPluginConfig } from './regions.js';
import { getCookieSessionState, hashSecret } from './sessions.js';
import { findUserById } from './users.js';

const INTERNAL_HEADER_PREFIX = 'x-authfn-routing-';
const CONTEXT_KIND = 'placement-context';
const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

export interface AuthFnPlacementBoundAuthContext {
  readonly subject: string;
  readonly homeRegion: string;
  readonly placementEpoch: number;
  readonly issuer: string;
  readonly sessionBinding: string;
  readonly sessionVersion: string;
  readonly authenticatedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly audience: string;
  readonly assurance: readonly AuthFnAuthMethod[];
  readonly scopes?: readonly string[];
  readonly requestId: string;
  readonly actorType: AuthFnActorType;
  readonly userId?: string;
}

export interface AuthFnPlacementContextIssuerOptions {
  config: AuthFnRuntimeConfig;
  /** Region owning config.database. Inferred only from a configured gateway cell. */
  regionId?: string;
  /** HMAC secret used to derive the opaque subject and session binding. */
  subjectSecret: string | Uint8Array;
  /** Audiences this issuer may mint context for. */
  audiences: readonly string[];
  /** Default audience used when derive/issueSigned omit one. */
  audience?: string;
  publicAuthority?: string;
  placementDirectory?: AuthFnIdentityPlacementDirectoryAdapter;
  identityKeyForUserId?: (userId: string) => string | Promise<string>;
  /** Signing keyring for the optional private-service assertion. */
  keyring?: AuthFnRoutingKeyring;
  ttlSeconds?: number;
  clockSkewSeconds?: number;
  includeUserId?: boolean;
  now?: () => Date;
}

export interface AuthFnPlacementContextVerifierOptions {
  /** Audiences this verifier may accept. */
  audiences: readonly string[];
  /** Default audience used when verifySigned omits one. */
  audience?: string;
  publicAuthority: string;
  /** Dedicated placement-context keyring. Do not reuse gateway-routing keys. */
  keyring: AuthFnRoutingKeyring;
  clockSkewSeconds?: number;
  now?: () => Date;
  /** Optional. Used only to emit verification events. */
  config?: AuthFnRuntimeConfig;
}

export interface AuthFnPlacementContextVerifier {
  verifySigned(
    assertion: string,
    input?: AuthFnPlacementContextDeriveInput
  ): AuthFnPlacementBoundAuthContext;
}

export interface AuthFnPlacementContextDeriveInput {
  audience?: string;
}

export interface AuthFnSignedPlacementContext {
  context: AuthFnPlacementBoundAuthContext;
  assertion: string;
}

export interface AuthFnPlacementContextIssuer {
  derive(
    request: Request,
    input?: AuthFnPlacementContextDeriveInput
  ): Promise<AuthFnPlacementBoundAuthContext>;
  withContext<T>(
    request: Request,
    consumer: (context: AuthFnPlacementBoundAuthContext) => Promise<T> | T,
    input?: AuthFnPlacementContextDeriveInput
  ): Promise<T>;
  issueSigned(
    request: Request,
    input?: AuthFnPlacementContextDeriveInput
  ): Promise<AuthFnSignedPlacementContext>;
  verifySigned(
    assertion: string,
    input?: AuthFnPlacementContextDeriveInput
  ): AuthFnPlacementBoundAuthContext;
}

interface PlacementPrincipal {
  userId: string;
  actorType: AuthFnActorType;
  actorId: string;
  sessionId: string;
  sessionVersionMaterial: string;
  methods: AuthFnAuthMethod[];
  scopes?: string[];
  authenticatedAt: Date;
  sessionExpiresAt?: Date;
}

interface SignedPlacementContextPayload {
  kind: typeof CONTEXT_KIND;
  keyId: string;
  subject: string;
  homeRegion: string;
  placementEpoch: number;
  issuer: string;
  sessionBinding: string;
  sessionVersion: string;
  authenticatedAt: number;
  issuedAt: number;
  expiresAt: number;
  audience: string;
  assurance: AuthFnAuthMethod[];
  scopes?: string[];
  requestId: string;
  actorType: AuthFnActorType;
  nonce: string;
  userId?: string;
}

/**
 * Opt-in factory for trusted server-side consumers. AuthFn does not mint DataFn
 * tickets or expose this context on public auth routes.
 */
export function createAuthFnPlacementContextIssuer(
  options: AuthFnPlacementContextIssuerOptions
): AuthFnPlacementContextIssuer {
  const routing = getMultiRegionPluginConfig(options.config)?.routing;
  const cellRegionId = routing?.mode === 'gateway' ? routing.cell?.regionId : undefined;
  const regionId = options.regionId ?? cellRegionId;
  if (!regionId?.trim() || (cellRegionId && regionId !== cellRegionId)) {
    throw new AuthFnConfigError('Placement-context issuance requires the region owning config.database');
  }
  const placementDirectory = options.placementDirectory
    ?? (routing?.mode === 'gateway' ? routing.placementDirectory : undefined);
  const identityKeyForUserId = options.identityKeyForUserId
    ?? (routing?.mode === 'gateway' ? routing.identityKeyForUserId : undefined);
  const publicAuthority = normalizeAuthority(
    options.publicAuthority
    ?? (routing?.mode === 'gateway' ? routing.publicAuthority : undefined)
    ?? routing?.publicAuthority
  );
  if (!placementDirectory) {
    throw new AuthFnConfigError('Placement-bound auth context requires a placement directory');
  }
  if (!identityKeyForUserId) {
    throw new AuthFnConfigError('Placement-bound auth context requires identityKeyForUserId');
  }
  const directory = placementDirectory;
  const resolveIdentityKey = identityKeyForUserId;
  const audiences = uniqueAudiences(options.audiences);
  if (audiences.length === 0) {
    throw new AuthFnConfigError('Placement-bound auth context requires at least one audience');
  }
  const defaultAudience = options.audience ?? audiences[0];
  if (!audiences.includes(defaultAudience)) {
    throw new AuthFnConfigError('Default placement-context audience must be in the allowlist');
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new AuthFnConfigError(`Placement-context ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}`);
  }
  const clockSkewSeconds = options.clockSkewSeconds ?? 5;
  if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60) {
    throw new AuthFnConfigError('Placement-context clockSkewSeconds must be between 0 and 60');
  }
  const subjectSecret = secretBytes(options.subjectSecret);
  if (subjectSecret.byteLength < 32) {
    throw new AuthFnConfigError('Placement-context subjectSecret must be at least 32 bytes');
  }
  if (options.keyring) validateKeyring(options.keyring);
  const now = options.now ?? (() => new Date());
  const includeUserId = options.includeUserId === true;
  const verifier = options.keyring
    ? createAuthFnPlacementContextVerifier({
        audiences,
        audience: defaultAudience,
        publicAuthority,
        keyring: options.keyring,
        clockSkewSeconds,
        now,
        config: options.config
      })
    : undefined;

  async function derive(
    request: Request,
    input?: AuthFnPlacementContextDeriveInput
  ): Promise<AuthFnPlacementBoundAuthContext> {
    const requestId = eventRequestId(request);
    const sanitizedRequest = stripClientRoutingHeaders(request);
    sanitizedRequest.headers.set('x-request-id', requestId);
    try {
      const audience = resolveAudience(input?.audience ?? defaultAudience, audiences);
      const principal = await resolvePrincipal(options.config, sanitizedRequest, now);
      const identityKey = await resolveIdentityKey(principal.userId);
      const placement = await loadActivePlacement(directory, identityKey);
      if (placement.regionId !== regionId) {
        throw new AuthFnPlacementMovingError('Session validation region does not own the current placement', { executionStarted: false });
      }
      const issuedAtDate = now();
      const issuedAtMs = issuedAtDate.getTime();
      const ttlExpiryMs = issuedAtMs + ttlSeconds * 1000;
      const sessionExpiryMs = principal.sessionExpiresAt?.getTime();
      const expiresAtMs = sessionExpiryMs === undefined
        ? ttlExpiryMs
        : Math.min(ttlExpiryMs, sessionExpiryMs);
      if (expiresAtMs <= issuedAtMs) {
        throw new AuthFnSessionExpiredError();
      }
      const context = freezeContext({
        subject: hmacOpaque(subjectSecret, 'subject', principal.userId),
        homeRegion: placement.regionId,
        placementEpoch: placement.epoch,
        issuer: publicAuthority,
        sessionBinding: hmacOpaque(subjectSecret, 'session', principal.sessionId),
        sessionVersion: hmacOpaque(subjectSecret, 'session-version', principal.sessionVersionMaterial),
        authenticatedAt: principal.authenticatedAt.toISOString(),
        issuedAt: issuedAtDate.toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        audience,
        assurance: Object.freeze([...principal.methods]),
        scopes: principal.scopes ? Object.freeze([...principal.scopes]) : undefined,
        requestId,
        actorType: principal.actorType,
        userId: includeUserId ? principal.userId : undefined
      });
      await emit(options.config, sanitizedRequest, 'authfn.placement_context.issued', {
        requestId,
        outcome: 'success',
        regionId: context.homeRegion,
        actorId: hashForTelemetry(context.subject),
        metadata: {
          epoch: context.placementEpoch,
          audience: context.audience,
          actorType: context.actorType,
          subjectDigest: hashForTelemetry(context.subject)
        }
      });
      return context;
    } catch (error) {
      await emitRejection(options.config, sanitizedRequest, error, requestId);
      throw error;
    }
  }

  function verifySigned(
    assertion: string,
    input?: AuthFnPlacementContextDeriveInput
  ): AuthFnPlacementBoundAuthContext {
    if (!verifier) {
      throw new AuthFnConfigError('Placement-context verification requires a keyring');
    }
    return verifier.verifySigned(assertion, input);
  }

  return {
    derive,
    async withContext(request, consumer, input) {
      return consumer(await derive(request, input));
    },
    async issueSigned(request, input) {
      if (!options.keyring) {
        throw new AuthFnConfigError('Signed placement context requires a keyring');
      }
      const context = await derive(request, input);
      return {
        context,
        assertion: signPlacementPayload(payloadFromContext(context, options.keyring), options.keyring)
      };
    },
    verifySigned
  };
}

/**
 * Verification-only factory for a private remote consumer. HMAC holders can also
 * mint assertions, so treat every verifier as a trusted co-issuer and give it a
 * dedicated placement-context keyring — never the gateway-routing keys.
 */
export function createAuthFnPlacementContextVerifier(
  options: AuthFnPlacementContextVerifierOptions
): AuthFnPlacementContextVerifier {
  const audiences = uniqueAudiences(options.audiences);
  if (audiences.length === 0) {
    throw new AuthFnConfigError('Placement-bound auth context requires at least one audience');
  }
  const defaultAudience = options.audience ?? audiences[0];
  if (!audiences.includes(defaultAudience)) {
    throw new AuthFnConfigError('Default placement-context audience must be in the allowlist');
  }
  const clockSkewSeconds = options.clockSkewSeconds ?? 5;
  if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60) {
    throw new AuthFnConfigError('Placement-context clockSkewSeconds must be between 0 and 60');
  }
  const publicAuthority = normalizeAuthority(options.publicAuthority);
  validateKeyring(options.keyring);
  const now = options.now ?? (() => new Date());

  return {
    verifySigned(assertion, input) {
      const requestedAudience = input?.audience ?? defaultAudience;
      let verifiedRequestId: string | undefined;
      try {
        const payload = verifyPlacementPayload(assertion, options.keyring, now, clockSkewSeconds);
        verifiedRequestId = payload.requestId;
        const audience = resolveAudience(requestedAudience, audiences);
        if (payload.audience !== audience) {
          throw new AuthFnPlacementContextInvalidError('Placement-bound auth context audience is invalid');
        }
        if (payload.issuer !== publicAuthority) {
          throw new AuthFnPlacementContextInvalidError('Placement-bound auth context issuer is invalid');
        }
        const context = contextFromPayload(payload);
        if (options.config) {
          void emit(options.config, undefined, 'authfn.placement_context.verified', {
            requestId: context.requestId,
            outcome: 'success',
            regionId: context.homeRegion,
            metadata: {
              epoch: context.placementEpoch,
              audience: context.audience,
              subjectDigest: hashForTelemetry(context.subject)
            }
          });
        }
        return context;
      } catch (error) {
        if (options.config) {
          void emit(options.config, undefined, 'authfn.placement_context.verification_failed', {
            requestId: verifiedRequestId,
            outcome: 'rejected',
            metadata: { errorType: readErrorCode(error), audience: requestedAudience }
          });
        }
        throw error instanceof AuthFnPlacementContextInvalidError
          ? error
          : new AuthFnPlacementContextInvalidError();
      }
    }
  };
}

export function freezeAuthFnPlacementContext(
  context: AuthFnPlacementBoundAuthContext
): AuthFnPlacementBoundAuthContext {
  return freezeContext(context);
}

async function resolvePrincipal(
  config: AuthFnRuntimeConfig,
  request: Request,
  now: () => Date
): Promise<PlacementPrincipal> {
  const cookieState = await getCookieSessionState(config, request, { touch: false, now });
  if (cookieState.session) {
    return principalFromCookieState(cookieState);
  }

  const credential = readAuthorizationCredential(request);
  if (credential) {
    if (credential.scheme === 'bearer') {
      const sessionPrincipal = await resolveBearerSession(config, credential.secret, now);
      if (sessionPrincipal) return sessionPrincipal;
    }
    const apiKeyPrincipal = await resolveApiKeyPrincipal(config, credential.secret, now);
    if (apiKeyPrincipal) return apiKeyPrincipal;
  }

  if (cookieState.sessionToken) {
    return principalFromCookieState(cookieState);
  }
  throw new AuthFnUnauthenticatedError();
}

function principalFromCookieState(
  cookieState: Awaited<ReturnType<typeof getCookieSessionState>>
): PlacementPrincipal {
  if (cookieState.failureReason === 'revoked') throw new AuthFnSessionRevokedError();
  if (cookieState.failureReason === 'expired') throw new AuthFnSessionExpiredError();
  if (!cookieState.session || !cookieState.sessionRecord || !cookieState.user) {
    throw new AuthFnUnauthenticatedError();
  }
  return principalFromSession(cookieState.sessionRecord, cookieState.user, cookieState.session.methods);
}

async function resolveApiKeyPrincipal(
  config: AuthFnRuntimeConfig,
  secret: string,
  now: () => Date
): Promise<PlacementPrincipal | null> {
  try {
    // Same keyed lookup AuthFn uses for API keys (not password storage).
    // codeql[js/insufficient-password-hash]
    const secretHash = hashSecret(secret);
    const record = await config.database.findOne<AuthFnApiKeyRecord>({
      model: 'api_keys',
      where: [{ field: 'secretHash', operator: 'eq', value: secretHash }],
      namespace: namespace(config)
    });
    if (!record) return null;
    if (record.revokedAt) throw new AuthFnApiKeyRevokedError();
    if (record.expiresAt && record.expiresAt.getTime() <= now().getTime()) {
      throw new AuthFnUnauthenticatedError();
    }
    const userId = typeof record.userId === 'string' ? record.userId : undefined;
    if (!userId) throw new AuthFnUnauthenticatedError();
    const user = await findUserById(config, userId);
    if (!user) throw new AuthFnUnauthenticatedError();
    const scopes = Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined;
    return {
      userId: user.id,
      actorType: 'api-key',
      actorId: record.id,
      sessionId: record.id,
      sessionVersionMaterial: credentialVersionMaterial(record),
      methods: ['api-key'],
      scopes,
      authenticatedAt: record.lastUsedAt ?? record.createdAt,
      sessionExpiresAt: record.expiresAt ?? undefined
    };
  } catch (error) {
    if (error instanceof AuthFnApiKeyRevokedError || error instanceof AuthFnUnauthenticatedError) {
      throw error;
    }
    throw toAuthFnError(error);
  }
}

async function resolveBearerSession(
  config: AuthFnRuntimeConfig,
  sessionToken: string,
  now: () => Date
): Promise<PlacementPrincipal | null> {
  // Same keyed lookup AuthFn uses for session tokens (not password storage).
  // codeql[js/insufficient-password-hash]
  const tokenHash = hashSecret(sessionToken);
  const record = await config.database.findOne<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'tokenHash', operator: 'eq', value: tokenHash }],
    namespace: namespace(config)
  });
  if (!record) return null;
  if (record.revokedAt) throw new AuthFnSessionRevokedError();
  if (record.expiresAt.getTime() <= now().getTime()) throw new AuthFnSessionExpiredError();
  const user = await findUserById(config, record.userId);
  if (!user) throw new AuthFnUnauthenticatedError();
  return principalFromSession(record, user, record.methods);
}

function principalFromSession(
  record: AuthFnSessionRecord,
  user: AuthFnUserRecord,
  methods: AuthFnAuthMethod[]
): PlacementPrincipal {
  return {
    userId: user.id,
    actorType: 'user',
    actorId: user.id,
    sessionId: record.id,
    sessionVersionMaterial: credentialVersionMaterial(record),
    methods,
    authenticatedAt: record.lastAuthenticatedAt ?? record.createdAt,
    sessionExpiresAt: record.expiresAt
  };
}

async function loadActivePlacement(
  directory: AuthFnIdentityPlacementDirectoryAdapter,
  identityKey: string
): Promise<AuthFnIdentityPlacement> {
  let placement: AuthFnIdentityPlacement | null;
  try {
    placement = await directory.get(identityKey);
  } catch {
    throw new AuthFnPlacementDirectoryUnavailableError();
  }
  if (!placement || placement.state === 'tombstoned') {
    throw new AuthFnRegionNotFoundError('Identity placement is not active');
  }
  if (placement.state === 'moving' || placement.state === 'deleting') {
    throw new AuthFnPlacementMovingError(undefined, { executionStarted: false });
  }
  if (placement.state !== 'active') {
    throw new AuthFnRegionNotFoundError('Identity placement is not active');
  }
  if (placement.identityKey !== identityKey || !placement.regionId?.trim()
      || !Number.isSafeInteger(placement.epoch) || placement.epoch < 1) {
    throw new AuthFnPlacementDirectoryUnavailableError('Invalid authoritative placement record');
  }
  return placement;
}

function freezeContext(
  context: AuthFnPlacementBoundAuthContext
): AuthFnPlacementBoundAuthContext {
  return Object.freeze({
    ...context,
    assurance: Object.freeze([...context.assurance]),
    scopes: context.scopes ? Object.freeze([...context.scopes]) : undefined
  });
}

function payloadFromContext(
  context: AuthFnPlacementBoundAuthContext,
  keyring: AuthFnRoutingKeyring
): SignedPlacementContextPayload {
  return {
    kind: CONTEXT_KIND,
    keyId: keyring.active.keyId,
    subject: context.subject,
    homeRegion: context.homeRegion,
    placementEpoch: context.placementEpoch,
    issuer: context.issuer,
    sessionBinding: context.sessionBinding,
    sessionVersion: context.sessionVersion,
    authenticatedAt: Math.floor(Date.parse(context.authenticatedAt) / 1000),
    issuedAt: Math.floor(Date.parse(context.issuedAt) / 1000),
    expiresAt: Math.floor(Date.parse(context.expiresAt) / 1000),
    audience: context.audience,
    assurance: [...context.assurance],
    scopes: context.scopes ? [...context.scopes] : undefined,
    requestId: context.requestId,
    actorType: context.actorType,
    nonce: randomBytes(16).toString('base64url'),
    userId: context.userId
  };
}

function contextFromPayload(payload: SignedPlacementContextPayload): AuthFnPlacementBoundAuthContext {
  return freezeContext({
    subject: payload.subject,
    homeRegion: payload.homeRegion,
    placementEpoch: payload.placementEpoch,
    issuer: payload.issuer,
    sessionBinding: payload.sessionBinding,
    sessionVersion: payload.sessionVersion,
    authenticatedAt: new Date(payload.authenticatedAt * 1000).toISOString(),
    issuedAt: new Date(payload.issuedAt * 1000).toISOString(),
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
    audience: payload.audience,
    assurance: Object.freeze([...payload.assurance]),
    scopes: payload.scopes ? Object.freeze([...payload.scopes]) : undefined,
    requestId: payload.requestId,
    actorType: payload.actorType,
    userId: typeof payload.userId === 'string' ? payload.userId : undefined
  });
}

function signPlacementPayload(
  payload: SignedPlacementContextPayload,
  keyring: AuthFnRoutingKeyring
): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', keyring.active.secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPlacementPayload(
  token: string,
  keyring: AuthFnRoutingKeyring,
  now: () => Date,
  clockSkewSeconds: number
): SignedPlacementContextPayload {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new AuthFnPlacementContextInvalidError();
  let payload: SignedPlacementContextPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPlacementContextPayload;
  } catch {
    throw new AuthFnPlacementContextInvalidError();
  }
  if (!isSignedPlacementPayload(payload)) throw new AuthFnPlacementContextInvalidError();
  const key = [keyring.active, ...(keyring.previous ?? [])].find((candidate) => candidate.keyId === payload.keyId);
  if (!key) throw new AuthFnPlacementContextInvalidError('Placement-bound auth context key is unknown');
  const expected = createHmac('sha256', key.secret).update(encoded).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AuthFnPlacementContextInvalidError();
  }
  const current = Math.floor(now().getTime() / 1000);
  if (payload.issuedAt > current + clockSkewSeconds || payload.expiresAt < current - clockSkewSeconds) {
    throw new AuthFnPlacementContextInvalidError('Placement-bound auth context is expired');
  }
  return payload;
}

function isSignedPlacementPayload(value: unknown): value is SignedPlacementContextPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.kind !== CONTEXT_KIND
    || typeof payload.keyId !== 'string'
    || typeof payload.subject !== 'string'
    || typeof payload.homeRegion !== 'string'
    || typeof payload.placementEpoch !== 'number'
    || !Number.isSafeInteger(payload.placementEpoch)
    || (payload.placementEpoch as number) < 1
    || typeof payload.issuer !== 'string'
    || typeof payload.sessionBinding !== 'string'
    || typeof payload.sessionVersion !== 'string'
    || typeof payload.authenticatedAt !== 'number'
    || !Number.isSafeInteger(payload.authenticatedAt)
    || typeof payload.issuedAt !== 'number'
    || !Number.isSafeInteger(payload.issuedAt)
    || typeof payload.expiresAt !== 'number'
    || !Number.isSafeInteger(payload.expiresAt)
    || (payload.expiresAt as number) < (payload.issuedAt as number)
    || (payload.expiresAt as number) - (payload.issuedAt as number) > MAX_TTL_SECONDS
    || typeof payload.audience !== 'string'
    || !Array.isArray(payload.assurance)
    || payload.assurance.some((entry) => typeof entry !== 'string')
    || typeof payload.requestId !== 'string'
    || (payload.actorType !== 'user' && payload.actorType !== 'api-key')
    || typeof payload.nonce !== 'string'
    || payload.nonce.length < 16
  ) {
    return false;
  }
  if (payload.scopes != null && (
    !Array.isArray(payload.scopes) || payload.scopes.some((entry) => typeof entry !== 'string')
  )) {
    return false;
  }
  if (payload.userId != null && typeof payload.userId !== 'string') return false;
  return true;
}

function stripClientRoutingHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  const keys: string[] = [];
  headers.forEach((_value, key) => keys.push(key));
  for (const key of keys) {
    if (key.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(key);
  }
  return new Proxy(request, {
    get(target, property, _receiver) {
      if (property === 'headers') {
        return headers;
      }
      if (property === 'clone') {
        return () => stripClientRoutingHeaders(new Request(target.clone(), {
          headers: new Headers(headers)
        }));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function readAuthorizationCredential(
  request: Request
): { scheme: 'bearer' | 'api-key'; secret: string } | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const trimmed = authorization.trim();
  const separator = trimmed.indexOf(' ');
  if (separator <= 0) return null;
  const scheme = trimmed.slice(0, separator).toLowerCase();
  const secret = trimmed.slice(separator + 1).trim();
  if (!secret) return null;
  if (scheme === 'bearer') return { scheme: 'bearer', secret };
  if (scheme === 'api-key') return { scheme: 'api-key', secret };
  return null;
}

function resolveAudience(audience: string, allowlist: readonly string[]): string {
  if (!audiencesIncludes(allowlist, audience)) {
    throw new AuthFnValidationError('Placement-bound auth context audience is not allowed');
  }
  return audience;
}

function audiencesIncludes(allowlist: readonly string[], audience: string): boolean {
  return allowlist.includes(audience);
}

function uniqueAudiences(audiences: readonly string[]): string[] {
  return [...new Set(audiences.map((audience) => audience.trim()).filter(Boolean))];
}

function credentialVersionMaterial(record: { id: string; createdAt: Date }): string {
  return `${record.id}:${record.createdAt.toISOString()}`;
}

function hmacOpaque(macKey: Buffer, label: string, value: string): string {
  // Keyed MAC over identifiers (user/session ids), not password storage.
  // codeql[js/insufficient-password-hash]
  return createHmac('sha256', macKey).update(`${label}:${value}`).digest('base64url');
}

function hashForTelemetry(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function secretBytes(secret: string | Uint8Array): Buffer {
  return Buffer.from(secret);
}

const SPECIAL_SCHEME_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ws:', 'wss:']);

function normalizeAuthority(authority: string | undefined): string {
  if (!authority) {
    throw new AuthFnConfigError('Placement-bound auth context requires publicAuthority');
  }
  try {
    const parsed = new URL(authority);
    const origin = parsed.origin;
    // Opaque origins (file:, mailto:) serialize as "null". blob: yields an inner
    // https origin but is not a network special scheme; reject it like Python.
    if (origin && origin !== 'null' && SPECIAL_SCHEME_PROTOCOLS.has(parsed.protocol)) {
      return origin;
    }
  } catch {
    // Malformed input that new URL cannot parse.
  }
  throw new AuthFnConfigError('AuthFn publicAuthority must be a valid origin');
}

function validateKeyring(keyring: AuthFnRoutingKeyring): void {
  const keys = [keyring.active, ...(keyring.previous ?? [])];
  const ids = new Set<string>();
  for (const key of keys) {
    const byteLength = typeof key.secret === 'string'
      ? Buffer.byteLength(key.secret)
      : key.secret.byteLength;
    if (!key.keyId.trim() || byteLength < 32) {
      throw new AuthFnConfigError('AuthFn routing keys require a keyId and at least 32 bytes of secret material');
    }
    if (ids.has(key.keyId)) {
      throw new AuthFnConfigError('AuthFn routing key IDs must be unique');
    }
    ids.add(key.keyId);
  }
}

async function emitRejection(
  config: AuthFnRuntimeConfig,
  request: Request,
  error: unknown,
  requestId: string
): Promise<void> {
  const code = readErrorCode(error);
  await emit(config, request, 'authfn.placement_context.rejected', {
    requestId,
    outcome: 'rejected',
    metadata: { errorType: code }
  });
}

async function emit(
  config: AuthFnRuntimeConfig,
  request: Request | undefined,
  type: AuthFnEventInput['type'],
  input: {
    requestId?: string;
    outcome?: string;
    regionId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await emitAuthEvent(config, {
    type,
    requestId: input.requestId ?? eventRequestId(request),
    regionId: input.regionId,
    actorId: input.actorId,
    outcome: input.outcome,
    metadata: input.metadata
  });
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'AUTHFN_INTERNAL_ERROR';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'AUTHFN_INTERNAL_ERROR';
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}
