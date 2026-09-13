import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WhereClause } from '@superfunctions/db';
import type {
  AuthFnAuthMethod,
  AuthFnRuntimeConfig,
  AuthFnHookContext,
  AuthFnHooks,
  AuthFnSession,
  AuthFnSessionRecord,
  AuthFnUserRecord
} from '../types.js';
import {
  AuthFnCsrfInvalidError,
  AuthFnError,
  AuthFnNotFoundError,
  AuthFnPluginAbortedError,
  AuthFnSessionExpiredError,
  AuthFnSessionRevokedError,
  AuthFnUnauthenticatedError
} from './errors.js';
import { authenticateApiKey as authenticateApiKeyRecord } from './api-keys.js';
import {
  readCookieValues,
  resolveCookiePolicy,
  resolveEnvironment,
  type AuthFnResolvedCookiePolicy
} from './cookies.js';
import { emitAuthEvent, eventRequestId } from './observability.js';
import { findUserById } from './users.js';

export interface IssueSessionInput {
  request?: Request;
  userId: string;
  primaryEmail?: string;
  tenantId?: string;
  regionId?: string;
  methods: AuthFnAuthMethod[];
  metadata?: Record<string, unknown>;
}

export interface IssuedSession {
  session: AuthFnSession;
  record: AuthFnSessionRecord;
  sessionToken: string;
  csrfToken: string;
  runtime?: Awaited<ReturnType<typeof resolveEnvironment>>;
  cookiePolicy?: AuthFnResolvedCookiePolicy;
}

export interface AuthenticatedRequestState {
  runtime: Awaited<ReturnType<typeof resolveEnvironment>>;
  cookiePolicy: AuthFnResolvedCookiePolicy;
  session?: AuthFnSession;
  sessionRecord?: AuthFnSessionRecord;
  user?: AuthFnUserRecord;
  sessionToken?: string;
  csrfToken?: string;
  failureReason?: 'missing' | 'expired' | 'revoked';
}

let lastIssuedTimestampMs = 0;

export async function issueSession(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  input: IssueSessionInput
): Promise<IssuedSession> {
  const runtime = input.request ? await resolveEnvironment(config, input.request) : undefined;
  const cookiePolicy = input.request ? resolveCookiePolicy(config, input.request, runtime) : undefined;

  const payload = await runBeforeSessionIssueHook(hooks, {
    config,
    request: input.request,
    environment: runtime,
    actorId: input.userId
  }, {
    userId: input.userId,
    primaryEmail: input.primaryEmail,
    tenantId: input.tenantId,
    regionId: input.regionId,
    methods: [...input.methods],
    metadata: input.metadata ?? {}
  });

  const now = nextIssuedAt();
  const sessionToken = createOpaqueToken('st');
  const csrfToken = createOpaqueToken('csrf');
  const record: AuthFnSessionRecord = {
    id: createOpaqueToken('sess'),
    userId: readString(payload.userId, 'userId'),
    tokenHash: hashSecret(sessionToken),
    csrfHash: hashSecret(csrfToken),
    methods: readMethods(payload.methods),
    metadata: readRecord(payload.metadata),
    expiresAt: new Date(now.getTime() + resolveSessionMaxAgeMs(config, cookiePolicy)),
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    lastAuthenticatedAt: now
  };

  await config.database.create<AuthFnSessionRecord>({
    model: 'sessions',
    data: record,
    namespace: namespace(config)
  });

  const user = await findUserById(config, record.userId);
  const session = buildUserSession(record, user ?? {
    id: record.userId,
    primaryEmail: readOptionalString(payload.primaryEmail),
    createdAt: now,
    updatedAt: now
  }, {
    tenantId: readOptionalString(payload.tenantId),
    regionId: readOptionalString(payload.regionId)
  });

  await hooks.afterSessionIssue?.({
    config,
    request: input.request,
    environment: runtime,
    actorId: session.actorId,
    session
  }, session);

  await emitAuthEvent(config, {
    type: 'authfn.session.issued',
    requestId: eventRequestId(input.request),
    actorId: session.actorId,
    sessionId: session.id,
    userId: session.actorId,
    regionId: session.regionId,
    outcome: 'issued',
    metadata: {
      methods: session.methods
    }
  });

  return {
    session,
    record,
    sessionToken,
    csrfToken,
    runtime,
    cookiePolicy
  };
}

export async function authenticateRequest(
  config: AuthFnRuntimeConfig,
  request: Request
): Promise<AuthFnSession | null> {
  const cookieState = await getCookieSessionState(config, request);
  if (cookieState.session) {
    return cookieState.session;
  }

  const credential = readAuthorizationCredential(request);
  if (!credential) {
    return null;
  }

  if (credential.scheme === 'bearer') {
    const session = await authenticateSessionToken(config, credential.secret, request);
    if (session) {
      return session;
    }
  }

  return authenticateApiKey(config, credential.secret);
}

