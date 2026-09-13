---
title: core — Search
description: buildSearchIndex and search artifact types in @docsfn/core.
---

# Search (`@docsfn/core`)

## `buildSearchIndex(manifest, options?)`

- **`manifest`:** `DocsManifest`
- **`options`:** `BuildSearchIndexOptions` — `{ search?: DocsConfig["search"]; auth?: DocsConfig["auth"] }`

**Returns:** `Promise<DocsSearchArtifact>` with **`bytes`** set to UTF-8 JSON length.

When **`search.enabled`** is false (or resolved false), returns an empty artifact with zero documents and a minimal snapshot.

When enabled, collects **`DocsSearchDocument`** rows per scope, enforces unique ids across scopes, builds a **searchfn** snapshot, and may attach **warnings** if **`maxArtifactBytes`** would be exceeded.

## `DocsSearchScope`

`"docs" | "api" | "blog"`

## `DocsSearchDocument`

Typical fields (see `search.ts`): `id`, `scope`, `kind` (`page` | `api` | `post`), `path`, `title`, `summary`, `headings`, `tags`.

## `DocsSearchArtifact`

| Field | Description |
| --- | --- |
| `schemaVersion` | `1` |
| `engine` | `"searchfn"` |
| `fields` | Indexed field names (title, summary, headings, tags, body). |
| `scopes` | Active scopes. |
| `bodyIndexing` | Resolved mode: `full` \| `summary` \| `disabled`. |
| `documents` | Serializable document list. |
| `snapshot` | Engine snapshot for browser runtime. |
| `diagnostics` | Non-fatal issues. |
| `bytes` | Serialized size. |

Runtime querying lives in **`createDocsSearchRuntime`** (see [Search](../../core-concepts/search) in Core concepts).
