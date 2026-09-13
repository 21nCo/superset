---
title: Quick Start
description: Minimal docsfn config, first Markdown page, meta.json, and dev workflow for SvelteKit and Next.js.
---

# Quick Start

This page walks through a **minimal** docs site: one config file, one doc page, one `meta.json`, and the CLI dev loop. Paths assume your app root is the same directory as `docsfn.config.ts`.

## 1. Create `docsfn.config.ts`

```typescript
import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "My Docs",
    description: "Documentation powered by docsfn",
    basePath: "/docs",
  },
  compat: { preset: "none" },
  content: {
    root: ".",
    docsDir: "content/docs",
    blogDir: "content/blog",
    apiDir: "content/api",
    pagesDir: "content/pages",
    assetsDir: "static",
    metaFileName: "meta.json",
  },
  navigation: {
    topNav: [
      { label: "Docs", href: "/docs" },
      { label: "Blog", href: "/blog" },
    ],
    sidebars: {
      docs: { title: "Documentation", root: true, include: ["docs/**"] },
    },
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog"],
    bodyIndexing: "summary",
  },
  auth: { enabled: false, mode: "public" },
  analytics: { enabled: false, provider: "watchfn", respectDnt: true },
};

export default config;
```

`schemaVersion` must be `1`. Use `compat.preset: "none"` for native Markdown (no Fumadocs transform).

## 2. Add your first page

Create `content/docs/index.md`:

```markdown
---
title: Welcome
description: First page
---

# Welcome

This is your first docsfn page.
```

Create `content/docs/meta.json`:

```json
{
  "title": "Documentation",
  "pages": ["index"]
}
```

## 3. Validate and build artifacts

From the project root:

```bash
npx docsfn validate --root .
npx docsfn build --root . --out-dir .docsfn
```

Fix any reported diagnostics before continuing.

## 4. SvelteKit wiring (summary)

1. Add a root `+layout.server.ts` that calls `loadDocsConfig`, `FsContentProvider`, `buildManifest`, and `buildSearchIndex` (singleton cache pattern).
2. Add `docs/[...slug]/+page.server.ts` (or universal load) using `resolveDocsRouteDataOrThrow` and `resolveDocsPageSurface` from `@docsfn/sveltekit`.
3. Render with `@docsfn/svelte` components (`TopBar`, `DocsSidebar`, `DocsContent` or compiled HTML, `Breadcrumbs`, `Pagination`, `DocsToc`).
4. Expose `GET /search.json` with `createSearchArtifactResponse`.

See the **docsfn** monorepo `docsfn/docs` app for a full reference implementation.

## 5. Next.js wiring (summary)

1. Load config and build manifest/search on the server (e.g. in a shared module used by `generateStaticParams` / route handlers).
2. Use `@docsfn/next` helpers for static params, page data, metadata, and search responses.
3. Compose `@docsfn/react` components in your App Router layouts and pages.

Exact imports evolve with releases; align with the version of `@docsfn/next` you install.

## 6. Run the dev server

- **CLI watch** (artifacts only): `npx docsfn dev --root .`
- **Framework dev**: run `vite dev` / `next dev` as usual; reload when content or config changes.

You now have a validated config, a routed doc page, and a repeatable build. Next, read [Project Structure](./project-structure) and [Configuration](../core-concepts/configuration).