export async function getCookieSessionState(
  config: AuthFnRuntimeConfig,
  request: Request,
  options?: { touch?: boolean; now?: () => Date }
): Promise<AuthenticatedRequestState> {
  const runtime = await resolveEnvironment(config, request);
  const cookiePolicy = resolveCookiePolicy(config, request, runtime);
  const cookieValues = readCookieValues(request, cookiePolicy);
  const state: AuthenticatedRequestState = {
    runtime,
    cookiePolicy,
    sessionToken: cookieValues.sessionToken,
    csrfToken: cookieValues.csrfToken
  };

  if (!cookieValues.sessionToken) {
    return {
      ...state,
      failureReason: 'missing'
    };
  }

  const record = await config.database.findOne<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'tokenHash', operator: 'eq', value: hashSecret(cookieValues.sessionToken) }],
    namespace: namespace(config)
  });

  if (!record) {
    return {
      ...state,
      failureReason: 'missing'
    };
  }

  if (record.revokedAt) {
    return {
      ...state,
      sessionRecord: record,
      failureReason: 'revoked'
    };
  }

  const nowMs = options?.now?.().getTime() ?? Date.now();
  if (record.expiresAt.getTime() <= nowMs) {
    return {
      ...state,
      sessionRecord: record,
      failureReason: 'expired'
    };
  }

  const user = await findUserById(config, record.userId);
  if (!user) {
    return {
      ...state,
      sessionRecord: record,
      failureReason: 'missing'
    };
  }

  const session = buildUserSession(record, user, {
    regionId: runtime.regionId
  });

  if (options?.touch === false) {
    return {
      ...state,
      session,
      sessionRecord: record,
      user
    };
  }

  const now = new Date();
  await config.database.update<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: record.id }],
    data: {
      lastAuthenticatedAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });

  return {
    ...state,
    session,
    sessionRecord: {
      ...record,
      lastAuthenticatedAt: now,
      updatedAt: now
    },
    user
  };
}

export async function requireCookieSession(
  config: AuthFnRuntimeConfig,
  request: Request
): Promise<AuthenticatedRequestState & {
  session: AuthFnSession;
  sessionRecord: AuthFnSessionRecord;
  user: AuthFnUserRecord;
}> {
  const state = await getCookieSessionState(config, request);

  if (state.failureReason === 'revoked') {
    throw new AuthFnSessionRevokedError();
  }

  if (state.failureReason === 'expired') {
    throw new AuthFnSessionExpiredError();
  }

  if (!state.session || !state.sessionRecord || !state.user) {
    throw new AuthFnUnauthenticatedError();
  }

  return state as AuthenticatedRequestState & {
    session: AuthFnSession;
    sessionRecord: AuthFnSessionRecord;
    user: AuthFnUserRecord;
  };
}

export function assertValidCsrf(
  request: Request,
  state: Pick<AuthenticatedRequestState, 'csrfToken' | 'sessionRecord'>
): void {
  const headerToken = request.headers.get('x-authfn-csrf');
  if (!headerToken || !state.csrfToken || !state.sessionRecord?.csrfHash) {
    throw new AuthFnCsrfInvalidError();
  }

  if (headerToken !== state.csrfToken) {
    throw new AuthFnCsrfInvalidError();
  }

  const expected = Buffer.from(state.sessionRecord.csrfHash);
  const actual = Buffer.from(hashSecret(headerToken));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthFnCsrfInvalidError();
  }
}

export async function listActiveSessionsForUser(
  config: AuthFnRuntimeConfig,
  user: AuthFnUserRecord,
  options?: { regionId?: string }
): Promise<AuthFnSession[]> {
  const records = await config.database.findMany<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'userId', operator: 'eq', value: user.id }],
    orderBy: [
      { field: 'createdAt', direction: 'asc' },
      { field: 'id', direction: 'asc' }
    ],
    namespace: namespace(config)
  });

  return records
    .filter((record) => isSessionActive(record))
    .sort(sortSessions)
    .map((record) => buildUserSession(record, user, { regionId: options?.regionId }));
}

export async function revokeSessionById(
  config: AuthFnRuntimeConfig,
  sessionId: string,
  options?: { userId?: string }
): Promise<AuthFnSessionRecord> {
  const record = await config.database.findOne<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: sessionId }],
    namespace: namespace(config)
  });

  if (!record) {
    throw new AuthFnNotFoundError('Session not found', { sessionId });
  }

  if (options?.userId && record.userId !== options.userId) {
    throw new AuthFnNotFoundError('Session not found', { sessionId });
  }

  if (record.revokedAt) {
    return record;
  }

  const revokedAt = new Date();
  await config.database.update<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: record.id }],
    data: {
      revokedAt,
      updatedAt: revokedAt
    },
    namespace: namespace(config)
  });

  return {
    ...record,
    revokedAt,
    updatedAt: revokedAt
  };
}

