---
title: Observability
description: Every meaningful action in authfn emits a structured event. Wire one callback and you have audit, metrics, and tracing.
---

# Observability

authfn emits a structured event for every meaningful action — sign-up, sign-in, OTP send, OAuth callback, region lookup, plugin failure, rate-limit. You provide one callback at construction; the kernel does the rest.

```ts
createAuthFn({
  // ...
  observability: {
    emit(event) {
      myLogger.info(event.type, {
        requestId: event.requestId,
        userId: event.userId,
        ...event.metadata,
      });
    },
  },
});
```

`emit` may be sync or async. Returned promises are awaited so a slow audit pipeline can backpressure the kernel — though in practice you'll typically push to a queue (Kafka, Kinesis, EventBridge, …) rather than block on a remote write.

## Event shape

```ts
interface AuthFnEvent {
  type: AuthFnEventType;
  requestId: string;
  actorId?: string;
  sessionId?: string;
  userId?: string;
  regionId?: string;
  provider?: 'google' | 'apple' | 'github';
  pluginName?: string;
  hookName?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}
```

- **`type`** is one of the codes below.
- **`requestId`** correlates with the same id in the response envelope and any inbound `X-Request-Id` header.
- **`actorId`** is the user or API key that authenticated the request, if known.
- **`userId`** is the user *affected by* the action, if different from `actorId` (e.g. for admin actions).
- **`metadata`** is a sanitized dictionary of additional context. Tokens, secrets, and authorization headers are *redacted* before they leave the kernel — see [Redaction](#redaction) below.

## All events

| Event | When |
| --- | --- |
| `authfn.user.created` | A user record was just persisted. |
| `authfn.account_linked` | Two identities were linked into one user. |
| `authfn.account_linking.conflict` | A link was attempted but the policy declined. |
| `authfn.account.deleted` | A user was deleted. Carries cascade counts in `metadata`. |
| `authfn.password.signup.rollback_failed` | A password sign-up failed mid-write and the rollback could not be completed cleanly. |
| `authfn.session.issued` | A session was just issued. |
| `authfn.session.revoked` | A session was just revoked. |
| `authfn.otp.sent` | An OTP was generated and handed to delivery. |
| `authfn.otp.verified` | An OTP was successfully verified. |
| `authfn.otp.signup.rollback_failed` | An OTP sign-up failed mid-write and rollback failed. |
| `authfn.oauth.started` | OAuth flow initiated; state persisted. |
| `authfn.oauth.completed` | OAuth callback succeeded; identity resolved. |
| `authfn.oauth.failed` | OAuth callback failed (provider error, callback mismatch, state replay). |
| `authfn.api_key.created` | An API key was issued. |
| `authfn.api_key.revoked` | An API key was revoked. |
| `authfn.2fa.enabled` | A user enrolled in 2FA. |
| `authfn.2fa.challenged` | A 2FA challenge was issued (`primaryMethod` carried). |
| `authfn.region.lookup` | Multi-region lookup succeeded. |
| `authfn.region.lookup.conflict` | Multi-region registration lost a race. |
| `authfn.routing.placement_lookup` | Canonical placement was read/validated, or placement state rejected execution. |
| `authfn.routing.placement_claimed` | A first-use placement claim won and established the canonical owner. |
| `authfn.routing.forwarded` | The gateway dispatched to a private cell. |
| `authfn.routing.mismatch` | A cell proved a stale routing assertion before side effects. |
| `authfn.routing.retry` | The gateway refreshed placement and started its single retry. |
| `authfn.routing.assertion_rejected` | A cell rejected a routing assertion before execution. |
| `authfn.routing.directory_unavailable` | Placement storage failed closed. |
| `authfn.routing.cell_unavailable` | Cell resolution or internal dispatch failed. |
| `authfn.placement_context.issued` | Trusted consumer code derived placement-bound auth context. |
| `authfn.placement_context.rejected` | Context derivation failed closed. |
| `authfn.placement_context.verified` | A private-service placement assertion verified. |
| `authfn.placement_context.verification_failed` | Signed placement context failed signature, audience, issuer, or expiry checks. |
| `authfn.handoff.started` | Native handoff code created. |
| `authfn.handoff.exchanged` | Native handoff code exchanged for a session. |
| `authfn.handoff.failed` | Native handoff exchange failed. |
| `authfn.rate_limited` | A request was rate-limited. |
| `authfn.request.failed` | A request returned an error envelope. |
| `authfn.plugin.failed` | A plugin hook threw under `'observe'` policy. |

## Redaction

The kernel redacts before emitting. Anything keyed `token`, `secret`, `authorization`, `bearer`, `password`, or `key` (case-insensitive) in the metadata is replaced with `[REDACTED]`. Nested objects are walked recursively. This matches the redaction applied to OAuth error details when they bubble out as `AuthFn*Error`.

If you add to `metadata` from a hook, follow the same rule: never include secrets. The kernel won't redact secrets you pass under unrecognized keys.

## Request correlation

Every event for a single inbound request shares the same `requestId`. The `requestId` is also:

- the value returned in the response envelope,
- echoed in the `X-Request-Id` response header,
- preserved if the inbound request supplied `X-Request-Id` itself.

This means you can correlate an authfn server-side error with the exact set of events that fired around it without any additional infrastructure.

## Wiring sinks

### Logging

```ts
observability: {
  emit(event) {
    logger.info({ event: event.type, requestId: event.requestId, ...event }, 'authfn');
  },
},
```

### Audit log (immutable storage)

```ts
observability: {
  async emit(event) {
    await auditQueue.send({ type: event.type, body: JSON.stringify(event) });
  },
},
```

### Metrics

```ts
observability: {
  emit(event) {
    metrics.increment(event.type.replace(/\./g, '_'), {
      regionId: event.regionId,
      outcome: event.outcome,
      provider: event.provider,
    });
  },
},
```

### Tracing (OpenTelemetry)

```ts
observability: {
  emit(event) {
    const span = trace.getActiveSpan();
    span?.addEvent(event.type, {
      'authfn.requestId': event.requestId,
      'authfn.userId': event.userId,
      ...event.metadata,
    });
  },
},
```

### Multiple sinks

```ts
function broadcast(...sinks: Array<(e: AuthFnEvent) => Promise<void> | void>) {
  return {
    async emit(event: AuthFnEvent) {
      await Promise.all(sinks.map((sink) => sink(event)));
    },
  };
}

observability: broadcast(toLogs, toMetrics, toAudit),
```

## Performance

`emit` runs in-process, in the request path. Slow sinks add latency to user-visible actions. Push to a queue or fire-and-forget unless you really need durable correlation:

```ts
observability: {
  emit(event) {
    queueMicrotask(() => audit.send(event).catch(captureError));
  },
}
```

(Note: fire-and-forget loses events on crash. Use a queue with at-least-once delivery for compliance audit logs.)

## Sampling

If you don't want every event in your sink, sample at the sink — *not* by suppressing the kernel's emission:

```ts
observability: {
  emit(event) {
    if (event.type === 'authfn.region.lookup' && Math.random() > 0.01) return;
    sink.emit(event);
  },
}
```

## Errors and failures

`authfn.request.failed` carries the error code and HTTP status of the response that was returned. `authfn.plugin.failed` carries the offending hook's name and a sanitized error payload. Use these for high-level alerting.

## OpenTelemetry helper

A boilerplate OpenTelemetry sink is documented in [Recipes → Observability with OpenTelemetry](../recipes/observability-otel) — including how to attach the active span context to events and emit them as span events.

## Related

- [Envelopes](./envelopes) — `requestId` correlation.
- [Errors](./errors) — codes that show up in `authfn.request.failed`.
- [Reference → Events](../reference/events) — full event catalog with metadata schemas.
