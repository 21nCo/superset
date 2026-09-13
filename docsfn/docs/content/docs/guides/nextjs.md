---
title: Next.js Integration
description: Build a docsfn documentation site on the Next.js App Router.
---

# Next.js Integration

Use **`@docsfn/next`** with **`@docsfn/core`**, **`@docsfn/react`**, and **`@docsfn/provider-fs`** to render docs from the same `docsfn.config.ts` as SvelteKit. The App Router loads the manifest at build time (or in a server module) and uses **`generateStaticParams`**, **`resolveDocsRouteData`**, **`resolveDocsPageSurface`**, and **`generatePageMetadata`**.

## Prerequisites

- **Next.js 15** (App Router)
- **React 19** (or 18; see package peer ranges)
- **Node.js 18+**

---

## Step 1 — Create a Next.js project

```bash
npx create-next-app@latest my-docs --typescript --eslint --app --src-dir
cd my-docs
```

---

## Step 2 — Install packages

```bash
npm install @docsfn/core @docsfn/next @docsfn/react @docsfn/provider-fs
npm install -D @docsfn/cli
```

---

## Step 3 — `docsfn.config.ts`

Reuse the same config shape as the SvelteKit guide (`schemaVersion`, `site`, `content`, `navigation`, `search`, `auth`, `analytics`). Place at the repo root and load with **`loadDocsConfig({ cwd: process.cwd() })`**.

---

## Step 4 — Shared server module for manifest + search

Create **`src/server/docs-source.ts`** (name arbitrary) that builds once per process:

```ts
// src/server/docs-source.ts
import path from "node:path";
import { buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

const root = process.cwd();

export async function getDocsConfig() {
  return loadDocsConfig({ cwd: root });
}

export async function getManifest() {
  const config = await getDocsConfig();
  const provider = new FsContentProvider({
    root,
    docsDir: config.content.docsDir,
    pagesDir: config.content.pagesDir,
    blogDir: config.content.blogDir,
    apiDir: config.content.apiDir,
    assetsDir: config.content.assetsDir,
  });
  return buildManifest(provider, config);
}
```

Call **`buildSearchIndex`** the same way as SvelteKit if you need search JSON on disk for **`createSearchArtifactResponse`**.

---

## Step 5 — Root layout

```tsx
// src/app/layout.tsx
import type { ReactNode } from "react";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

---

## Step 6 — Docs page `app/docs/[[...slug]]/page.tsx`

```tsx
// src/app/docs/[[...slug]]/page.tsx
import { notFound } from "next/navigation";
import {
  generateStaticParams as generateDocsStaticParams,
  generatePageMetadata,
  resolveDocsPageSurface,
  resolveDocsRouteData,
} from "@docsfn/next";
import { getDocsConfig, getManifest } from "@/server/docs-source";
import {
  ApiReferenceRenderer,
  Breadcrumbs,
  DocsContent,
  DocsSidebar,
  Pagination,
} from "@docsfn/react";
import { compileReactContent, resolveMarkdownRelativeLinks } from "@docsfn/core";

const manifestPromise = getManifest();
const configPromise = getDocsConfig();

