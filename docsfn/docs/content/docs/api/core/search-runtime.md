---
title: core — Search Runtime
description: Client-side search runtime for querying DocsSearchArtifact in @docsfn/core.
---

# Search Runtime (`@docsfn/core`)

The search runtime provides client-side querying over a **`DocsSearchArtifact`**. Import from `@docsfn/core/search-runtime` or `@docsfn/core`.

## `createDocsSearchRuntime(input)`

Factory that returns a **`DocsSearchRuntime`** instance.

**`CreateDocsSearchRuntimeInput`:**

| Field | Type | Description |
| --- | --- | --- |
| **`artifact`** | `DocsSearchArtifact?` | Inline artifact |
| **`loadArtifact`** | `() => Promise<DocsSearchArtifact>?` | Lazy loader |

Provide either `artifact` or `loadArtifact`. If neither is given, methods throw `DOCS_ARTIFACT_INVALID`.

## `DocsSearchRuntime`

| Method | Returns | Description |
| --- | --- | --- |
| **`ensureReady()`** | `Promise<void>` | Loads and validates the artifact, initializes the search engine. |
| **`query(input)`** | `Promise<DocsSearchRuntimeResultItem[]>` | Executes a search query with optional scope filter and limit. |
| **`getScopes()`** | `Promise<DocsSearchScope[]>` | Returns available scopes from the loaded artifact. |

## `DocsSearchRuntimeQueryInput`

| Field | Type | Description |
| --- | --- | --- |
| **`query`** | `string` | Search query text |
| **`scope`** | `DocsSearchScopeFilter?` | `"docs"` \| `"api"` \| `"blog"` \| `"all"` (default `"all"`) |
| **`limit`** | `number?` | Max results (default 20) |

## `DocsSearchRuntimeResultItem`

| Field | Type | Description |
| --- | --- | --- |
| **`id`** | `string` | Document id |
| **`scope`** | `DocsSearchScope` | `"docs"` \| `"api"` \| `"blog"` |
| **`kind`** | `"page"` \| `"api"` \| `"post"` | Content kind |
| **`path`** | `string` | Route path |
| **`title`** | `string` | Document title |
| **`summary`** | `string` | Short text snippet |
| **`score`** | `number` | Relevance score (higher is better) |

Results are sorted by score descending, then title, then path, then id for deterministic ordering.

## `DocsSearchScopeFilter`

```ts
type DocsSearchScopeFilter = DocsSearchScope | "all";
```

## Search index types

### `DocsSearchBodyIndexing`

```ts
type DocsSearchBodyIndexing = "full" | "summary" | "disabled";
```

Controls the granularity of body text stored in the search index. Maps to `search.bodyIndexing` in **`DocsConfig`**.

### `DocsSearchDocumentKind`

```ts
type DocsSearchDocumentKind = "page" | "api" | "post";
```

Discriminant for the kind of content a search document represents.

### `DocsSearchDocument`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Stable document identifier. |
| `scope` | `DocsSearchScope` | Which collection scope (`"docs"`, `"api"`, `"blog"`). |
| `kind` | `DocsSearchDocumentKind` | Content kind. |
| `path` | `string` | Route path. |
| `title` | `string` | Document title. |
| `summary` | `string` | Short text summary. |
| `headings` | `string[]` | Extracted heading texts. |
| `tags` | `string[]` | Associated tags. |
| `body` | `string` | Indexed body text (depth depends on `bodyIndexing`). |

## `resolveSearchScopeForRoute`

```ts
resolveSearchScopeForRoute(input: {
  route: string;
  kind: DocsSearchDocumentKind;
  routeScopeOverrides?: DocsSearchRouteScopeOverride[];
}): DocsSearchScope
```

Resolves the effective search scope for a given route. If `routeScopeOverrides` contains a pattern matching the route, the override scope is returned; otherwise the scope is inferred from `kind` (`"page"` → `"docs"`, `"api"` → `"api"`, `"post"` → `"blog"`). Used internally by **`buildSearchIndex`** and available for custom index pipelines.
