---
title: Search
description: Configure docsfn search scopes, body indexing, artifacts, and the DocsSearch UI.
---

# Search

docsfn builds a **search artifact** (`DocsSearchArtifact`) at compile time and serves it as JSON. Search is local/static by default: the browser loads that artifact (or fetches it lazily) and queries it in-process.

The default engine is **searchfn**. Internally, docsfn now talks to search through a small adapter boundary, so searchfn remains the built-in starting point while other engines can be added later without rewriting the docs UI or manifest pipeline.

See also: [Configuration](./configuration), [CLI](./cli), [Content providers](./content-providers).

## Enabling search

In **`docsfn.config.ts`**:

```ts
search: {
  enabled: true,
  scopes: ["docs", "api", "blog", "changelog"],
  bodyIndexing: "summary",
  maxArtifactBytes: 1_500_000,
},
```

- **`enabled`**: When `false`, the pipeline skips emitting `search.json` in CLI artifact writes (and you should avoid exposing an empty endpoint).

## Scopes

Each indexed document carries a **`scope`** (`DocsSearchScope`). The runtime can filter results:

- **`docs`** — documentation pages.
- **`api`** — API reference entries, including OpenAPI routes and any `/docs/api...` markdown routes that you classify with `search.routeScopeOverrides`.
- **`blog`** — blog posts.
- **custom scopes** — named dated collections can define scopes such as **`changelog`**.

`DocsSearch` can filter by any scopes present in the artifact. Pass a narrower `scopes` prop if your UI should show only selected sections.

### Route-based scope overrides

Use `search.routeScopeOverrides` when a route should search like API content even though the source file lives in the docs collection:

```ts
search: {
  enabled: true,
  scopes: ["docs", "api", "blog", "changelog"],
  routeScopeOverrides: [
    { pattern: "/docs/api", scope: "api" },
    { pattern: "/docs/api/**", scope: "api" },
  ],
},
```

That is the supported way to make Markdown package docs under `content/docs/api` appear in the API scope. `content.apiDir` should still point at your OpenAPI spec directory such as `content/api`.

## Body indexing modes

`search.bodyIndexing` controls how much text is indexed per page/post:

| Mode | Behavior |
| --- | --- |
| `"full"` | Indexes the **entire** Markdown body (largest artifacts, best recall on long pages). |
| `"summary"` | Indexes a **short plain-text summary** (default helper uses roughly the first **220** characters of normalized body text when no description/excerpt exists). |
| `"disabled"` | Title and metadata only; minimal artifact size. |

### Trade-offs

- **`full`** improves matching inside long prose but **increases JSON size** and parse/hydrate cost in the browser.
- **`summary`** balances size and quality for typical docs sites.
- **`disabled`** is ideal when you only need title/path search.

## `maxArtifactBytes`

If the serialized artifact size exceeds **`search.maxArtifactBytes`**, the build emits a warning diagnostic (`DOCS_ARTIFACT_INVALID`) and still succeeds. Treat warnings as failures in CI if you want this limit to be a hard guardrail when enabling `full` body indexing or very large corpora.

## Serving the artifact in SvelteKit

Expose a route that returns the JSON artifact with `createSearchArtifactResponse` from **`@docsfn/sveltekit`**:

```ts
// src/routes/search.json/+server.ts
import { createSearchArtifactResponse } from "@docsfn/sveltekit";

export const GET = async ({ locals }) => {
  const source = await locals.getDocsSource(); // your app’s helper
  return createSearchArtifactResponse({ artifact: source.searchArtifact });
};
```

The helper sets JSON headers and serializes the artifact your layout/build already produced.

## `DocsSearch` component

From **`@docsfn/svelte`**:

- Pass **`searchArtifact`** or **`loadSearchArtifact`** for lazy loading.
- **`placeholder`**, **`initialScope`**, and **`scopes`** tune the dialog.
- Optional **`analytics`** hooks into `maybeEmitAnalyticsEvent` from core.

### Keyboard shortcut: Cmd / Ctrl + K

`DocsSearch` registers **`Meta+K` / `Ctrl+K`** globally to open the dialog (see `onMount` in `DocsSearch.svelte`).

### Scope filtering

The dialog UI lets users restrict queries to **All**, **Docs**, **API**, **Blog**, or **Changelog**; the runtime passes the selected scope into **`createDocsSearchRuntime`’s `query()`**.

## How scoring works (brief)

The build captures canonical search documents and engine metadata in the artifact. At query time, `createDocsSearchRuntime()` reads the artifact engine, resolves the matching docsfn search adapter, and returns results sorted by **score**, **title**, and **path** for stable ordering.

You do not configure BM25 weights in `docsfn.config.ts`; tuning is achieved by **scope**, **body indexing mode**, and content structure.