export async function revokeSessionsForUser(
  config: AuthFnRuntimeConfig,
  userId: string
): Promise<number> {
  const records = await config.database.findMany<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });

  let revoked = 0;
  for (const record of records) {
    if (record.revokedAt) {
      continue;
    }
    await revokeSessionById(config, record.id, { userId });
    revoked += 1;
  }

  return revoked;
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildUserSession(
  record: AuthFnSessionRecord,
  user: Pick<AuthFnUserRecord, 'id' | 'primaryEmail'>,
  options?: { tenantId?: string; regionId?: string }
): AuthFnSession {
  return {
    id: record.id,
    type: 'session',
    subject: {
      actorId: user.id,
      actorType: 'user',
      tenantId: options?.tenantId,
      regionId: options?.regionId,
      email: user.primaryEmail
    },
    actorType: 'user',
    actorId: user.id,
    tenantId: options?.tenantId,
    regionId: options?.regionId,
    resourceIds: [],
    primaryEmail: user.primaryEmail,
    methods: record.methods,
    expiresAt: record.expiresAt,
    metadata: record.metadata
  };
}

async function authenticateApiKey(
  config: AuthFnRuntimeConfig,
  secret: string
): Promise<AuthFnSession | null> {
  return authenticateApiKeyRecord(config, secret);
}

export async function authenticateSessionToken(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'plugins' | 'cookie' | 'environment'>,
  sessionToken: string,
  request?: Request
): Promise<AuthFnSession | null> {
  const record = await config.database.findOne<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'tokenHash', operator: 'eq', value: hashSecret(sessionToken) }],
    namespace: namespace(config)
  });
  if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  const user = await findUserById(config, record.userId);
  if (!user) {
    return null;
  }

  const runtime = request ? await resolveEnvironment(config, request) : undefined;
  const now = new Date();
  await config.database.update<AuthFnSessionRecord>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: record.id }],
    data: {
      lastAuthenticatedAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });

  return buildUserSession({
    ...record,
    lastAuthenticatedAt: now,
    updatedAt: now
  }, user, {
    regionId: runtime?.regionId
  });
}

function readAuthorizationCredential(request: Request): { scheme: 'bearer' | 'api-key'; secret: string } | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return null;
  }

  const trimmed = authorization.trim();
  if (trimmed.startsWith('Bearer ')) {
    const secret = trimmed.slice('Bearer '.length).trim();
    return secret
      ? {
          scheme: 'bearer',
          secret
        }
      : null;
  }

  if (trimmed.startsWith('Api-Key ')) {
    const secret = trimmed.slice('Api-Key '.length).trim();
    return secret
      ? {
          scheme: 'api-key',
          secret
        }
      : null;
  }

  return null;
}

function isSessionActive(record: AuthFnSessionRecord): boolean {
  if (record.revokedAt) {
    return false;
  }

  return record.expiresAt.getTime() > Date.now();
}

function sortSessions(left: AuthFnSessionRecord, right: AuthFnSessionRecord): number {
  const createdAtComparison = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function resolveSessionMaxAgeMs(
  config: Pick<AuthFnRuntimeConfig, 'cookie'>,
  cookiePolicy?: AuthFnResolvedCookiePolicy
): number {
  const seconds = cookiePolicy?.sessionMaxAgeSeconds ?? config.cookie?.sessionMaxAgeSeconds ?? 60 * 60 * 24 * 7;
  return seconds * 1000;
}

async function runBeforeSessionIssueHook(
  hooks: Partial<AuthFnHooks>,
  ctx: AuthFnHookContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!hooks.beforeSessionIssue) {
    return input;
  }

  try {
    const transformed = await hooks.beforeSessionIssue(ctx, input);
    return transformed ?? input;
  } catch (error) {
    if (error instanceof AuthFnError) {
      throw error;
    }
    throw new AuthFnPluginAbortedError('beforeSessionIssue hook aborted session issuance', {
      actorId: ctx.actorId,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthFnPluginAbortedError(`beforeSessionIssue hook returned an invalid ${field}`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readMethods(value: unknown): AuthFnAuthMethod[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AuthFnPluginAbortedError('beforeSessionIssue hook returned invalid methods');
  }

  return value as AuthFnAuthMethod[];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}

function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function createSessionWhere(field: string, value: string): WhereClause[] {
  return [{ field, operator: 'eq', value }];
}

function nextIssuedAt(): Date {
  const next = Math.max(Date.now(), lastIssuedTimestampMs + 1);
  lastIssuedTimestampMs = next;
  return new Date(next);
}
