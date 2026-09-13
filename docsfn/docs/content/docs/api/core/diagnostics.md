---
title: core — Diagnostics
description: DocsError, DocsDiagnostic, and error codes in @docsfn/core.
---

# Diagnostics (`@docsfn/core`)

## `DocsError`

Subclass of **`Error`** with **`code`**, **`diagnostics`**, optional **`cause`**.

## `createDocsError` / `createDiagnostic`

Factory helpers used across the pipeline to attach structured **`DocsDiagnostic`** rows.

## `DocsDiagnostic`

| Field | Type |
| --- | --- |
| `code` | `DocsErrorCode` |
| `severity` | `error` \| `warning` \| `info` |
| `message` | Human-readable summary |
| `location?` | `sourceId`, `absolutePath`, optional line/column |
| `details?` | JSON-serializable bag |
| `suggestion?` | Fix hint |

## CLI helpers

- **`hasErrorDiagnostics`**
- **`formatDiagnosticsForCli`**
- **`redactDiagnostics`**
- **`assertNoErrorDiagnostics`**
- **`diagnosticsFromUnknownError`**

## `DocsErrorCode` values

`DOCS_CONFIG_INVALID`, `DOCS_CONFIG_UNSUPPORTED`, `DOCS_PROVIDER_ERROR`, `DOCS_ENTRY_INVALID`, `DOCS_META_INVALID`, `DOCS_ROUTE_CONFLICT`, `DOCS_ROUTE_NOT_FOUND`, `DOCS_VERSION_INVALID`, `DOCS_COMPAT_UNSUPPORTED`, `DOCS_MDX_COMPILE_FAILED`, `DOCS_HTML_UNSAFE`, `DOCS_SEARCH_BUILD_FAILED`, `DOCS_OPENAPI_PARSE_FAILED`, `DOCS_REMOTE_FETCH_FAILED`, `DOCS_AUTH_REQUIRED`, `DOCS_AUTH_FORBIDDEN`, `DOCS_ARTIFACT_INVALID`.

Legacy code normalization: **`normalizeDocsErrorCode`**, **`CANONICAL_DOCS_ERROR_CODES`**.