export async function generateStaticParams() {
  const [manifest, config] = await Promise.all([manifestPromise, configPromise]);
  return generateDocsStaticParams(manifest, {
    basePath: config.site.basePath ?? "/docs",
    includeApiRoutes: true,
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const [manifest, config] = await Promise.all([manifestPromise, configPromise]);
  const routeEntry = resolveDocsRouteData(slug, manifest, {
    basePath: config.site.basePath ?? "/docs",
  });
  if (!routeEntry || routeEntry.kind !== "page") {
    return {};
  }
  const meta = generatePageMetadata(routeEntry.page, {
    siteTitle: manifest.site.title,
    canonicalUrl: config.site.canonicalUrl,
  });
  return {
    title: meta.title,
    description: meta.description,
    alternates: meta.alternates,
    openGraph: meta.openGraph,
  };
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const [manifest, config] = await Promise.all([manifestPromise, configPromise]);
  const basePath = config.site.basePath ?? "/docs";

  const routeEntry = resolveDocsRouteData(slug, manifest, { basePath });
  if (!routeEntry) {
    notFound();
  }

  const surface = resolveDocsPageSurface({
    manifest,
    route: routeEntry.route,
    page: routeEntry.kind === "page" ? routeEntry.page : undefined,
    options: {
      basePath,
      homeHref: basePath,
      canonicalUrl: config.site.canonicalUrl,
    },
  });

  const sidebarId = surface.sidebarId ?? "default";
  const sidebar = manifest.sidebars[sidebarId];

  if (routeEntry.kind === "page") {
    const compiled = resolveMarkdownRelativeLinks({
      compiled: compileReactContent({ source: routeEntry.page.body, sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""), compatPreset: config.compat?.preset ?? "none" }),
      route: routeEntry.route,
      sourcePath: routeEntry.page.id.replace(/^[^:]+:/, ""),
    });
    return (
      <div className="docs-layout">
        {sidebar ? (
          <DocsSidebar sidebar={sidebar} activePath={surface.route} />
        ) : null}
        <main>
          <Breadcrumbs surface={surface} />
          <DocsContent compiled={compiled} />
          <Pagination surface={surface} />
        </main>
      </div>
    );
  }

  return (
    <div className="docs-layout">
      {sidebar ? <DocsSidebar sidebar={sidebar} activePath={surface.route} /> : null}
      <main>
        <Breadcrumbs surface={surface} />
        <ApiReferenceRenderer api={routeEntry.api} />
      </main>
    </div>
  );
}
```

Use **`resolveDocsRouteDataOrThrow`** if you prefer exceptions over `notFound()` for missing slugs.

---

## Step 7 — Search route

```ts
// src/app/api/search/route.ts
import { createSearchArtifactResponse } from "@docsfn/next";
import { buildSearchIndex } from "@docsfn/core";
import { getDocsConfig, getManifest } from "@/server/docs-source";

export async function GET() {
  const [manifest, config] = await Promise.all([getManifest(), getDocsConfig()]);
  const artifact = await buildSearchIndex(manifest, {
    search: config.search,
    auth: config.auth,
  });
  return createSearchArtifactResponse({ artifact });
}
```

Alternatively read **`search.json`** produced by **`docsfn build`** from **`.docsfn/`** with `loadArtifact` (see `@docsfn/next` README).

Wire **`DocsSearch`** from **`@docsfn/react`** with **`loadSearchArtifact={() => fetch("/api/search").then((r) => r.json())}`** (adjust path to match your route).

---

## Step 8 — Blog routes

Use **`generateBlogParams`**, **`getPostData`** / **`getPostDataOrThrow`** from **`@docsfn/next`**, and **`BlogList`** from **`@docsfn/react`**:

- **`app/blog/page.tsx`** — list posts from `manifest.posts` (filter drafts).
- **`app/blog/[slug]/page.tsx`** — resolve post by slug, **`compileReactContent`** on `post.body`, render **`DocsContent`**.

Re-use the same **`getManifest()`** helper so content stays consistent.

---

## `@docsfn/next` helpers (quick reference)

| Export | Role |
| --- | --- |
| **`generateStaticParams`** | Static paths for `[[...slug]]` (and versioned variants). |
| **`resolveDocsRouteData`** / **`resolveDocsRouteDataOrThrow`** | Map param segments → page or API entry. |
| **`resolveDocsPageSurface`** | Breadcrumbs, pagination, sidebar id, canonical URL, etc. |
| **`generatePageMetadata`** | Title, description, Open Graph, canonical alternates. |
| **`createSearchArtifactResponse`** | JSON **`Response`** for search artifact. |
| **`generateBlogParams`** | Blog static params. |

---

## `@docsfn/react` components

| Export | Role |
| --- | --- |
| **DocsContent** | Compiled Markdown blocks; `components` prop for custom tags. |
| **DocsSidebar** | Navigation tree. |
| **Breadcrumbs** | Trail + optional custom **separator** component. |
| **Pagination** | Prev/next; override via props. |
| **DocsToc** | On-page headings. |
| **DocsSearch** | Search modal + keyboard shortcut. |
| **TopBar** | Header; `items`, `logo`, `searchTrigger`. |
| **ApiReferenceRenderer** | OpenAPI UI. |
| **VersionSwitcher** | Version dropdown. |
| **BlogList** | Opinionated list layout for posts. |
| **EmbeddedPage** | Compact article for embeds. |
| **ThemeProvider** | Optional theme context wiring. |
| **DocsLayout** | Lower-level shell when you assemble your own frame. |

---

## Production build

```bash
npx docsfn validate --root .
npm run build
```

Run **`docsfn build`** in CI if you commit `.docsfn` artifacts for faster search loading.
