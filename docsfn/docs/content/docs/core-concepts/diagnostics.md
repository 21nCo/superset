---
title: Diagnostics
description: docsfn diagnostic codes, severities, JSON output, and common fixes.
---

# Diagnostics

Every pipeline stage can emit **`DocsDiagnostic`** objects: structured messages with **`code`**, **`severity`**, **`message`**, optional **`location`**, **`details`**, and **`suggestion`**.

See also: [CLI](./cli), [Security](./security).

## Severity levels

| Severity | Meaning |
| --- | --- |
| **`error`** | Fails the command / blocks artifacts (CLI sets exit code **1**). |
| **`warning`** | Non-blocking; should be reviewed. |
| **`info`** | Informational (compat hints, unsupported OpenAPI sections, etc.). |

## `DocsDiagnostic` shape

- **`code`** — `DocsErrorCode` (see below).
- **`severity`** — `error` | `warning` | `info`.
- **`message`** — Human-readable summary.
- **`location`** — `sourceId`, `absolutePath`, optional `line` / `column`.
- **`details`** — Machine-readable context (duplicate route ids, blocked HTML categories, etc.).
- **`suggestion`** — Optional remediation text.

## Error codes (19 codes)

| Code | Typical cause |
| --- | --- |
| `DOCS_CONFIG_INVALID` | Schema validation failed on `docsfn.config`. |
| `DOCS_CONFIG_UNSUPPORTED` | Valid JSON shape but feature not available. |
| `DOCS_PROVIDER_ERROR` | Provider contract violation (duplicate ids, missing fields). |
| `DOCS_ENTRY_INVALID` | A source entry cannot be normalized. |
| `DOCS_META_INVALID` | `meta.json` parse or `pages` rule error. |
| `DOCS_ROUTE_CONFLICT` | Two entries claim the same URL path. |
| `DOCS_ROUTE_NOT_FOUND` | Sidebar/pagination/breadcrumb target missing from tree. |
| `DOCS_VERSION_INVALID` | Version config or slug resolution failed. |
| `DOCS_COMPAT_UNSUPPORTED` | Fumadocs compat preset hit unsupported syntax. |
| `DOCS_COMPONENT_UNRESOLVED` | A PascalCase component used in Markdown has no mapping in the `components` prop. |
| `DOCS_MDX_COMPILE_FAILED` | MDX/compile pipeline error. |
| `DOCS_HTML_UNSAFE` | Blocked tag or pattern in Markdown (or unsafe HTML path). |
| `DOCS_SEARCH_BUILD_FAILED` | Search artifact could not be built (size limit, internal error). |
| `DOCS_SEARCH_SCOPE_INVALID` | A `routeScopeOverrides` pattern matched a route but the resolved scope is not in the configured `search.scopes`. |
| `DOCS_OPENAPI_PARSE_FAILED` | OpenAPI file invalid or not OpenAPI 3.x. |
| `DOCS_REMOTE_FETCH_FAILED` | Remote spec/content fetch error. |
| `DOCS_AUTH_REQUIRED` | Route needs a session. |
| `DOCS_AUTH_FORBIDDEN` | Session present but not authorized. |
| `DOCS_ARTIFACT_INVALID` | Manifest/blog/search artifact consistency error. |

## Reading `diagnostics.json`

**`docsfn build`** and **`docsfn dev`** write **`.docsfn/diagnostics.json`** (or your `--out-dir`) as a JSON array of diagnostics. Use it in CI to fail on warnings by policy, or to aggregate issues across environments.

## Common scenarios

- **`DOCS_HTML_UNSAFE`** — Remove raw `script` / `iframe` / event handlers from Markdown, or use **`DOCSFN_HTML_UNSAFE_ALLOWLIST`** for vetted paths only.
- **`DOCS_ROUTE_CONFLICT`** — Rename files or adjust `basePath` / version slugs so paths are unique.
- **`DOCS_META_INVALID`** — Validate `meta.json` `pages` entries (each object needs a key id).
- **`DOCS_OPENAPI_PARSE_FAILED`** — Confirm OpenAPI **3.x** and fix YAML/JSON syntax.
- **`DOCS_SEARCH_BUILD_FAILED`** — Lower **`search.bodyIndexing`** resolution, shrink corpus, or raise **`maxArtifactBytes`**.
