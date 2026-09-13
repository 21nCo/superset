---
title: Project Structure
description: Typical directories for a docsfn-powered app and how they map to URLs and collections.
---

# Project Structure

Below is a **typical** layout for a SvelteKit (or similar) app using native docsfn content. Names match common `docsfn.config.ts` defaults; yours may differ if you override `content.*` paths.

## Annotated tree

```text
my-docs-site/
├── docsfn.config.ts          # Main docsfn configuration (required)
├── package.json
├── content/
│   ├── docs/                 # Docs collection → routes under site.basePath (e.g. /docs/...)
│   │   ├── meta.json         # Order/labels for top-level sections
│   │   ├── index.md          # URL: /docs (or /docs/ depending on slug rules)
│   │   ├── getting-started/
│   │   │   ├── meta.json
│   │   │   ├── index.md
│   │   │   └── ...
│   │   └── core-concepts/
│   │       └── ...
│   ├── blog/                   # Blog posts → /blog/[slug] (framework-specific)
│   ├── pages/                  # Optional “pages” collection (marketing, etc.)
│   └── api/                    # OpenAPI JSON/YAML only (.md ignored here)
├── static/                     # Static assets (maps to content.assetsDir)
│   └── images/
└── src/                        # Framework routes, layouts, adapters
    └── routes/
        ├── +layout.server.ts   # Load manifest + search artifact
        ├── docs/[...slug]/...
        └── search.json/...
```

## Directory roles

| Path | Purpose |
| --- | --- |
| `docsfn.config.ts` | Single source of truth for site, content roots, navigation, search, auth, analytics. |
| `content/docs/` | Primary documentation Markdown + per-folder `meta.json`. |
| `content/blog/` | Blog Markdown; frontmatter drives listing and RSS. |
| `content/pages/` | Extra Markdown “pages” collection if you enable it in the provider. |
| `content/api/` | OpenAPI specs (`.json`, `.yaml`, `.yml`). Hand-written API **Markdown** usually lives under `content/docs/...` (see [Content format](../core-concepts/content-format)). |
| `static/` (or `public/`) | Assets served as files; referenced from Markdown as needed. |
| `src/routes/` (SvelteKit) | HTTP routes: doc catch-all, blog, search JSON, RSS, etc. |

## How content maps to URLs

- **`site.basePath`** (commonly `/docs`) is the prefix for **docs** pages.
- A file `content/docs/guides/setup.md` becomes a doc whose path is derived from the **slug** built by the manifest (typically `/docs/guides/setup`).
- `content/docs/guides/index.md` is usually the section root (e.g. `/docs/guides`).
- **Blog** paths come from `content/blog/*.md` and your framework’s blog routes (`/blog`, `/blog/[slug]`).

Exact slugs and collision rules are defined in `@docsfn/core` manifest generation; keep directory names URL-safe and use `meta.json` for labels and ordering.

## Collections

docsfn distinguishes **collections** (`docs`, `pages`, `blog`, `api`, `assets`). The filesystem provider reads directories configured in `content.docsDir`, `content.blogDir`, etc., relative to `content.root`.

For a deeper reference, see [Content format](../core-concepts/content-format) and [Configuration](../core-concepts/configuration).
