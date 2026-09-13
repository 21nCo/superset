---
title: Security
description: authfn's threat model, what it defends against, what it expects you to handle, and how to harden a deployment.
---

# Security

authfn is an authentication kernel — it handles the parts of auth where small mistakes have outsized consequences. It does *not* try to be a complete security platform. This page is the explicit version of "what does authfn actually defend against, and what do I still own?"

## Threat model

authfn assumes:

- **The transport is HTTPS.** All real deployments run behind TLS. authfn issues `Secure` cookies by default, expects `https://` callback URLs, and refuses to send sensitive material over plaintext when it has a choice.
- **The database is trusted.** Anyone who can read your database has all of your users' password hashes, recovery codes, and 2FA secret material. Treat the database accordingly.
- **You operate the runtime.** authfn does not protect against an attacker with code execution on your server. There's no DRM here; if the runtime is hostile, authfn is fully compromised.
- **The browser respects standards.** Cookies, `SameSite`, `HttpOnly`, the Origin header. Browsers running in non-standard modes (e.g. embedded webviews without the standard cookie jar) need special care — see [Plugins → Native handoff](../plugins/native-handoff).

## What authfn defends against

| Threat | How |
| --- | --- |
| **CSRF** | Double-submit token model on every cookie-authenticated mutating route. `SameSite=Lax` on the session cookie as the second layer. |
| **Session fixation** | Session tokens are rotated on `afterSessionIssue` (e.g. after a 2FA challenge succeeds). Session ids carry a high-entropy random component. |
| **Brute force on TOTP** | Window of `±skew` is small (default ±1). Recovery codes are single-use and hashed. |
| **OAuth state replay** | OAuth states are one-shot, signed, and persisted. Replay returns `AUTHFN_OAUTH_STATE_REPLAYED`. |
| **OAuth open redirect** | Every `redirect_uri` and `returnTo` is matched against an allowlist (`allowlistedRedirectUris`, `allowlistedReturnTo`). Off-allowlist values return `AUTHFN_REDIRECT_URI_DISALLOWED`. |
| **OTP brute force** | Attempt counter on each challenge; small ceiling. |
| **OTP enumeration** | Sign-in for an unknown email returns the same generic envelope as for a known email; the OTP is sent regardless if the policy allows. |
| **Token leakage in logs** | The observability sink runs through a redactor that strips anything keyed `token`, `secret`, `bearer`, `password`, `key`, `authorization` from event metadata. |
| **OAuth secret leakage in errors** | OAuth error details are sanitized before being wrapped in `AuthFn*Error`. |
| **Wrong-region credential reuse** | Multi-region plugin pre-routes by email and rejects mismatches with `AUTHFN_REGION_MISMATCH`. |
| **Placement spoofing** | Placement-bound consumer context is derived only from a verified session and the placement directory. Client-supplied subject, region, epoch, issuer, or `x-authfn-routing-*` headers are ignored. |
| **API key leakage in storage** | API keys are hashed at rest; only the hash is persisted. The plaintext is shown once at creation. |
| **Password storage compromise** | Passwords are hashed with a vetted algorithm (argon2id under the hood). Hashes are never logged. |
| **CSRF token leakage in logs** | Tokens are not logged; only their hashes are persisted. |

## What you own

| Concern | Who handles it |
| --- | --- |
| **TLS termination** | You. authfn assumes HTTPS at the edge. |
| **Rate limiting** | You. authfn does not ship a limiter; see [Rate limiting](./rate-limiting). |
| **WAF / bot management** | You. The kernel is not a request firewall. |
| **Email security (SPF/DKIM/DMARC)** | You. The kernel emits the OTP; your delivery provider sends it. Misconfigured email auth lets attackers spoof your sender. |
| **OAuth provider configuration** | You. The kernel passes your client IDs and secrets through; misconfiguration there is on you. |
| **Database access controls** | You. Limit who can read `authfn_*` tables to the absolute minimum. |
| **Secrets management** | You. Use a secrets manager and rotate the OAuth client secrets, recovery-code hashes, and database passwords on a schedule. |
| **Authorization policy** | You. authfn answers "who is the user?"; "what can they do?" is your application's job. |
| **Audit log target** | You. `observability.emit` is the integration point; you choose where the events go. |
| **Backup, replication, retention** | You. authfn writes through your database adapter; backup policy is database policy. |

## Hardening checklist

- **TLS everywhere, including internal hops.** Even if you trust your VPC, an internal hop in cleartext is one misconfiguration away from leaking session tokens. End-to-end TLS is the only safe default.
- **`Secure` cookies in every environment that has TLS.** The default. Don't override `secure: false` outside `localhost`.
- **`SameSite=Lax`, not `None`, unless you have a documented cross-site need.** `None` requires a trusted SameSite-aware fronting layer.
- **Cookie domain scoped as tightly as possible.** If your app lives only on `app.example.com`, don't share the cookie with `*.example.com`.
- **Allowlist redirects strictly.** Both `allowlistedRedirectUris` (OAuth provider redirects) and `allowlistedReturnTo` (post-auth landing). Wildcards are not supported by design.
- **Run the database on its own VPC / network ACL.** Treat the `authfn_*` tables as Tier 0 secrets storage.
- **Set up automatic rotation for OAuth secrets and database credentials.** Ideally on a 90-day cadence.
- **Encrypt 2FA secrets at rest.** authfn stores them encrypted; the encryption key is part of your config (`authFnTwoFactorPlugin({ encryption: { ... } })`). Use KMS / Vault / secret manager-backed keys, not hardcoded values.
- **Wire `observability.emit` to an immutable audit log** for compliance use cases. Use at-least-once delivery semantics (queue) — fire-and-forget will lose events on crash.
- **Monitor `authfn.rate_limited`, `authfn.oauth.failed`, `authfn.account_linking.conflict`, and `authfn.region.lookup.conflict`** — these are the canaries for active abuse.
- **Set strict CORS.** Specific origin allowlist, no wildcard, `Access-Control-Allow-Credentials: true`.
- **Add a Content Security Policy.** authfn doesn't ship UI, but your client-side app should — CSP blunts the impact of a frontend XSS.
- **Run your own `secrets-scan` in CI.** authfn's redactor protects logs from kernel-level leaks; your own code can still leak.

## Cookie attribute matrix

| Use case | Domain | SameSite | Secure | HttpOnly |
| --- | --- | --- | --- | --- |
| Single-host SPA | unset | Lax | true | session: true; csrf: false |
| Subdomain-shared session (`app.example.com` + `api.example.com`) | `.example.com` | Lax | true | as above |
| OAuth on a different parent domain | scope as tight as possible | Lax | true | as above |
| Cross-site iframe sign-in | as needed | None | true | as above (consider partitioned cookies) |

## Disclosure

If you find a security issue in authfn or in any Superfunctions package, please email `security@21n.co` rather than filing a public issue. We acknowledge within 48 hours and treat embargoed disclosure as default. Hall of fame is published in the repo.

## Related

- [Cookies](./cookies) — names, scoping, attributes.
- [CSRF](./csrf) — token model.
- [Rate limiting](./rate-limiting) — what to limit.
- [Observability](./observability) — redaction, event catalog.
- [Plugins → Two-factor](../plugins/two-factor) — TOTP encryption, recovery codes.
- [Plugins → Native handoff](../plugins/native-handoff) — bridged-webview considerations.
