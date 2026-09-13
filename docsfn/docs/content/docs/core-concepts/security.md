---
title: Security
description: HTML sanitization, authentication modes, private routes, sensitive redaction, and allowlists.
---

# Security

docsfn blocks unsafe patterns in Markdown sources by default, gates routes when **auth** is enabled, and **redacts** sensitive strings in search text, analytics URLs, and structured payloads.

See also: [Search](./search), [Analytics](./analytics), [Diagnostics](./diagnostics).

## HTML sanitization

**`findUnsafeHtml`** scans raw source for:

### Blocked tags

`script`, `iframe`, `object`, `embed`, `link`, `meta` (opening tag pattern, case-insensitive).

### Blocked patterns

- **Event handlers** — inline DOM handler attributes whose names match the pattern **on** + letters + **=** (blocked by regex).
- **Script-in-URL schemes** — URIs using the legacy script-in-URL scheme (blocked by regex).

Violations surface as **`DOCS_HTML_UNSAFE`** during compile/trust checks unless the source is allowlisted or raw HTML is explicitly allowed by policy.

## Authentication modes

When **`auth.enabled`** is false, **`resolveDocsAuthMode`** returns **`public`** (no auth layer in core).

When enabled:

| Mode | Behavior |
| --- | --- |
| **`public`** | No route requires a session (enabled + public is unusual; typically you leave auth disabled instead). |
| **`private`** | **Every** checked route requires a session. |
| **`mixed`** | **`isRoutePrivate(route)`** decides. If the classifier is **omitted**, mixed mode **fails closed** (all routes treated as private). |

**`assertDocsRouteAccess`** throws:

- **`DOCS_AUTH_REQUIRED`** — session missing on a protected route.
- **`DOCS_AUTH_FORBIDDEN`** — `authorize` callback returned false.

## Route-level privacy (mixed + search)

For **search indexing**, a page is treated as protected in **mixed** mode when:

- `frontmatter.private === true` or `frontmatter.auth === "private"`, or
- the route path matches **`/private/`** (segment boundary, case-insensitive).

Protected docs/api pages are **omitted** from the search artifact when auth is enabled.

Implement **`isRoutePrivate`** in your app to mirror the same rules for HTTP access.

## Sensitive data detection

**`redactSensitivePayload`** / **`redactSensitiveText`** use patterns for:

- **Keys** matching: `secret`, `token`, `cookie`, `authorization`, `password`, `api_key`-style names, `session`, etc.
- **Values** matching: Bearer tokens, Slack-style `xox*`, GitHub `ghp_*` / `gho_*`, Stripe `sk_*`, `api_key` assignments, etc.

Diagnostics and analytics pipelines run redaction helpers so accidental paste of secrets is less likely to leak in JSON logs.

## `DOCSFN_HTML_UNSAFE_ALLOWLIST`

Comma-separated globs (from **`process.env`** or API input) matched against entry **`id`**, **`relativePath`**, and **`absolutePath`**. Any match allows that Markdown entry through the unsafe-HTML gate when policy merges the allowlist.

Use sparingly and only for trusted paths.
