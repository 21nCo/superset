import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnMultiRegionEnvironment, authFnMultiRegionPlugin } from '@authfn/multi-region';
import type { AuthFnEventInput, AuthFnRuntimeConfig } from '../index.js';
import {
  AuthFnApiKeyRevokedError,
  AuthFnConfigError,
  AuthFnPlacementContextInvalidError,
  AuthFnPlacementDirectoryUnavailableError,
  AuthFnPlacementMovingError,
  AuthFnRegionNotFoundError,
  AuthFnSessionExpiredError,
  AuthFnSessionRevokedError,
  AuthFnInternalError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from '../index.js';
import { issueSessionCookies } from '../core/cookies.js';
import {
  createAuthFnPlacementContextIssuer,
  createAuthFnPlacementContextVerifier,
  type AuthFnPlacementBoundAuthContext
} from '../core/placement-context.js';
import {
  createInMemoryAuthFnPlacementDirectory,
  tombstoneAuthFnIdentityPlacement
} from '../core/gateway-routing.js';
import { eventRequestId } from '../core/observability.js';
import { hashSecret, issueSession, revokeSessionById } from '../core/sessions.js';
import { createUser } from '../core/users.js';
import type { AuthFnIdentityPlacement, AuthFnRoutingKeyring } from '../plugin-types.js';

const SUBJECT_SECRET = 'placement-subject-secret-with-enough-entropy';
const keyring: AuthFnRoutingKeyring = {
  active: {
    keyId: 'context-2026-09',
    secret: 'test-context-secret-with-enough-entropy'
  }
};

describe('AuthFn placement-bound auth context', () => {
  it('derives immutable context only from a currently valid session and placement', async () => {
    const { issuer, request, user, events } = await setupIssuer();
    const context = await issuer.derive(request);

    expect(context.subject).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(context.subject).not.toContain(user.id);
    expect(context.subject).not.toContain('ada@example.com');
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.placementEpoch).toBe(4);
    expect(context.issuer).toBe('https://account.example.com');
    expect(context.audience).toBe('nucleum-datafn');
    expect(context.assurance).toEqual(['password']);
    expect(context.actorType).toBe('user');
    expect(context.userId).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('ada@example.com');
    expect(JSON.stringify(context)).not.toContain('cell://');
    expect(Object.isFrozen(context)).toBe(true);
    expect(events.filter((event) => event.type.startsWith('authfn.placement_context'))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'authfn.placement_context.issued',
        outcome: 'success',
        regionId: 'us-east-1'
      })
    ]));
    expect(JSON.stringify(events.filter((event) => event.type.startsWith('authfn.placement_context'))))
      .not.toContain('ada@example.com');
    expect(JSON.stringify(events.filter((event) => event.type.startsWith('authfn.placement_context'))))
      .not.toContain(user.id);
  });

  it('ignores client-supplied subject, region, epoch, issuer, and routing headers', async () => {
    const { issuer, request } = await setupIssuer({
      extraHeaders: {
        'x-authfn-routing-region': 'eu-west-1',
        'x-authfn-routing-epoch': '99',
        'x-authfn-routing-assertion': 'forged',
        'x-authfn-home-region': 'eu-west-1'
      }
    });
    const spoofed = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({
        subject: 'client-subject',
        homeRegion: 'eu-west-1',
        placementEpoch: 99,
        issuer: 'https://evil.example.com',
        audience: 'attacker'
      })
    });

    const context = await issuer.derive(spoofed);
    expect(context.subject).not.toBe('client-subject');
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.placementEpoch).toBe(4);
    expect(context.issuer).toBe('https://account.example.com');
    expect(context.audience).toBe('nucleum-datafn');
  });

  it('preserves runtime request state while sanitizing routing headers', async () => {
    const bound = await setupIssuer({
      extraHeaders: { 'x-authfn-routing-region': 'eu-west-1' }
    });
    const request = bound.request as Request & { cf?: { colo: string } };
    request.cf = { colo: 'SFO' };
    let seenColo: string | undefined;
    let seenRouting: string | null = 'present';
    bound.config.environment = {
      async resolve(incoming) {
        seenColo = (incoming as Request & { cf?: { colo: string } }).cf?.colo;
        seenRouting = incoming.headers.get('x-authfn-routing-region');
        expect(incoming.url).toBe(request.url);
        expect(incoming.method).toBe(request.method);
        expect(incoming.bodyUsed).toBe(request.bodyUsed);
        expect(incoming.signal).toBe(request.signal);
        const cloned = incoming.clone();
        expect(cloned.headers.get('x-authfn-routing-region')).toBeNull();
        expect(cloned.headers.get('cookie')).toBe(request.headers.get('cookie'));
        expect(cloned.headers.get('x-request-id')).toBe(incoming.headers.get('x-request-id'));
        return { issuer: 'https://account.example.com', baseUrl: 'https://account.example.com' };
      }
    };
    const context = await bound.issuer.derive(request);
    expect(context.homeRegion).toBe('us-east-1');
    expect(seenColo).toBe('SFO');
    expect(seenRouting).toBeNull();
  });

  it('derives when no custom environment resolver is configured', async () => {
    const bound = await setupIssuer();
    bound.config.environment = undefined;
    const context = await bound.issuer.derive(bound.request);
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.issuer).toBe('https://account.example.com');
  });

  it('treats whitespace-only request ids as absent', async () => {
    const bound = await setupIssuer({
      extraHeaders: { 'x-request-id': '   ' }
    });
    const context = await bound.issuer.derive(bound.request);
    expect(context.requestId.trim()).not.toBe('');
    expect(context.requestId).not.toBe('   ');
    const issued = bound.events.find((event) => event.type === 'authfn.placement_context.issued');
    expect(issued?.requestId).toBe(context.requestId);
  });

  it('fails closed for unauthenticated, revoked, expired, and deleted identities', async () => {
    const unauthenticated = await setupIssuer();
    await expect(unauthenticated.issuer.derive(new Request('https://account.example.com/auth/session')))
      .rejects.toBeInstanceOf(AuthFnUnauthenticatedError);

    const revoked = await setupIssuer();
    await revokeSessionById(revoked.config, revoked.sessionId, { userId: revoked.user.id });
    await expect(revoked.issuer.derive(revoked.request)).rejects.toBeInstanceOf(AuthFnSessionRevokedError);

    const expired = await setupIssuer();
    await expired.config.database.update({
      model: 'sessions',
      where: [{ field: 'id', operator: 'eq', value: expired.sessionId }],
      data: { expiresAt: new Date(Date.now() - 1_000) },
      namespace: 'authfn'
    });
    await expect(expired.issuer.derive(expired.request)).rejects.toBeInstanceOf(AuthFnSessionExpiredError);

    const deleted = await setupIssuer();
    await deleted.config.database.delete({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: deleted.user.id }],
      namespace: 'authfn'
    });
    await expect(deleted.issuer.derive(deleted.request)).rejects.toBeInstanceOf(AuthFnUnauthenticatedError);
  });

  it('fails closed for moving, deleting, tombstoned, missing, and unavailable placement', async () => {
    await expect(deriveWithPlacement({
      identityKey: 'person:ada',
      regionId: 'us-east-1',
      epoch: 5,
      state: 'moving',
      updatedAt: '2026-09-04T00:00:00.000Z'
    })).rejects.toBeInstanceOf(AuthFnPlacementMovingError);

    await expect(deriveWithPlacement({
      identityKey: 'person:ada',
      regionId: 'us-east-1',
      epoch: 5,
      state: 'deleting',
      updatedAt: '2026-09-04T00:00:00.000Z'
    })).rejects.toBeInstanceOf(AuthFnPlacementMovingError);

    const tombstoned = await setupIssuer();
    await tombstoneAuthFnIdentityPlacement(tombstoned.directory, `person:${tombstoned.user.id}`);
    await expect(tombstoned.issuer.derive(tombstoned.request)).rejects.toBeInstanceOf(AuthFnRegionNotFoundError);

    const missing = await setupIssuer({ skipPlacement: true });
    await expect(missing.issuer.derive(missing.request)).rejects.toBeInstanceOf(AuthFnRegionNotFoundError);

    const unavailable = await setupIssuer({
      directory: {
        async get() {
          throw new Error('directory down');
        },
        async putIfAbsent() {
          throw new Error('directory down');
        },
        async compareAndSet() {
          throw new Error('directory down');
        }
      }
    });
    await expect(unavailable.issuer.derive(unavailable.request))
      .rejects.toBeInstanceOf(AuthFnPlacementDirectoryUnavailableError);

    const malformed = await setupIssuer({
      directory: {
        async get() {
          return {
            identityKey: 'person:ada',
            regionId: 123 as unknown as string,
            epoch: 4,
            state: 'active',
            updatedAt: '2026-09-04T00:00:00.000Z'
          };
        },
        async putIfAbsent() {
          return { inserted: false };
        },
        async compareAndSet() {
          return { updated: false };
        }
      },
      identityKey: 'person:ada'
    });
    await expect(malformed.issuer.derive(malformed.request))
      .rejects.toBeInstanceOf(AuthFnPlacementDirectoryUnavailableError);

    const padded = await setupIssuer();
    const paddedIssuer = createAuthFnPlacementContextIssuer({
      config: padded.config,
      regionId: '  us-east-1  ',
      subjectSecret: SUBJECT_SECRET,
      audiences: ['nucleum-datafn'],
      publicAuthority: 'https://account.example.com',
      placementDirectory: padded.directory,
      identityKeyForUserId: (userId) => `person:${userId}`,
      keyring
    });
    expect((await paddedIssuer.derive(padded.request)).homeRegion).toBe('us-east-1');

    const paddedRecord = await setupIssuer({ regionId: '  us-east-1  ' });
    expect((await paddedRecord.issuer.derive(paddedRecord.request)).homeRegion).toBe('us-east-1');
  });

  it('refuses a client-selected audience and omits raw user IDs unless opted in', async () => {
    const denied = await setupIssuer();
    await expect(denied.issuer.derive(denied.request, { audience: 'other-service' }))
      .rejects.toBeInstanceOf(AuthFnValidationError);
    expect(denied.events.filter((event) => event.type === 'authfn.placement_context.rejected')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'authfn.placement_context.rejected',
          outcome: 'rejected',
          metadata: expect.objectContaining({ errorType: 'AUTHFN_VALIDATION_ERROR' })
        })
      ])
    );

    const identified = await setupIssuer({ includeUserId: true });
    const context = await identified.issuer.derive(identified.request);
    expect(context.userId).toBe(identified.user.id);
  });

  it('signs a private-service assertion, verifies with rotated keys, and expires it', async () => {
    let nowMs = Date.parse('2026-09-04T12:00:00.000Z');
    const previous = {
      keyId: 'context-2026-08',
      secret: 'previous-context-secret-with-enough-bytes'
    };
    const { issuer, request, user } = await setupIssuer({
      keyring: {
        active: previous,
        previous: []
      },
      now: () => new Date(nowMs)
    });
    const issued = await issuer.issueSigned(request);
    expect(issued.assertion.includes('.')).toBe(true);
    expect(issued.assertion).not.toContain(user.id);
    expect(issued.assertion).not.toContain('ada@example.com');

    const rotated = await setupIssuer({
      keyring: {
        active: keyring.active,
        previous: [previous]
      },
      now: () => new Date(nowMs)
    });
    const verified = rotated.issuer.verifySigned(issued.assertion);
    expect(verified.subject).toBe(issued.context.subject);
    expect(verified.homeRegion).toBe('us-east-1');
    expect(verified.placementEpoch).toBe(4);

    nowMs += 70_000;
    const expiredIssuer = await setupIssuer({
      keyring: {
        active: previous,
        previous: []
      },
      now: () => new Date(nowMs)
    });
    expect(() => expiredIssuer.issuer.verifySigned(issued.assertion))
      .toThrow(AuthFnPlacementContextInvalidError);

    const forged = issued.assertion.replace(/[A-Za-z0-9_-]+$/, 'forgedsignature');
    expect(() => issuer.verifySigned(forged)).toThrow(AuthFnPlacementContextInvalidError);
  });

  it('keeps already-issued grants valid until expiry after logout while blocking new grants', async () => {
    let nowMs = Date.parse('2026-09-04T12:00:00.000Z');
    const { issuer, request, config, sessionId, user } = await setupIssuer({
      now: () => new Date(nowMs)
    });
    const issued = await issuer.issueSigned(request);
    await revokeSessionById(config, sessionId, { userId: user.id });

    await expect(issuer.derive(request)).rejects.toBeInstanceOf(AuthFnSessionRevokedError);
    expect(issuer.verifySigned(issued.assertion).sessionBinding).toBe(issued.context.sessionBinding);
  });

  it('rejects an old-region session after a placement change', async () => {
    const { issuer, request, directory, user } = await setupIssuer();
    const first = await issuer.derive(request);
    expect(first.placementEpoch).toBe(4);

    await directory.compareAndSet({
      identityKey: `person:${user.id}`,
      expectedEpoch: 4,
      expectedState: 'active',
      placement: {
        identityKey: `person:${user.id}`,
        regionId: 'eu-west-1',
        epoch: 6,
        state: 'active',
        previousRegionId: 'us-east-1',
        updatedAt: '2026-09-04T13:00:00.000Z'
      }
    });

    // The old region must not turn a still-valid stale copy into a new-region grant.
    await expect(issuer.derive(request)).rejects.toBeInstanceOf(AuthFnPlacementMovingError);
    expect(first.homeRegion).toBe('us-east-1');
  });

  it('rejects an old-region session when the new region has revoked its copy', async () => {
    const old = await setupIssuer();
    const identityKey = `person:${old.user.id}`;
    await old.directory.compareAndSet({ identityKey, expectedEpoch: 4, expectedState: 'active',
      placement: { identityKey, regionId: 'eu-west-1', epoch: 6, state: 'active', updatedAt: new Date().toISOString() } });
    const regionalDatabase = memoryAdapter({ debug: false });
    await regionalDatabase.create({ model: 'users', namespace: 'authfn', data: old.user });
    const session = await old.config.database.findOne({ model: 'sessions', namespace: 'authfn',
      where: [{ field: 'id', operator: 'eq', value: old.sessionId }] });
    await regionalDatabase.create({ model: 'sessions', namespace: 'authfn', data: { ...session, revokedAt: new Date() } });
    const current = createAuthFnPlacementContextIssuer({
      config: { ...old.config, database: regionalDatabase }, regionId: 'eu-west-1',
      subjectSecret: SUBJECT_SECRET, audiences: ['nucleum-datafn'], publicAuthority: 'https://account.example.com',
      placementDirectory: old.directory, identityKeyForUserId: (id) => `person:${id}`,
    });
    await expect(old.issuer.derive(old.request)).rejects.toBeInstanceOf(AuthFnPlacementMovingError);
    await expect(current.derive(old.request)).rejects.toBeInstanceOf(AuthFnSessionRevokedError);
  });

  it('exchanges in-process context for a mock DataFn ticket without exposing cell destinations', async () => {
    const us = await setupIssuer({ regionId: 'us-east-1', email: 'ada@example.com' });
    const eu = await setupIssuer({ regionId: 'eu-west-1', email: 'grace@example.com' });
    const tickets = {
      async mint(context: AuthFnPlacementBoundAuthContext) {
        return {
          audience: 'datafn-sync',
          regionId: context.homeRegion,
          epoch: context.placementEpoch,
          subject: context.subject,
          expiresAt: context.expiresAt
        };
      }
    };

    const usTicket = await us.issuer.withContext(us.request, (context) => tickets.mint(context));
    const euTicket = await eu.issuer.withContext(eu.request, (context) => tickets.mint(context));

    expect(usTicket.regionId).toBe('us-east-1');
    expect(euTicket.regionId).toBe('eu-west-1');
    expect(usTicket.subject).not.toBe(euTicket.subject);
    expect(JSON.stringify(usTicket)).not.toContain('cell://');
    expect(JSON.stringify(usTicket)).not.toContain('ada@example.com');
  });

  it('supports a private remote consumer that verifies an audience-bound assertion', async () => {
    const gateway = await setupIssuer({ regionId: 'eu-west-1', email: 'grace@example.com' });
    const issued = await gateway.issuer.issueSigned(gateway.request);
    const remote = createAuthFnPlacementContextVerifier({
      audiences: ['nucleum-datafn'],
      publicAuthority: 'https://account.example.com',
      keyring,
      config: gateway.config
    });

    const verified = remote.verifySigned(issued.assertion);
    expect(verified.homeRegion).toBe('eu-west-1');
    expect(verified.audience).toBe('nucleum-datafn');
    expect(verified.requestId).toBe(issued.context.requestId);
    await Promise.resolve();
    expect(gateway.events.filter((event) => event.type === 'authfn.placement_context.verified')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'authfn.placement_context.verified',
          requestId: issued.context.requestId
        })
      ])
    );
    expect(() => remote.verifySigned(issued.assertion, { audience: 'other-service' }))
      .toThrow(AuthFnPlacementContextInvalidError);
  });

  it('derives context after the caller has already consumed the request body', async () => {
    const { issuer, request } = await setupIssuer();
    const posted = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ note: 'already-read' })
    });
    await posted.json();
    const context = await issuer.derive(posted);
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.placementEpoch).toBe(4);
  });

  it('binds API-key grants to the owning user placement and rejects unbound keys', async () => {
    const bound = await setupIssuer();
    await bound.config.database.create({
      model: 'api_keys',
      namespace: 'authfn',
      data: {
        id: 'key_bound',
        userId: bound.user.id,
        name: 'gateway',
        secretHash: hashSecret('secret_bound'),
        scopes: ['sync'],
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    const context = await bound.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: 'Bearer secret_bound' }
    }));
    expect(context.actorType).toBe('api-key');
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.scopes).toEqual(['sync']);

    await bound.config.database.create({
      model: 'api_keys',
      namespace: 'authfn',
      data: {
        id: 'key_empty_scopes',
        userId: bound.user.id,
        name: 'empty-scopes',
        secretHash: hashSecret('secret_empty_scopes'),
        scopes: [],
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    const emptyScopes = await bound.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: 'Bearer secret_empty_scopes' }
    }));
    expect(emptyScopes.scopes).toEqual([]);

    await bound.config.database.create({
      model: 'api_keys',
      namespace: 'authfn',
      data: {
        id: 'key_unbound',
        name: 'orphan',
        secretHash: hashSecret('secret_unbound'),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    await expect(bound.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: 'Bearer secret_unbound' }
    }))).rejects.toBeInstanceOf(AuthFnUnauthenticatedError);

    await bound.config.database.update({
      model: 'api_keys',
      where: [{ field: 'id', operator: 'eq', value: 'key_bound' }],
      data: { revokedAt: new Date() },
      namespace: 'authfn'
    });
    await expect(bound.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: 'Bearer secret_bound' }
    }))).rejects.toBeInstanceOf(AuthFnApiKeyRevokedError);
  });

  it('falls back to a valid authorization credential when the cookie is stale', async () => {
    const stale = await setupIssuer();
    const fresh = await issueSession(stale.config, {}, {
      request: new Request('https://account.example.com/auth/session'),
      userId: stale.user.id,
      primaryEmail: stale.user.primaryEmail,
      methods: ['password'],
      regionId: 'us-east-1'
    });
    await revokeSessionById(stale.config, stale.sessionId, { userId: stale.user.id });

    await expect(stale.issuer.derive(stale.request)).rejects.toBeInstanceOf(AuthFnSessionRevokedError);

    const mixed = new Request('https://account.example.com/auth/session', {
      headers: {
        cookie: stale.request.headers.get('cookie') ?? '',
        authorization: `Bearer ${fresh.sessionToken}`
      }
    });
    const context = await stale.issuer.derive(mixed);
    const bearerOnly = await stale.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: `Bearer ${fresh.sessionToken}` }
    }));
    expect(context.homeRegion).toBe('us-east-1');
    expect(context.sessionBinding).toBe(bearerOnly.sessionBinding);
  });

  it('falls back to the stale-cookie error after an authorization miss', async () => {
    const stale = await setupIssuer();
    await revokeSessionById(stale.config, stale.sessionId, { userId: stale.user.id });
    const mixed = new Request('https://account.example.com/auth/session', {
      headers: {
        cookie: stale.request.headers.get('cookie') ?? '',
        authorization: 'Bearer not-a-real-secret'
      }
    });
    await expect(stale.issuer.derive(mixed)).rejects.toBeInstanceOf(AuthFnSessionRevokedError);
  });

  it('uses stored authentication time for cookie and bearer of the same session', async () => {
    const setup = await setupIssuer();
    const authenticatedAt = new Date('2026-09-01T00:00:00.000Z');
    await setup.config.database.update({
      model: 'sessions',
      where: [{ field: 'id', operator: 'eq', value: setup.sessionId }],
      data: { lastAuthenticatedAt: authenticatedAt, updatedAt: authenticatedAt },
      namespace: 'authfn'
    });

    const cookieContext = await setup.issuer.derive(setup.request);
    const bearerContext = await setup.issuer.derive(new Request('https://account.example.com/auth/session', {
      headers: { authorization: `Bearer ${setup.sessionToken}` }
    }));
    const again = await setup.issuer.derive(setup.request);

    expect(cookieContext.authenticatedAt).toBe(authenticatedAt.toISOString());
    expect(bearerContext.authenticatedAt).toBe(authenticatedAt.toISOString());
    expect(again.authenticatedAt).toBe(authenticatedAt.toISOString());
    expect(again.sessionVersion).toBe(cookieContext.sessionVersion);
  });

  it('rejects opaque publicAuthority origins', async () => {
    const setup = await setupIssuer();
    const options = {
      config: setup.config,
      regionId: 'us-east-1',
      subjectSecret: SUBJECT_SECRET,
      audiences: ['nucleum-datafn'] as const,
      placementDirectory: setup.directory,
      identityKeyForUserId: (userId: string) => `person:${userId}`
    };
    expect(() => createAuthFnPlacementContextIssuer({
      ...options,
      publicAuthority: 'file://auth.example'
    })).toThrow(AuthFnConfigError);
    expect(() => createAuthFnPlacementContextIssuer({
      ...options,
      publicAuthority: 'mailto:auth@example.com'
    })).toThrow(AuthFnConfigError);
    expect(() => createAuthFnPlacementContextIssuer({
      ...options,
      publicAuthority: 'blob:https://account.example.com'
    })).toThrow(AuthFnConfigError);
  });

  it('rejects compound IDNA publicAuthority failures', async () => {
    const setup = await setupIssuer();
    const options = {
      config: setup.config,
      regionId: 'us-east-1',
      subjectSecret: SUBJECT_SECRET,
      audiences: ['nucleum-datafn'] as const,
      placementDirectory: setup.directory,
      identityKeyForUserId: (userId: string) => `person:${userId}`
    };
    expect(() => createAuthFnPlacementContextIssuer({
      ...options,
      publicAuthority: 'https://-a\u200db.example'
    })).toThrow(AuthFnConfigError);
    expect(() => createAuthFnPlacementContextIssuer({
      ...options,
      publicAuthority: 'https://-\u05d0a.example'
    })).toThrow(AuthFnConfigError);
  });

  it('keeps API-key sessionVersion stable across reuse', async () => {
    const bound = await setupIssuer();
    await bound.config.database.create({
      model: 'api_keys',
      namespace: 'authfn',
      data: {
        id: 'key_stable',
        userId: bound.user.id,
        name: 'gateway',
        secretHash: hashSecret('secret_stable'),
        scopes: ['sync'],
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z')
      }
    });
    const request = new Request('https://account.example.com/auth/session', {
      headers: { authorization: 'Bearer secret_stable' }
    });
    const first = await bound.issuer.derive(request);
    await bound.config.database.update({
      model: 'api_keys',
      where: [{ field: 'id', operator: 'eq', value: 'key_stable' }],
      data: { lastUsedAt: new Date('2026-09-04T12:00:00.000Z'), updatedAt: new Date('2026-09-04T12:00:00.000Z') },
      namespace: 'authfn'
    });
    const second = await bound.issuer.derive(request);
    expect(second.sessionVersion).toBe(first.sessionVersion);
    expect(second.sessionBinding).toBe(first.sessionBinding);
  });

  it('reuses the original request correlation id when none is provided', async () => {
    const { issuer, request } = await setupIssuer();
    const context = await issuer.derive(request);
    expect(context.requestId).toBe(eventRequestId(request));
  });

  it('accepts lowercase authorization schemes', async () => {
    const bound = await setupIssuer();
    await bound.config.database.create({
      model: 'api_keys',
      data: {
        id: 'key_lower',
        secretHash: hashSecret('secret_lower'),
        userId: bound.user.id,
        name: 'lower',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z')
      },
      namespace: 'authfn'
    });
    const context = await bound.issuer.derive(new Request(bound.request.url, {
      headers: { authorization: 'bearer secret_lower' }
    }));
    expect(context.actorType).toBe('api-key');
    expect(context.homeRegion).toBe('us-east-1');
  });

  it('preserves operational failures during API-key lookup', async () => {
    const bound = await setupIssuer();
    const original = bound.config.database.findOne.bind(bound.config.database);
    bound.config.database.findOne = async (params) => {
      if (params.model === 'api_keys') {
        throw new Error('placement-directory database unavailable');
      }
      return original(params);
    };
    await expect(bound.issuer.derive(new Request(bound.request.url, {
      headers: { authorization: 'Api-Key secret_missing' }
    }))).rejects.toBeInstanceOf(AuthFnInternalError);
  });

  it('evaluates cookie and bearer expiry against the issuer clock', async () => {
    const expiresAt = new Date(Date.now() - 60_000);
    const issuerNow = () => new Date(expiresAt.getTime() - 60_000);
    const setup = await setupIssuer({ now: issuerNow });
    await setup.config.database.update({
      model: 'sessions',
      where: [{ field: 'id', operator: 'eq', value: setup.sessionId }],
      data: { expiresAt },
      namespace: 'authfn'
    });
    const cookieContext = await setup.issuer.derive(setup.request);
    const bearerContext = await setup.issuer.derive(new Request(setup.request.url, {
      headers: { authorization: `Bearer ${setup.sessionToken}` }
    }));
    expect(cookieContext.homeRegion).toBe('us-east-1');
    expect(bearerContext.sessionBinding).toBe(cookieContext.sessionBinding);

    const expiredIssuer = await setupIssuer({ now: () => new Date(expiresAt.getTime() + 1_000) });
    await expiredIssuer.config.database.update({
      model: 'sessions',
      where: [{ field: 'id', operator: 'eq', value: expiredIssuer.sessionId }],
      data: { expiresAt },
      namespace: 'authfn'
    });
    await expect(expiredIssuer.issuer.derive(expiredIssuer.request))
      .rejects.toBeInstanceOf(AuthFnSessionExpiredError);
    await expect(expiredIssuer.issuer.derive(new Request(expiredIssuer.request.url, {
      headers: { authorization: `Bearer ${expiredIssuer.sessionToken}` }
    }))).rejects.toBeInstanceOf(AuthFnSessionExpiredError);
  });

  it('keeps the signed request id on post-signature verification failures', async () => {
    const { issuer, request, events } = await setupIssuer();
    const issued = await issuer.issueSigned(request);
    expect(() => issuer.verifySigned(issued.assertion, { audience: 'other-service' }))
      .toThrow(AuthFnPlacementContextInvalidError);
    await Promise.resolve();
    expect(events.filter((event) => event.type === 'authfn.placement_context.verification_failed')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: issued.context.requestId,
          metadata: expect.objectContaining({ audience: 'other-service' })
        })
      ])
    );
  });
});

