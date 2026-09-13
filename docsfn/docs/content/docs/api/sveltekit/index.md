---
title: "@docsfn/sveltekit"
description: SvelteKit loaders, route resolution, static params, and search responses for docsfn.
---

# @docsfn/sveltekit

Bridge between **`DocsManifest`** data and **SvelteKit `Load` functions**, plus helpers for static adapters.

```bash
npm install @docsfn/sveltekit
```

## Types

### `DocsRouteEntry`

Discriminated union:

- `{ kind: "page"; id; route; page: DocPage }`
- `{ kind: "api"; id; route; api: ApiReference }`
- `{ kind: "post"; id; route; post: BlogPost }`

### `SvelteDocsPageSurface`

Resolved UI surface: `route`, optional `title`/`description`, `canonicalPath`, `canonicalUrl`, `sidebarId`, `headings`, `breadcrumbs`, `pagination`, `topNav`, version fields, optional `editLink` / `pageActions`.

Supporting types: **`DocsPageLink`**, **`DocsPageBreadcrumbItem`**, **`DocsPagePagination`**.

## Route resolution

| Function | Returns | Notes |
| --- | --- | --- |
| **`resolveDocsRouteData(slug, manifest, options?)`** | `DocsRouteEntry \| null` | `slug` may be `string`, `string[]`, or undefined (root). |
| **`resolveDocsRouteDataOrThrow`** | `DocsRouteEntry` | Throws **`DOCS_ROUTE_NOT_FOUND`** on miss. |

**`ResolvePageOptions`:** `{ basePath?: string }` (defaults normalize to `/docs`).

## Page / API / post getters

| Function | Returns |
| --- | --- |
| **`getPageData` / `getPageDataOrThrow`** | `DocPage` |
| **`getVersionedPageData` / `getVersionedPageDataOrThrow`** | `DocPage` within a versioned path |
| **`getApiData` / `getApiDataOrThrow`** | `ApiReference` |
| **`getPostData` / `getPostDataOrThrow`** | `BlogPost` by blog slug |
| **`getCollectionPosts(collectionId, manifest, options?)`** | Ordered dated entries for a named collection like `blog` or `changelog` |
| **`getCollectionPostData` / `getCollectionPostDataOrThrow`** | Single dated entry by collection + slug |

**`CollectionPostOptions`:** `{ includeDrafts?: boolean }`.

## Embed mode

| Function | Returns | Notes |
| --- | --- | --- |
| **`resolveEmbedMode(urlOrSearchParams, options?)`** | `boolean` | Reads `?embed=1` by default; useful for hiding site chrome inside product apps. |
| **`isEmbedModeValue(value)`** | `boolean` | Normalizes raw query values such as `1`, `true`, `yes`, `on`, or an empty present param. |

**`EmbedModeOptions`:** `{ param?: string }`.

## Loader wrappers (`load*`)

Thin wrappers mapping errors to SvelteKit **`error(404, ...)`**:

- **`loadPageData`**, **`loadVersionedPageData`**, **`loadPostData`**, **`loadCollectionPostData`**, **`loadApiData`**

## Static generation

| Function | Purpose |
| --- | --- |
| **`generateStaticParams(manifest, options?)`** | `{ slug?: string }[]` for `[...slug]` routes. |
| **`generateVersionedStaticParams`** | Adds `version` param. |
| **`getStaticPaths` / `getVersionedStaticPaths`** | `{ params }[]` convenience. |
| **`generateBlogParams` / `generateApiParams`** | Param lists for blog/api segments. |
| **`generateCollectionParams(collectionId, manifest, options?)`** | Param list for any dated collection, e.g. `changelog`. |
| **`getBlogPaths` / `getApiPaths`** | `{ params: { slug } }[]` helpers. |
| **`getCollectionPaths(collectionId, manifest, options?)`** | `{ params: { slug } }[]` for any dated collection. |

**`GenerateStaticParamsOptions`:** `basePath?`, `includeApiRoutes?` (default true).

## Surface

**`resolveDocsPageSurface({ manifest, route, page?, options? })`**

**`ResolvePageSurfaceOptions`:** `basePath`, `sidebarId`, `homeLabel`/`homeHref`, `canonicalUrl`, `pageActions`, `editLink`, **`versionMode`**.

## Load factories

| Factory | Params event | Returns (success) |
| --- | --- | --- |
| **`createPageLoad(manifest, options?)`** | `{ slug?: string }` | `{ page, route, surface, manifest }` |
| **`createVersionedPageLoad(manifest, options?)`** | `{ version, slug?: string }` | Adds `version`. |
| **`createPostLoad(manifest)`** | `{ slug: string }` | `{ post, manifest }` |
| **`createCollectionPostLoad(collectionId, manifest, options?)`** | `{ slug: string }` | `{ collection, post, manifest }` |
| **`createApiLoad(manifest, options?)`** | `{ slug?: string }` | `{ api, manifest }` |

All map **`DOCS_ROUTE_NOT_FOUND`** to HTTP 404 via SvelteKit **`error`**.

## Search endpoint

**`createSearchArtifactResponse({ artifact?, loadArtifact?, cacheControl? })`**

Returns a **`Response`** with JSON body, appropriate content type, and default cache headers. Provide either **`artifact`** or async **`loadArtifact`**.

## Re-exports

Security + analytics symbols from **`@docsfn/core`** (`assertDocsRouteAccess`, `maybeEmitAnalyticsEvent`, …) for convenience.
