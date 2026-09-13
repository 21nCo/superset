---
title: core — Security
description: HTML trust, auth, and redaction helpers in @docsfn/core.
---

# Security (`@docsfn/core`)

## HTML sanitization (`sanitize.ts`)

| Export | Role |
| --- | --- |
| **`BLOCKED_HTML_TAGS`** | Tags rejected in Markdown sources (`script`, `iframe`, `object`, `embed`, `link`, `meta`). |
| **`BLOCKED_HTML_PATTERNS`** | Event-handler attributes and unsafe URL schemes. |
| **`findUnsafeHtml(source)`** | Returns match metadata. |
| **`assertSafeSource(input)`** | Throws **`DOCS_HTML_UNSAFE`** when matches exist (unless raw HTML allowed). |

## Trust assertions

| Function | Role |
| --- | --- |
| **`assertSourceEntriesTrusted`** | Validates Markdown entries before manifest compile. |
| **`assertCompiledContentTrusted`** | Validates transformed Markdown prior to UI compile. |
| **`collectUnsafeHtmlDiagnostics`** | Non-throwing diagnostic collector. |

**`resolveUnsafeHtmlAllowlist`** merges env **`DOCSFN_HTML_UNSAFE_ALLOWLIST`** (comma-separated globs).

## Type shapes

**`SourceTrustPolicy`:**

| Field | Type | Description |
| --- | --- | --- |
| `allowUnsafeHtml?` | `boolean` | Permit raw HTML in sources. |
| `allowUnsafeHtmlAllowlist?` | `string[]` | Glob patterns for paths that may contain raw HTML. |

**`AssertSourceEntriesTrustedInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `entries` | `DocsSourceEntry[]` | Source entries to validate. |
| `policy?` | `SourceTrustPolicy` | Trust configuration. |

**`AssertCompiledContentTrustedInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `source` | `string` | Transformed Markdown source. |
| `sourcePath?` | `string` | Path for diagnostics. |
| `policy?` | `SourceTrustPolicy` | Trust configuration. |

**`AssertDocsRouteAccessInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `config` | `Pick<DocsConfig, "auth">` | Auth portion of docs config. |
| `route` | `string` | Route path to check. |
| `session?` | `unknown \| null` | Current session object. |
| `resolveSession?` | `() => unknown \| Promise<unknown>` | Lazy session resolver. |
| `isRoutePrivate?` | `(route: string) => boolean` | Custom private-route predicate. |
| `authorize?` | `(input: { route, session }) => boolean \| Promise<boolean>` | Custom authorization check. |

**`DocsRouteAccessResult`:**

| Field | Type | Description |
| --- | --- | --- |
| `mode` | `DocsAuthMode` | Resolved auth mode (`public`, `private`, `mixed`). |
| `route` | `string` | The checked route. |
| `requiresAuth` | `boolean` | Whether the route needs authentication. |
| `allowed` | `boolean` | Whether access is granted. |

**`ResolveUnsafeHtmlAllowlistInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `value?` | `string` | Explicit allowlist string (overrides env). |

## Auth

| Export | Role |
| --- | --- |
| **`CANONICAL_DOCS_AUTH_MODES`** | `["public","private","mixed"]`. |
| **`resolveDocsAuthMode`** | Maps config → mode (disabled auth → `public`). |
| **`assertDocsRouteAccess`** | Async gate: throws **`DOCS_AUTH_REQUIRED`** / **`DOCS_AUTH_FORBIDDEN`**. |

## Redaction

**`redactSensitiveText`**, **`redactSensitivePayload`** — strip common secret patterns from strings and nested objects (used by search + analytics).
