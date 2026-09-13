---
title: Errors
description: Every error code authfn can return — what it means, what HTTP status it maps to, whether it's retryable, and what the client should show.
---

# Errors

authfn ships a closed set of typed error codes. Every error that the kernel returns to a client is one of the codes below, wrapped in the [error envelope](./envelopes). Adding a new error code is a versioned, breaking change — clients can rely on the list being stable.

## Error envelope

```ts
interface AuthFnErrorEnvelope {
  ok: false;
  error: {
    code: AuthFnErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  requestId: string;
}
```

## All error codes

| Code | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `AUTHFN_2FA_INVALID_CODE` | 400 | no | TOTP code or recovery code is wrong. |
| `AUTHFN_2FA_REQUIRED` | 401 | no | Sign-in succeeded for the primary method, but 2FA must complete before a session is issued. The response carries a challenge id for the follow-up call. |
| `AUTHFN_ADMIN_AMBIGUOUS_USER` | 409 | no | An admin lookup matched multiple users. |
| `AUTHFN_ADMIN_CONFIG_INVALID` | 400 | no | Admin configuration (e.g. `authorize`) is missing or malformed. |
| `AUTHFN_ADMIN_UNAUTHORIZED` | 401 | no | Admin authorize callback rejected the request. |
| `AUTHFN_API_KEY_REVOKED` | 401 | no | The API key was revoked. |
| `AUTHFN_CONFLICT` | 409 | no | Generic conflict (e.g. sign-up email already exists). `details` may carry `field` / `reason`. |
| `AUTHFN_CONFIG_INVALID` | 400 | no | Server-side configuration is invalid (raised at construction). |
| `AUTHFN_CSRF_INVALID` | 403 | no | CSRF token missing, malformed, or doesn't match. |
| `AUTHFN_DELIVERY_FAILED` | 503 | yes | Mail delivery for an OTP failed. Safe to retry. |
| `AUTHFN_EMAIL_NOT_VERIFIED` | 403 | no | The action requires a verified email address. |
| `AUTHFN_INTERNAL_ERROR` | 500 | yes | Generic kernel error. Logged with full context. |
| `AUTHFN_INVALID_CREDENTIALS` | 401 | no | Password/email pair is wrong. |
| `AUTHFN_NOT_FOUND` | 404 | no | The targeted resource doesn't exist. |
| `AUTHFN_NOT_IMPLEMENTED` | 501 | no | Plugin or path not enabled in this deployment. |
| `AUTHFN_OAUTH_CALLBACK_INVALID` | 400 | no | OAuth callback parameters are inconsistent (e.g. provider error, missing `code`). |
| `AUTHFN_OAUTH_PROVIDER_UNSUPPORTED` | 400 | no | Provider id is not configured. |
| `AUTHFN_OAUTH_STATE_INVALID` | 400 | no | OAuth `state` is missing, expired, or signed wrong. |
| `AUTHFN_OAUTH_STATE_REPLAYED` | 409 | no | The same `state` was used twice. |
| `AUTHFN_OTP_EXPIRED` | 400 | no | The OTP code is past its expiry. |
| `AUTHFN_OTP_INVALID` | 400 | no | The OTP code is wrong. |
| `AUTHFN_OTP_REPLAYED` | 409 | no | The OTP code was already used. |
| `AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE` | 503 | yes | Canonical identity placement could not be read or atomically updated. Gateway mode fails closed. |
| `AUTHFN_PLACEMENT_MOVING` | 503 | yes | The identity is fenced during a cell move. No auth side effect may start. |
| `AUTHFN_PLACEMENT_CONTEXT_INVALID` | 401 | no | A signed placement-bound auth context failed signature, audience, issuer, or expiry verification. |
| `AUTHFN_PLUGIN_ABORTED` | 500 | no | A plugin's `before*` hook threw / aborted. |
| `AUTHFN_RATE_LIMITED` | 429 | yes | The request was rate-limited (by an external limiter or by an authfn-internal counter). |
| `AUTHFN_REDIRECT_URI_DISALLOWED` | 400 | no | `returnTo` (or OAuth `redirect_uri`) is not in `allowlistedReturnTo` / `allowlistedRedirectUris`. |
| `AUTHFN_REGION_MISMATCH` | 409 | no | This request must continue against a different region authority. The response `details.redirectTo` says where. |
| `AUTHFN_REGION_NOT_FOUND` | 404 | no | The region lookup yielded no record for the given identifier. |
| `AUTHFN_ROUTING_ASSERTION_INVALID` | 401 | no | A cell rejected a missing, expired, replayed, or request-mismatched gateway assertion. |
| `AUTHFN_ROUTING_CELL_UNAVAILABLE` | 503 | no | The selected private cell target was absent or dispatch failed. A generic retry is unsafe because execution may already have started. |
| `AUTHFN_SESSION_EXPIRED` | 401 | no | Session past `expiresAt`. |
| `AUTHFN_SESSION_REVOKED` | 401 | no | Session has `revokedAt` set. |
| `AUTHFN_UNAUTHENTICATED` | 401 | no | No session at all. |
| `AUTHFN_VALIDATION_ERROR` | 400 | no | Input failed validation. `details.field` and `details.reason` describe the violation. |

