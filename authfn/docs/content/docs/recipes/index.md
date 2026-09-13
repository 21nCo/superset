---
title: Recipes
description: Copy-pasteable solutions for common authfn flows. Each recipe is small, self-contained, and links to the relevant plugins / SDKs.
---

# Recipes

Solutions for the things you'll actually do in a real app. Each page is a small, focused walkthrough.

## Auth flows

- [Email verification](./email-verification) — verify a new sign-up's email.
- [Magic link sign-in](./magic-link) — clickable link instead of a typed code.
- [Password reset](./password-reset) — full reset flow with OTP.
- [Adding 2FA](./adding-2fa) — enroll, confirm, challenge.
- [Adding a password to an OAuth account](./adding-password) — let users opt in to passwords.

## Account lifecycle

- [Account deletion](./account-deletion) — cascade across plugins.

## Operations

- [Multi-region deployment](./multi-region-deployment) — two regions, lookup store, runtime overlays.
- [Canonical-gateway multi-region](./canonical-gateway-multi-region) — one public AuthFn authority with signed cell forwarding.
- [Placement-bound auth context](./placement-bound-auth-context) — trusted downstream routing context for Nucleum/DataFn.
- [Rotate 2FA encryption keys](./rotate-2fa-encryption) — re-encrypt enrollments under a new key.

## Integrations

- [Native mobile handoff](./native-mobile-handoff) — iOS / macOS bearer credentials from a web sign-in.
- [Adding a custom OAuth provider](./custom-oauth-provider) — Microsoft Entra example.
- [Google One Tap](./google-one-tap) — handoff a One Tap credential.
- [CLI authentication](./cli-auth) — issue API keys for command-line tools.
- [Admin tool](./admin-tool) — `@authfn/admin` with corporate IAM.

## Observability & validation

- [OpenTelemetry instrumentation](./observability-otel) — wire `observability.emit` to a span.
- [Custom validation hooks](./custom-validation) — disposable email, allowlists, etc.
