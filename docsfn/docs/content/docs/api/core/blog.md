---
title: core — Blog
description: Dated collection canonicalization types and helpers in @docsfn/core.
---

# Blog (`@docsfn/core`)

## `buildCanonicalDatedCollectionRecords(input)`

Generic dated-content canonicalizer for blog, changelog, release notes, and similar one-file-per-update collections.

**`BuildCanonicalDatedCollectionRecordsInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `posts` | `NormalizedPostRecord[]` | Normalized dated sources from manifest pipeline. |
| `collectionId?` | `string` | Collection id such as `blog` or `changelog`. |
| `label?` | `string` | Display label such as `Blog` or `Changelog`. |
| `searchScope?` | `string` | Search scope assigned to this collection. |
| `routeBase?` | `string` | Public list/post/tag route base. |
| `feedPath?` | `string` | Public RSS route. |
| `basePath?` | `string` | Defaults to `/docs` normalization for list routes. |
| `preview?` | `boolean` | When true, **draft** posts are retained. |
| `pageSize?` | `number` | Archive size (minimum **1**, default **10**). |

**Returns:** `CanonicalDatedCollectionBuildResult` — `{ id, label, scope, posts, listRoute, feedPath, postOrder, tags, archives }`.

## `buildCanonicalBlogRecords(input)`

Compatibility wrapper around **`buildCanonicalDatedCollectionRecords`** for the legacy blog surface.

**`BuildCanonicalBlogRecordsInput`:**

| Field | Type | Description |
| --- | --- | --- |
| `posts` | `NormalizedPostRecord[]` | Normalized blog sources from manifest pipeline. |
| `routeBase?` | `string` | Public blog route base. |
| `feedPath?` | `string` | Public blog RSS route. |
| `basePath?` | `string` | Defaults to `/docs` normalization for list routes. |
| `preview?` | `boolean` | When true, **draft** posts are retained. |
| `pageSize?` | `number` | Archive size (minimum **1**, default **10**). |

**Returns:** `CanonicalBlogBuildResult` — `{ posts, listRoute, feedPath, postOrder, tags, archives }` (plus the posts array matches **`BlogPost`** shape).

## `BlogManifestSurface`

| Field | Description |
| --- | --- |
| `listRoute` | Blog index path. |
| `feedPath` | RSS path suffix used by **`generateRSSFeed`**. |
| `postOrder` | Ordered post ids (newest first). |
| `tags` | Map tag label → **`BlogTagIndex`**. |
| `archives` | `BlogArchivePage[]` pagination descriptors. |

## `BlogTagIndex` / `BlogArchivePage`

See **`types.ts`** — include `path`, `slug`, `postIds`, and archive `page` / `totalPages` / `pageSize`.

## Helpers

- **`assertValidBlogPublishMetadata(post)`** — validates date fields.
- **`resolveBlogLastBuildDate(posts)`** — RSS **`lastBuildDate`**.
