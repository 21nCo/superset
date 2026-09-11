---
title: "@docsfn/next"
description: Next.js App Router helpers for resolving docs routes, static params, page metadata, and search JSON responses.
---

# @docsfn/next

Bridge between **`DocsManifest`** data and **Next.js App Router** (`generateStaticParams`, `generateMetadata`, route handlers).

```bash
npm install @docsfn/next
```

Peer: **`@docsfn/core`**. Use with a generated manifest (see **`@docsfn/cli`**).

## Types

### `DocsRouteEntry`

Discriminated union:

- `{ kind: "page"; id; route; page: DocPage }`
- `{ kind: "api"; id; route; api: ApiReference }`
- `{ kind: "post"; id; route; post: BlogPost }`

### `NextDocsPageSurface`

Resolved UI surface for React layouts: `route`, optional `title` / `description`, **`canonicalPath`**, **`canonicalUrl`**, optional `sidebarId`, `headings`, `breadcrumbs`, `pagination`, `topNav`, `versions`, `currentVersion`, `versionLinks`, optional `editLink` / `pageActions`.

Supporting types: **`NextDocsPageLink`**, **`NextDocsPageBreadcrumbItem`**, **`NextDocsPagePagination`**.

### Options types

| Type | Fields |
| --- | --- |
| **`GenerateStaticParamsOptions`** | `basePath?`, `includeApiRoutes?` (default `true`) |
| **`GenerateVersionedStaticParamsOptions`** | `basePath?`, `mode?` (`"path-prefix"` \| `"path-segment"`) |
| **`ResolvePageOptions`** | `basePath?` (defaults normalize to `/docs`) |
| **`ResolveVersionedPageOptions`** | `basePath?`, `mode?` |
| **`GenerateMetadataOptions`** | `siteTitle?`, `canonicalUrl?` |
| **`ResolvePageSurfaceOptions`** | `basePath?`, `sidebarId?`, `homeLabel?`, `homeHref?`, `canonicalUrl?`, `pageActions?`, `editLink?`, `versionMode?` |
| **`SearchArtifactResponseInput`** | `artifact?`, `loadArtifact?`, `cacheControl?` |
| **`CollectionPostOptions`** | `includeDrafts?` |
| **`EmbedModeOptions`** | `param?` |

`SlugParam` accepted by slug-based helpers is `string | string[] | readonly string[] | undefined`.

## Route resolution

| Function | Returns |
| --- | --- |
| **`resolveDocsRouteData(slug, manifest, options?)`** | `DocsRouteEntry \| null` |
| **`resolveDocsRouteDataOrThrow(slug, manifest, options?)`** | `DocsRouteEntry` — throws **`DOCS_ROUTE_NOT_FOUND`** on miss |

## Page, API, and blog data

| Function | Returns |
| --- | --- |
| **`getPageData` / `getPageDataOrThrow`** | `DocPage` from slug under `basePath` |
| **`getVersionedPageData` / `getVersionedPageDataOrThrow`** | `DocPage` for versioned routes (`version` + `slug`) |
| **`getPostData` / `getPostDataOrThrow`** | `BlogPost` by normalized blog slug |
| **`getCollectionPosts(collectionId, manifest, options?)`** | Ordered dated entries for a named collection like `blog` or `changelog` |
| **`getCollectionPostData` / `getCollectionPostDataOrThrow`** | Single dated entry by collection + slug |
| **`getApiData(slug, manifest, options?)`** | `ApiReference \| null` — treats slug segments under `{basePath}/api/...` |

There is no `getApiDataOrThrow` variant in this package; handle `null` or use `resolveDocsRouteDataOrThrow` and branch on `kind`.

## Embed mode

| Function | Returns | Notes |
| --- | --- | --- |
| **`resolveEmbedMode(searchParams, options?)`** | `boolean` | Reads `?embed=1` by default; accepts Next-style `searchParams` objects. |
| **`isEmbedModeValue(value)`** | `boolean` | Normalizes raw query values such as `1`, `true`, `yes`, `on`, or an empty present param. |

## Static generation

| Function | Purpose |
| --- | --- |
| **`generateStaticParams(manifest, options?)`** | `Array<{ slug?: string[] }>` for `[...slug]` (or similar) catch-all segments |
| **`generateVersionedStaticParams(manifest, options?)`** | Adds `version` alongside optional `slug` |
| **`generateBlogParams(manifest)`** | `{ slug: string }[]` sorted by slug |
| **`generateCollectionParams(collectionId, manifest, options?)`** | `{ slug: string }[]` for any dated collection, e.g. `changelog` |
| **`generateApiParams(manifest, { catchAll: true })`** | Overview and child routes as `{ slug: string[] }[]` for `[...slug]`; omit `catchAll` for slash-delimited strings |

## Page metadata

**`generatePageMetadata(page, site)`**

- **`page`:** `DocPage`
- **`site`:** either a **`string`** (used as `siteTitle`) or **`GenerateMetadataOptions`**

Returns an object compatible with Next **`Metadata`**: `title`, `description`, `alternates.canonical`, `openGraph` (`title`, `description`, `url`).

## Surface for layouts

**`resolveDocsPageSurface(input)`**

- **`input`:** `{ manifest, route, page?, options? }`
- If **`page`** is omitted, the page is resolved from **`route`** via the manifest.

Returns **`NextDocsPageSurface`** (sidebar, breadcrumbs, pagination, version links, etc.).

**Aliases (same implementation):** **`resolveEmbeddedDocsSurface`**.

## Search route handler

**`createSearchArtifactResponse({ artifact?, loadArtifact?, cacheControl? })`**

Async; returns a Web **`Response`** with JSON (`DocsSearchArtifact`) and `content-type: application/json`. On failure, returns **500** with `{ code, message }`.

**Alias:** **`createDocsSearchArtifactResponse`**.

## Convenience aliases

| Alias | Underlying export |
| --- | --- |
| **`resolveEmbeddedDocsRouteData`** | `resolveDocsRouteData` |
| **`getDocsBlogPostData`** | `getPostData` |
| **`getDocsCollectionPostData`** | `getCollectionPostData` |
| **`getDocsCollectionPosts`** | `getCollectionPosts` |
| **`generateDocsBlogParams`** | `generateBlogParams` |
| **`generateDocsCollectionParams`** | `generateCollectionParams` |
| **`resolveDocsEmbedMode`** | `resolveEmbedMode` |

## Re-exports from `@docsfn/core`

**`assertDocsRouteAccess`**, **`maybeEmitAnalyticsEvent`**, **`createDocsAnalyticsEmitter`**, **`resolveDocsAuthMode`**, **`CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`**, **`CANONICAL_DOCS_AUTH_MODES`**, and types **`DocsAnalyticsEvent`**, **`DocsAuthMode`**.

## Example: doc page + metadata

```tsx
import {
  generateStaticParams as docsGenerateStaticParams,
  getPageDataOrThrow,
  generatePageMetadata,
  resolveDocsPageSurface,
} from "@docsfn/next";
import manifest from "../docsfn-manifest.json";

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateStaticParams() {
  return docsGenerateStaticParams(manifest);
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const page = getPageDataOrThrow(slug, manifest);
  return generatePageMetadata(page, { siteTitle: "My Docs" });
}

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const page = getPageDataOrThrow(slug, manifest);
  const route = page.path;
  const surface = resolveDocsPageSurface({ manifest, route, page });
  // pass surface to @docsfn/react DocsLayout, etc.
  return null;
}
```
