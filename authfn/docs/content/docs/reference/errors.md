---
title: Error codes
description: Every AuthFnErrorCode the kernel emits — HTTP status, retryability, when it fires.
---

# Error codes

Every error returned by authfn carries a stable `code` (typed as `AuthFnErrorCode`), an HTTP status, and a boolean `retryable`. Some errors carry structured `details` you can use to drive UI.

The table below covers every code the kernel emits across all plugins.

| Code | Status | Retryable | When |
| --- | --- | --- | --- |
| `AUTHFN_VALIDATION_ERROR` | 400 | no | Body, query, or params failed validation. `details.fields` contains per-field errors. |
| `AUTHFN_INVALID_CREDENTIALS` | 401 | no | Password mismatch or unknown user. |
| `AUTHFN_UNAUTHENTICATED` | 401 | no | No session present on a route that requires one. |
| `AUTHFN_CSRF_INVALID` | 403 | no | Missing or wrong `X-CSRF-Token` on a state-changing request. |
| `AUTHFN_2FA_REQUIRED` | 401 | yes | Sign-in succeeded credentials-wise; user must complete `/2fa/challenge`. `details.challengeId`. |
| `AUTHFN_2FA_INVALID_CODE` | 401 | yes | Wrong TOTP / recovery code. |
| `AUTHFN_OTP_INVALID` | 401 | yes | OTP code didn't match. |
| `AUTHFN_OTP_EXPIRED` | 401 | yes | OTP has aged past TTL. |
| `AUTHFN_OTP_REPLAYED` | 401 | no | OTP was already consumed. |
| `AUTHFN_API_KEY_REVOKED` | 401 | no | API key has been revoked. |
| `AUTHFN_SESSION_EXPIRED` | 401 | no | Session past its `expiresAt`. |
| `AUTHFN_SESSION_REVOKED` | 401 | no | Session was revoked (sign-out, sign-out-everywhere). |
| `AUTHFN_EMAIL_NOT_VERIFIED` | 403 | yes | Sign-in is gated behind verification; user must verify first. |
| `AUTHFN_OAUTH_STATE_INVALID` | 400 | no | OAuth callback state isn't recognized or is malformed. |
| `AUTHFN_OAUTH_STATE_REPLAYED` | 400 | no | OAuth callback state was already consumed. |
| `AUTHFN_OAUTH_CALLBACK_INVALID` | 400 | no | OAuth callback parameters are wrong (missing code, error from provider, …). |
| `AUTHFN_OAUTH_PROVIDER_UNSUPPORTED` | 400 | no | The configured plugin doesn't recognize the provider id. |
| `AUTHFN_REDIRECT_URI_DISALLOWED` | 400 | no | `returnTo` (or `state.returnTo`) wasn't on the allowlist. |
| `AUTHFN_RATE_LIMITED` | 429 | yes | Per-route rate limiter rejected the request. `details.retryAfter`. |
| `AUTHFN_REGION_MISMATCH` | 409 | yes | Request landed on the wrong region. `details.redirectTo`. |
| `AUTHFN_REGION_NOT_FOUND` | 404 | no | Identifier isn't registered to any region (anti-enumeration friendly: usually 200 with a fake answer is preferred — see plugin config). |
| `AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE` | 503 | yes | Canonical identity placement could not be read or atomically updated. Gateway mode fails closed. |
| `AUTHFN_PLACEMENT_MOVING` | 503 | yes | The identity is fenced during a cell move. No auth side effect started. |
| `AUTHFN_ROUTING_ASSERTION_INVALID` | 401 | no | A cell rejected a missing, expired, replayed, or request-mismatched gateway assertion. |
| `AUTHFN_ROUTING_CELL_UNAVAILABLE` | 503 | no | The selected private cell target was absent or dispatch failed. Dispatch failure may occur after side effects, so generic retries are unsafe. |
| `AUTHFN_PLACEMENT_CONTEXT_INVALID` | 401 | no | A signed placement-bound auth context failed signature, audience, issuer, or expiry verification. |
| `AUTHFN_DELIVERY_FAILED` | 502 | yes | OTP/email delivery provider returned an error. |
| `AUTHFN_PLUGIN_ABORTED` | 400 | no | A `before*` hook threw `AuthFnPluginAbortedError` to reject the operation. `details.reason`. |
| `AUTHFN_CONFLICT` | 409 | no | Duplicate primary email, duplicate OAuth identity, etc. |
| `AUTHFN_NOT_FOUND` | 404 | no | Resource doesn't exist (e.g., revoke a non-existent session). |
| `AUTHFN_NOT_IMPLEMENTED` | 501 | no | Plugin or runtime feature not implemented in this build. |
| `AUTHFN_CONFIG_INVALID` | 500 | no | Programmer error — plugin or kernel config is invalid. |
| `AUTHFN_INTERNAL_ERROR` | 500 | yes | Unhandled error inside the kernel. Sanitized; check logs for the cause. |
| `AUTHFN_ADMIN_UNAUTHORIZED` | 401 | no | `@authfn/admin` `authorize` callback returned false. |
| `AUTHFN_ADMIN_AMBIGUOUS_USER` | 409 | no | `@authfn/admin` couldn't decide which user to delete. |
| `AUTHFN_ADMIN_CONFIG_INVALID` | 500 | no | `@authfn/admin` was constructed with invalid config. |

## Wire shape

```jsonc
{
  "ok": false,
  "error": {
    "code": "AUTHFN_2FA_REQUIRED",
    "message": "Two-factor authentication required",
    "retryable": true,
    "details": { "challengeId": "ch_abc..." }
  },
  "requestId": "..."
}
```

## Source of truth

The exhaustive type lives in `authfn/core/src/core/errors.ts`. The full error class hierarchy is exported from `@authfn/core`.

## Recommended UX

| Code | Recommended UI |
| --- | --- |
| `AUTHFN_INVALID_CREDENTIALS` | Generic "Invalid email or password" — never "user not found". |
| `AUTHFN_2FA_REQUIRED` | Render the 2FA code input. |
| `AUTHFN_OTP_INVALID` / `OTP_EXPIRED` / `OTP_REPLAYED` | "That code didn't work. Send a new one." |
| `AUTHFN_RATE_LIMITED` | Disable the submit button for `details.retryAfter` seconds; show a countdown. |
| `AUTHFN_REGION_MISMATCH` | The regional client follows `details.redirectTo` automatically — usually invisible. |
| `AUTHFN_VALIDATION_ERROR` | Render per-field errors from `details.fields`. |
| `AUTHFN_INTERNAL_ERROR` | Generic apology; log the request id from the response. |
