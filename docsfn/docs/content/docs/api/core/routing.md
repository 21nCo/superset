---
title: core — Routing
description: URL slugs, route building, and static param helpers in @docsfn/core.
---

# Routing (`@docsfn/core`)

## Slug utilities

| Function | Role |
| --- | --- |
| **`normalizeSlug(value)`** | Normalize a slug string (POSIX-style, trimmed segments). |
| **`slugToSegments` / `segmentsToSlug`** | Split/join path segments. |
| **`stripSourceExtension`** | Remove `.md` / `.mdx` etc. for logical paths. |
| **`deriveLogicalPathFromSourcePath`** | Map provider relative path → logical slug path. |

## `buildRoute(input)`

**`RouteBuildInput`:** collection, `sourcePath`, `frontmatter`, `config`.

**Returns** `RouteBuildResult`: `slug`, **`path`** (full app path), optional **`version`**, **`logicalPath`**.

- **Docs:** applies **version** segments when `config.versions.mode` is `path-prefix` or `path-segment` (version inferred from path + frontmatter via internal **`resolveVersionContext`** — not exported).
- **Pages:** base path `""` with page slug.
- **Blog:** `/blog/...` prefix.
- **API:** `/api/...` style logical prefix from OpenAPI layout.

## `assertRouteAvailability({ routes, path, sourceId })`

Ensures a single owner per URL; throws **`DOCS_ROUTE_CONFLICT`** on duplicates.

## `buildDocsStaticParams({ routes, basePath, versions? })`

Maps manifest route strings to `{ slug?: string[]; version?: string }` entries for adapters (SvelteKit / Next).
