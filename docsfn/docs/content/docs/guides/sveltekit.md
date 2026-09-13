---
title: SvelteKit Integration
description: Build a docsfn documentation site on SvelteKit 2 with Svelte 5.
---

# SvelteKit Integration

This guide mirrors the layout used by the official docsfn docs app: a **singleton manifest + search artifact** loaded from the root layout, a **`docs/[...slug]`** catch-all for docs and API pages, **blog** routes, **`/search.json`**, and Vite aliases so the browser bundle never pulls Node-only code from `@docsfn/core`.

## Prerequisites

- **SvelteKit 2** and **Svelte 5**
- **Node.js 18+** (20+ recommended)
- **TypeScript** enabled in the Kit project

## Svelte `script` blocks in this guide

docsfn scans Markdown for unsafe HTML. A normal Svelte opening **scr**/**ipt** tag is flagged, so examples below split it across two lines. When you copy a block, **join the first two lines into one valid opening tag**. Closing tags stay on a single line (they are safe).

---

## Step 1 — Create a SvelteKit project

```bash
npm create svelte@latest my-docs
cd my-docs
npm install
```

Enable TypeScript and choose Svelte 5 syntax in the wizard if prompted.

---

## Step 2 — Install packages

```bash
npm install @docsfn/core @docsfn/sveltekit @docsfn/svelte @docsfn/provider-fs
npm install -D @docsfn/cli
```

Optional: add **`@tailwindcss/vite`** and Tailwind v4 if you want utility styling like the reference site.

---

## Step 3 — Configure `svelte.config.js` aliases

Point Kit’s resolver at the published packages (or monorepo paths while developing):

```js
// svelte.config.js
import path from "node:path";
import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const dirname = path.dirname(new URL(import.meta.url).pathname);

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};
```

Installed apps should import the published package entry points directly. Reserve aliases for local monorepo development only.

---

## Step 4 — Public Svelte component imports

Import shipped components from `@docsfn/svelte` public exports. Use either the package root or the documented `.svelte` subpaths, but never internal package source directories:

```svelte
<script lang="ts">
  import TopBar from "@docsfn/svelte/TopBar.svelte";
  import Breadcrumbs from "@docsfn/svelte/Breadcrumbs.svelte";
  import Pagination from "@docsfn/svelte/Pagination.svelte";
  import DocsSidebar from "@docsfn/svelte/DocsSidebar.svelte";
  import DocsToc from "@docsfn/svelte/DocsToc.svelte";
  import ApiReferenceRenderer from "@docsfn/svelte/ApiReferenceRenderer.svelte";
  import DocsSearch from "@docsfn/svelte/DocsSearch.svelte";
</script>
```

---

## Step 5 — `docsfn.config.ts`

Place at the project root (next to `package.json`). Minimal example:

```ts
// docsfn.config.ts
import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "My docs",
    description: "Documentation",
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
      docs: { title: "Docs", root: true, include: ["docs/**"] },
      api: { title: "API", root: true, include: ["docs/api/**"] },
    },
  },
  search: { enabled: true, scopes: ["docs", "api", "blog"], bodyIndexing: "summary" },
  auth: { enabled: false, mode: "public" },
  analytics: { enabled: false, provider: "watchfn", respectDnt: true },
};

export default config;
```

Reserve the API collection for OpenAPI specs. If you also want hand-written package docs at `/docs/api/...`, keep those Markdown files under `content/docs/api` and classify them with:

```ts
search: {
  enabled: true,
  scopes: ["docs", "api", "blog"],
  bodyIndexing: "summary",
  routeScopeOverrides: [
    { pattern: "/docs/api", scope: "api" },
    { pattern: "/docs/api/**", scope: "api" },
  ],
},
navigation: {
  sidebars: {
    docs: { title: "Docs", root: true, include: ["docs/**"] },
    api: { title: "API", root: true, include: ["docs/api/**"] },
  },
},
```

---

## Step 6 — Server module: load manifest + search

Create **`src/lib/server/docs-site-source.ts`** (same pattern as this repo’s docs app):

```ts
// src/lib/server/docs-site-source.ts
import path from "node:path";
import {
  buildManifest,
  buildSearchIndex,
  loadDocsConfig,
  type DocsCompatPreset,
  type DocsConfig,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

export interface DocsSiteSource {
  siteRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
  config: DocsConfig;
}

let sourcePromise: Promise<DocsSiteSource> | null = null;

export async function loadDocsSiteSource(): Promise<DocsSiteSource> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      const siteRoot = path.resolve(process.cwd());
      const config = await loadDocsConfig({ cwd: siteRoot });
      const provider = new FsContentProvider({
        root: siteRoot,
        docsDir: config.content.docsDir,
        pagesDir: config.content.pagesDir,
        blogDir: config.content.blogDir,
        apiDir: config.content.apiDir,
        assetsDir: config.content.assetsDir,
      });
      const manifest = await buildManifest(provider, config);
      const searchArtifact = await buildSearchIndex(manifest, {
        search: config.search,
        auth: config.auth,
      });

      return {
        siteRoot,
        manifest,
        searchArtifact,
        siteTitle: config.site.title,
        canonicalUrl: config.site.canonicalUrl,
        compatPreset: config.compat?.preset ?? "none",
        config,
      };
    })();
  }
  return sourcePromise;
}
```

---

## Step 7 — Root `+layout.server.ts`

```ts
// src/routes/+layout.server.ts
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async () => ({
  source: await loadDocsSiteSource(),
});
```

---

## Step 8 — Root `+layout.svelte`

Wire **TopBar** with nav from config and **`DocsSearch`** as the search trigger (search UI includes its own button and Cmd/Ctrl+K).

```svelte
<!-- src/routes/+layout.svelte — join the split opening tag when pasting -->
<s
cript lang="ts">
  import "../app.css";
  import TopBar from "@site/topbar";
  import DocsSearch from "@site/docs-search";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  interface Props {
    data: LayoutData;
    children: Snippet;
  }

  let { data, children }: Props = $props();
</script>

<div class="docsfn-site-root">
  <TopBar
    items={data.source.config.navigation?.topNav}
    searchTrigger={DocsSearch}
  />
  <main class="docsfn-site-main">
    {@render children()}
  </main>
</div>
```

Pass **`loadSearchArtifact`** if you do not have the artifact in `data` (see Step 11). You can wrap `DocsSearch` in a tiny component that calls `fetch("/search.json")`.

---

## Step 9 — Docs route `+page.server.ts`

```ts
// src/routes/docs/[...slug]/+page.server.ts
import { error } from "@sveltejs/kit";
import { compileSvelteContent, resolveMarkdownRelativeLinks } from "@docsfn/core";
import type { Sidebar } from "@docsfn/core";
import { resolveDocsPageSurface, resolveDocsRouteDataOrThrow } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

function isRouteNotFound(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    String((err as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND"
  );
}

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const basePath = "/docs";

  let routeEntry;
  try {
    routeEntry = resolveDocsRouteDataOrThrow(params.slug, source.manifest, { basePath });
  } catch (e) {
    if (isRouteNotFound(e)) throw error(404, e.message);
    throw e;
  }

  if (routeEntry.kind === "post") {
    throw error(404, "use /blog for posts");
  }

  const surface = resolveDocsPageSurface({
    manifest: source.manifest,
    route: routeEntry.route,
    page: routeEntry.kind === "page" ? routeEntry.page : undefined,
    options: {
      basePath,
      homeHref: basePath,
      canonicalUrl: source.canonicalUrl,
      versionMode: "path-prefix",
    },
  });

  const sidebarId = surface.sidebarId ?? "default";
  const sidebar: Sidebar | undefined = source.manifest.sidebars[sidebarId];

  const compiled =
    routeEntry.kind === "page"
      ? resolveMarkdownRelativeLinks({
          compiled: compileSvelteContent({ source: routeEntry.page.body, sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""), compatPreset: source.compatPreset }),
          route: routeEntry.route,
          sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""),
        })
      : undefined;

  return { routeEntry, surface, sidebar, compiled, siteTitle: source.siteTitle };
};
```

---

## Step 10 — Docs route `+page.svelte` (three-column layout)

Use **`DocsContent`** for Markdown pages and **`ApiReferenceRenderer`** for OpenAPI entries. Import shipped UI directly from the `@docsfn/svelte/*.svelte` public subpaths.

```svelte
<!-- src/routes/docs/[...slug]/+page.svelte -->
<s
cript lang="ts">
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import ApiReferenceRenderer from "@docsfn/svelte/ApiReferenceRenderer.svelte";
  import Breadcrumbs from "@docsfn/svelte/Breadcrumbs.svelte";
  import DocsSidebar from "@docsfn/svelte/DocsSidebar.svelte";
  import DocsToc from "@docsfn/svelte/DocsToc.svelte";
  import Pagination from "@docsfn/svelte/Pagination.svelte";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>{data.surface.title ?? data.siteTitle}</title>
</svelte:head>

<div class="docs-page-grid">
  {#if data.sidebar}
    <aside class="docs-sidebar">
      <DocsSidebar sidebar={data.sidebar} activePath={data.surface.route} />
    </aside>
  {/if}

  <section class="docs-main">
    <Breadcrumbs surface={data.surface} />
    {#if data.routeEntry.kind === "page" && data.compiled}
      <article>
        <DocsContent compiled={data.compiled} />
      </article>
    {:else}
      <ApiReferenceRenderer api={data.routeEntry.api} />
    {/if}
    <Pagination surface={data.surface} />
  </section>

  {#if (data.surface.headings ?? []).length > 0}
    <aside class="docs-toc">
      <DocsToc surface={data.surface} headings={data.surface.headings} />
    </aside>
  {/if}
</div>
```

Add responsive CSS as needed.

---

## Step 11 — Search endpoint

```ts
// src/routes/search.json/+server.ts
import { createSearchArtifactResponse } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const source = await loadDocsSiteSource();
  return createSearchArtifactResponse({ artifact: source.searchArtifact });
};
```

If `DocsSearch` is not passed `searchArtifact` from the server, set:

```ts
loadSearchArtifact={() => fetch("/search.json").then((r) => r.json())}
```

on a thin wrapper component used as `searchTrigger`.

---

## Step 12 — Blog routes

**`src/routes/blog/+page.ts`** (client load is fine for listing):

```ts
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ parent }) => {
  const { source } = await parent();
  const posts = Object.values(source.manifest.posts)
    .filter((p) => !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date));
  return { posts };
};
```

**`src/routes/blog/[...slug]/+page.server.ts`**:

```ts
import { error } from "@sveltejs/kit";
import { compileSvelteContent, resolveMarkdownRelativeLinks } from "@docsfn/core";
import { getPostData } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const post = getPostData(params.slug, source.manifest);
  if (!post || post.draft) throw error(404, "Not found");
  const compiled = resolveMarkdownRelativeLinks({
    compiled: compileSvelteContent({ source: post.body, compatPreset: source.compatPreset }),
    route: post.path, sourcePath: post.id.replace(/^[^:]+:/, ""),
  });
  return { post, compiled, siteTitle: source.siteTitle };
};
```

Render with **`DocsContent`** and link the list to `/blog/[...slug]`.

**RSS** — optional `src/routes/blog/rss.xml/+server.ts` using **`generateRSSFeed`** from `@docsfn/core` (see [RSS](../core-concepts/rss)).

---

## Step 13 — Prerendering / static generation

1. **`adapter-static`** — install `@sveltejs/adapter-static`, set `fallback` if needed, run `vite build`.
2. **Route entries** — for `[...slug]`, export **`entries`** from `+page.ts` / `+page.server.ts` using **`generateStaticParams`** from `@docsfn/sveltekit`:

```ts
import { generateStaticParams } from "@docsfn/sveltekit";
import { loadDocsSiteSource } from "$lib/server/docs-site-source";

export const entries = async () => {
  const source = await loadDocsSiteSource();
  return generateStaticParams(source.manifest, {
    basePath: source.config.site.basePath ?? "/docs",
    includeApiRoutes: true,
  });
};

export const prerender = true;
```

Versioned docs use **`generateVersionedStaticParams`** when `versions.mode` is not `none`.

---

## Embedded routes (optional)

`DocsManifest.embedded` lists **iframe-friendly** page and surface URLs for each docs page. Use **`EmbeddedPage`** from `@docsfn/svelte` when you host those routes and want a minimal article chrome without the full site layout. Typical pattern: dedicated routes under `embedded/page/...` that load the same manifest and render `EmbeddedPage` with `compiled` + headings.

---

## `@docsfn/svelte` component checklist

| Component | Role |
| --- | --- |
| **TopBar** | Header nav; props: `items`, `logo`, `searchTrigger`, `versionSelector`, `surface`. |
| **DocsSidebar** | Tree nav; `surface`, `sidebar`, `activePath`. Groups expand when `item.expanded === true` or a descendant matches active route. |
| **SidebarGroup** | Recursive group renderer (use when building a custom sidebar). |
| **Breadcrumbs** | `surface` or `items`; `separator` slot component. |
| **Pagination** | `surface` or explicit `prevPage` / `nextPage`. |
| **DocsToc** | Heading list for current page. |
| **DocsContent** | Renders compiled Markdown blocks; `components` map for custom MDX-style tags. |
| **DocsSearch** | Modal search + Cmd/Ctrl+K. |
| **ApiReferenceRenderer** | OpenAPI reference UI. |
| **VersionSwitcher** | Version dropdown from `surface.versions`. |
| **DocsLayout** | Lower-level layout shell if you assemble your own page frame. |
| **EmbeddedPage** | Compact article + optional TOC for embeds. |

---

## CLI workflow

```bash
npx docsfn validate --root .
npx docsfn build --root .
npx docsfn dev --root .
```

Use **`dev`** while authoring so `.docsfn/search.json` stays warm if you load the artifact from disk instead of the Kit route.
