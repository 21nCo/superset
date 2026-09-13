---
title: SEO
description: Site metadata, canonical URLs, base paths, and how to wire head tags in SvelteKit.
---

# SEO

docsfn keeps SEO-related data in **`DocsConfig.site`**, per-page **frontmatter**, and the **page surface** returned by framework helpers.

See also: [Configuration](./configuration), [Navigation](./navigation).

## `site.title` and `site.description`

- **`site.title`**: Default site / brand string. The SvelteKit docs template uses it as a **fallback document title** when a page has no title.
- **`site.description`**: Optional site-wide description; consumers can map it to a default meta description tag on non-doc routes.

Per-page **`title`** and **`description`** come from Markdown frontmatter and override the defaults in your layout.

## `site.canonicalUrl`

When set (recommended in production), it should be the **origin** of the deployed site, e.g. `https://docs.example.com`. Trailing slashes are normalized away when joining paths.

**`resolveDocsPageSurface`** (SvelteKit) computes:

- **`canonicalPath`** — the app route for the page (e.g. `/docs/core-concepts/search`).
- **`canonicalUrl`** — `canonicalUrl` origin + path via **`resolveCanonicalUrl`**.

Use **`surface.canonicalUrl`** for the document’s canonical link element and Open Graph `og:url`.

## `site.basePath`

`basePath` is your application’s **URL prefix** (e.g. `/docs` when the app is mounted under a subpath). Pass the same value into **`resolveDocsRouteDataOrThrow`** and **`resolveDocsPageSurface`** so slugs, sidebars, and breadcrumbs align with how users reach the site.

Canonical URLs use the **route path**; ensure your reverse proxy or host preserves the public origin in **`site.canonicalUrl`**.

## Per-page title and description

In Markdown:

```yaml
---
title: Search
description: Configure docsfn search scopes, body indexing, and artifacts.
---
```

The compiled **`DocPage`** carries these fields; **`resolveDocsPageSurface`** exposes them as **`surface.title`** and **`surface.description`**.

## Edit link pattern

`site.editLink` may include a **`pattern`** string with **`{path}`** replaced by the source file path (framework-dependent). The surface exposes **`editLink`** when your loader passes options through—use it for “Edit this page” links in the layout.

Example pattern:

```txt
https://github.com/org/repo/edit/main/docs/{path}
```

## Generating meta tags in SvelteKit

After **`resolveDocsPageSurface`** in `+page.server.ts`, your `+page.svelte` can render:

```text
<!-- +page.svelte: use svelte:head with title, meta description, and link canonical
     bound to data.surface.title, data.surface.description, data.surface.canonicalUrl -->
```

The official docsfn docs site currently sets **title** and **description**; you can extend the same pattern with **`canonicalUrl`** as above.

## Open Graph and social sharing

For richer previews, add tags derived from the same surface:

- **`og:title`** — `surface.title` or site title.
- **`og:description`** — `surface.description`.
- **`og:url`** — `surface.canonicalUrl`.
- **`twitter:card`** — typically `summary` or `summary_large_image`.

Use absolute URLs for `og:image` if you add artwork. Consistency between **canonical** and **og:url** avoids duplicate-URL issues in crawlers.