## How to display errors

Resist the temptation to show the `message` verbatim — it's intended for developers, not end users. Instead, branch on `code`:

```ts
function describe(error: AuthFnError): string {
  switch (error.code) {
    case 'AUTHFN_INVALID_CREDENTIALS':
      return "Email or password is incorrect.";
    case 'AUTHFN_2FA_REQUIRED':
      return "Enter your two-factor code to continue.";
    case 'AUTHFN_OTP_EXPIRED':
      return "That code has expired. Send a new one.";
    case 'AUTHFN_RATE_LIMITED':
      return "Too many attempts. Try again in a minute.";
    case 'AUTHFN_REGION_MISMATCH':
      return "Continue on the correct region.";
    case 'AUTHFN_DELIVERY_FAILED':
      return "We couldn't send that email. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
```

The first-party SDKs throw a typed `AuthFnError` so you can `try`/`catch` and branch on `error.code`.

## Retryable errors

`retryable: true` is set on:

- `AUTHFN_DELIVERY_FAILED` — the mail provider returned a transient error.
- `AUTHFN_RATE_LIMITED` — wait and retry; the response should carry `details.retryAfterMs` if known.
- `AUTHFN_INTERNAL_ERROR` — kernel-side glitch; safe to retry once with backoff.
- `AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE` — retry after the canonical placement coordinator recovers.
- `AUTHFN_PLACEMENT_MOVING` — retry after the fenced identity move completes or rolls back.

`AUTHFN_ROUTING_CELL_UNAVAILABLE` is deliberately not retryable: an internal transport failure can happen after the cell starts executing. Retry only when a signed mismatch proves `executionStarted: false`, or when the operation has its own idempotency guarantee.

Everything else is `retryable: false` — retrying without changing the input will produce the same error.

## Details payloads

`error.details` is best-effort additional context. Some examples:

- `AUTHFN_VALIDATION_ERROR` → `{ field, reason }`
- `AUTHFN_REGION_MISMATCH` → `{ identifier, regionId, authority, redirectTo }`
- `AUTHFN_2FA_REQUIRED` → `{ challengeId, expiresAt, primaryMethod }`
- `AUTHFN_OAUTH_*` → sanitized provider details with secrets redacted
- `AUTHFN_RATE_LIMITED` → `{ retryAfterMs? }`
- `AUTHFN_CONFLICT` → `{ field?, reason? }`
- `AUTHFN_PLACEMENT_MOVING` → `{ executionStarted: false }` when a cell rejected the request before side effects.
- `AUTHFN_ROUTING_*` → sanitized epoch, region, or rejection context; never cell targets, identity keys, assertions, or secrets.

The shapes for each `code`/`details` pair are documented per-route in the [API reference](../api).

## Importing the error classes

If you author your own plugins and want to throw the same error model, import from `@authfn/core`:

```ts
import {
  AuthFnError,
  AuthFnConflictError,
  AuthFnUnauthenticatedError,
  AuthFnRateLimitedError,
} from '@authfn/core';

throw new AuthFnConflictError('email already registered', { field: 'email' });
```

The full class list is exported under [SDKs → Core → Error classes](../sdk/core/error-classes).

## Related

- [Envelopes](./envelopes) — error envelope shape.
- [Reference → Errors](../reference/errors) — same listing, indexed for searching.
- [Observability](./observability) — `authfn.request.failed` and `authfn.plugin.failed` events.