async function deriveWithPlacement(placement: AuthFnIdentityPlacement) {
  const setup = await setupIssuer({
    directory: createInMemoryAuthFnPlacementDirectory([placement]),
    identityKey: placement.identityKey
  });
  return setup.issuer.derive(setup.request);
}

async function setupIssuer(options?: {
  regionId?: string;
  email?: string;
  extraHeaders?: Record<string, string>;
  includeUserId?: boolean;
  skipPlacement?: boolean;
  directory?: ReturnType<typeof createInMemoryAuthFnPlacementDirectory> | {
    get: () => Promise<AuthFnIdentityPlacement | null>;
    putIfAbsent: () => Promise<{ inserted: boolean }>;
    compareAndSet: () => Promise<{ updated: boolean }>;
  };
  identityKey?: string;
  keyring?: AuthFnRoutingKeyring;
  now?: () => Date;
}) {
  const events: AuthFnEventInput[] = [];
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [authFnApiKeyPlugin(), authFnMultiRegionPlugin()],
    environment: authFnMultiRegionEnvironment({
      routing: {
        mode: 'gateway',
        publicAuthority: 'https://account.example.com',
        placementDirectory: createInMemoryAuthFnPlacementDirectory(),
        identityKeyForIdentifier: (identifier) => identifier,
        identityKeyForUserId: (userId) => `person:${userId}`
      }
    }),
    observability: {
      events: {
        emit(event) {
          events.push(event);
        }
      }
    }
  };
  const user = await createUser(config, { primaryEmail: options?.email ?? 'ada@example.com' });
  const identityKey = options?.identityKey ?? `person:${user.id}`;
  const directory = options?.directory ?? createInMemoryAuthFnPlacementDirectory(
    options?.skipPlacement
      ? []
      : [{
          identityKey,
          regionId: options?.regionId ?? 'us-east-1',
          epoch: 4,
          state: 'active',
          updatedAt: '2026-09-04T00:00:00.000Z'
        }]
  );
  const issued = await issueSession(config, {}, {
    request: new Request('https://account.example.com/auth/session'),
    userId: user.id,
    primaryEmail: user.primaryEmail,
    methods: ['password'],
    regionId: options?.regionId ?? 'us-east-1'
  });
  const cookies = issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken);
  const request = new Request('https://account.example.com/auth/session', {
    headers: {
      cookie: cookieHeaderFromSetCookies(Object.values(cookies)),
      ...(options?.extraHeaders ?? {})
    }
  });
  const issuer = createAuthFnPlacementContextIssuer({
    config,
    regionId: options?.regionId ?? 'us-east-1',
    subjectSecret: SUBJECT_SECRET,
    audiences: ['nucleum-datafn'],
    publicAuthority: 'https://account.example.com',
    placementDirectory: directory,
    identityKeyForUserId: (userId) => options?.identityKey ?? `person:${userId}`,
    keyring: options?.keyring ?? keyring,
    includeUserId: options?.includeUserId,
    now: options?.now
  });
  return {
    issuer,
    request,
    user,
    config,
    directory,
    events,
    sessionId: issued.session.id,
    sessionToken: issued.sessionToken
  };
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(';')))
    .join('; ');
}


it('keeps identity claims stable for shared issuer keys and changes them on identity-key rotation', async () => {
  const original = await setupIssuer();
  const make = (subjectSecret: string) => createAuthFnPlacementContextIssuer({
    config: original.config, regionId: 'us-east-1', subjectSecret, audiences: ['nucleum-datafn'],
    publicAuthority: 'https://account.example.com', placementDirectory: original.directory,
    identityKeyForUserId: id => `person:${id}`,
  });
  const first = await original.issuer.derive(original.request);
  const shared = await make(SUBJECT_SECRET).derive(original.request);
  const rotated = await make('a-different-subject-key-at-least-32-bytes').derive(original.request);
  for (const claim of ['subject', 'sessionBinding', 'sessionVersion'] as const) {
    expect(shared[claim]).toBe(first[claim]);
    expect(rotated[claim]).not.toBe(first[claim]);
  }
});
