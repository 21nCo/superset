---
title: RSS
description: RSS 2.0 blog feeds from the manifest, channel fields, and serving in SvelteKit.
---

# RSS

docsfn generates **RSS 2.0** XML from **`DocsManifest`** blog data via **`generateRSSFeed`** in **`@docsfn/core`**.

See also: [Blog](./blog).

## Format

Output is XML with:

- **`rss` root** — `version="2.0"` and **`xmlns:atom`** for Atom links.
- **`channel`** — `title`, `description`, `link`, `language` (default `en`), **`lastBuildDate`**, **`atom:link`** (self).
- **`item`** per post — `title` (CDATA), `link`, `guid` (permaLink true), `pubDate` (RFC-822 via `Date#toUTCString`), optional `description` (CDATA from excerpt/summary), optional `author`, **`category`** per tag.

## Data sources

- Post order prefers **`manifest.blog.postOrder`**; otherwise posts are sorted by publish timestamp and slug.
- **`lastBuildDate`** uses **`resolveBlogLastBuildDate`** over the ordered set.
- Feed path for the self link defaults to **`manifest.blog.feedPath`** or **`/rss.xml`** relative to the blog link you pass in.

## Atom self-link

The channel includes:

`atom:link` with `rel="self"`, `type="application/rss+xml"`, and `href` set to `{blogOrigin}{feedPath}`.

## Serving in SvelteKit

Call **`generateRSSFeed(manifest, { title, description, link })`** in a **`+server.ts`** and return **`application/rss+xml`**:

- **`link`** — Public blog index URL (e.g. `url.origin + "/blog"`).
- Title/description — Usually from `config.site` plus a “Blog” suffix.

The docsfn docs site implements **`GET /blog/rss.xml`** this way.

## Next.js

Use a **Route Handler** or **`getServerSideProps`-less** static route with the same helper; set the `Content-Type` header to RSS XML.
