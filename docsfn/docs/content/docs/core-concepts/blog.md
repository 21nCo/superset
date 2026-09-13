---
title: Blog
description: Blog posts, frontmatter, drafts, tags, archives, and manifest surfaces in docsfn.
---

# Blog

Blog content lives in the legacy **blog** collection (by default `content/blog/` or the path set in `content.blogDir`). Posts are Markdown files; the dated-content engine turns them into **`BlogPost`** records and a **`BlogManifestSurface`** on the docs manifest.

For product changelog, use `collections.changelog` so changelog is represented as its own collection instead of being configured as a fake blog.

See also: [Content format](./content-format), [RSS](./rss), [Search](./search).

## Directory setup

Point `content.blogDir` at a folder of `.md` / `.mdx` files for a normal blog. Each file becomes a post with a URL derived from its path. The default public section is `{site.basePath}/blog`.

```ts
content: {
  blogDir: "content/blog",
},
blog: {
  routeBase: "/docs/blog",
},
```

For changelog:

```ts
collections: {
  changelog: {
    dir: "content/changelog",
    routeBase: "/changelog",
    feedPath: "/changelog/rss.xml",
    label: "Changelog",
    scope: "changelog",
  },
},
```

## Required frontmatter

- **`title`** — Display title (also used in listings and RSS).
- **`date`** — Publish date string; must parse to a finite timestamp (ISO-8601 dates like `2026-03-22` work).

Missing or invalid `date` fails manifest build with **`DOCS_ARTIFACT_INVALID`**.

## Optional frontmatter

| Field | Type | Notes |
| --- | --- | --- |
| `author` | string or `{ name: string }` | Normalized to a single author string. |
| `tags` | string array | Trimmed, lowercased, deduped, sorted (see below). |
| `excerpt` | string | Preferred short text; else body is summarized (~220 chars). |
| `summary` | string | May be carried on normalized posts; canonical build primarily uses **`excerpt`** plus body summarization for listing/RSS text. |
| `draft` | boolean / string / number | See drafts below. |

## Draft filtering

Internally, the build pipeline treats a post as draft when:

- `draft: true` (boolean), or
- string **`"true"`**, **`"yes"`** (case-insensitive), or **`"1"`**, or
- number **`1`**.

**`buildCanonicalBlogRecords`** accepts **`preview`**: when `preview: true`, drafts are **included**; otherwise they are **filtered out** of listings, tags, archives, and RSS ordering.

## Tag normalization

Tags are trimmed, compared **case-insensitively**, deduped, then **sorted** for stable manifests. Each tag gets a **slug** for URLs (`toTagSlug`: lowercase, non-alphanumerics → `-`).

## Archives and page size

Archives default to **`pageSize: 10`** (minimum 1). Pages are:

- **Page 1:** `{listRoute}` (e.g. `/docs/blog` when `basePath` is `/docs`).
- **Page N:** `{listRoute}/page/{N}`.

Each **`BlogArchivePage`** records `postIds`, `totalPages`, `totalPosts`, and `pageSize`.

## Tag index pages

For each tag, **`BlogTagIndex`** includes `tag`, `slug`, `path` (`{listRoute}/tags/{slug}`), and ordered `postIds`.

## Listing and post routes

Typical app routes (exact prefixes depend on `site.basePath`, `blog.routeBase`, or `collections.<id>.routeBase`):

- **Index / paginated list** — `listRoute` and `.../page/:page`
- **Post** — `{listRoute}/{postSlug}`
- **Tag** — `{listRoute}/tags/:slug`

Your SvelteKit or Next adapter should use **`manifest.blog`** for legacy blog params and links. For changelog or other dated sections, use **`manifest.collections.<id>`**.

## `BlogManifestSurface`

Exposed on **`DocsManifest.blog`**:

| Field | Role |
| --- | --- |
| `listRoute` | Base path for the blog section. |
| `feedPath` | RSS path (e.g. `/docs/blog/rss.xml`). |
| `postOrder` | Stable ordered post ids (newest first by publish time). |
| `tags` | Map of tag string → tag index metadata. |
| `archives` | Paginated archive descriptors. |

Posts themselves live in **`manifest.posts`** keyed by id.

Named dated collections are exposed on **`DocsManifest.collections`** with the same surface shape plus `id`, `label`, and `scope`.
