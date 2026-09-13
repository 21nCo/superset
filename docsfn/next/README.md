# @docsfn/next

Next.js App Router site-kit helpers for `docsfn`.
Supports Next `15` with React `18` and `19`.

## Install

```bash
npm install @docsfn/next @docsfn/core @docsfn/provider-fs @docsfn/react
```

## Migration Contract

When migrating existing Fumadocs content, use a `docsfn.config.ts|mjs|js` file with:

- `schemaVersion: 1`
- `compat.preset: "fumadocs-v15"`
- `content.docsDir: "content/docs"`

This preserves canonical fixture syntax (`meta.json`, Tabs/Tab imports, Mermaid fences) while failing unsupported constructs with `DOCS_COMPAT_UNSUPPORTED`.

## Minimal Integration

```tsx
// app/docs/[[...slug]]/page.tsx
import { notFound } from "next/navigation";
import {
  generateStaticParams as generateDocsStaticParams,
  resolveDocsRouteData,
  resolveDocsPageSurface,
  generatePageMetadata,
} from "@docsfn/next";
import { buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

const root = process.cwd();
const config = await loadDocsConfig({ cwd: root });
const provider = new FsContentProvider({ root });
const manifest = await buildManifest(provider, config);

export async function generateStaticParams() {
  return generateDocsStaticParams(manifest, {
    basePath: config.site.basePath,
    includeApiRoutes: true,
  });
}

export async function generateMetadata({ params }: { params: { slug?: string[] } }) {
  const routeEntry = resolveDocsRouteData(params.slug, manifest, {
    basePath: config.site.basePath,
  });

  if (!routeEntry || routeEntry.kind !== "page") {
    return {};
  }

  const metadata = generatePageMetadata(routeEntry.page, {
    siteTitle: manifest.site.title,
    canonicalUrl: config.site.canonicalUrl,
  });

  return {
    title: metadata.title,
    description: metadata.description,
    alternates: metadata.alternates,
    openGraph: metadata.openGraph,
  };
}

export default function Page({ params }: { params: { slug?: string[] } }) {
  const routeEntry = resolveDocsRouteData(params.slug, manifest, {
    basePath: config.site.basePath,
  });

  if (!routeEntry || routeEntry.kind !== "page") {
    notFound();
  }

  const surface = resolveDocsPageSurface({
    manifest,
    route: routeEntry.route,
    page: routeEntry.page,
    options: {
      basePath: config.site.basePath,
      canonicalUrl: config.site.canonicalUrl,
    },
  });

  return (
    <main>
      <h1>{routeEntry.page.title}</h1>
      <p>{surface.canonicalPath}</p>
    </main>
  );
}
```

## Root and Nested Route Behavior

- Root docs route resolves when `params.slug` is absent.
- Nested routes resolve with canonical path semantics.
- Route misses throw `DOCS_ROUTE_NOT_FOUND` via helper `...OrThrow` variants.

## Search Artifact Route

```ts
// app/api/search/route.ts
import { createSearchArtifactResponse } from "@docsfn/next";

export async function GET() {
  return createSearchArtifactResponse({
    loadArtifact: async () => {
      // load .docsfn/search.json here
      return JSON.parse("{}");
    },
  });
}
```

Reserve the API collection for OpenAPI specs such as `content/api`. If you also keep markdown package docs under `content/docs/api`, route them through your normal docs catch-all and classify them into the `api` sidebar/search scope with `navigation.sidebars.api.include` plus `search.routeScopeOverrides`.

## Optional Security/Analytics Hooks

`@docsfn/next` re-exports canonical security/analytics helpers from core:

- auth: `resolveDocsAuthMode`, `assertDocsRouteAccess`, `CANONICAL_DOCS_AUTH_MODES`
- analytics: `createDocsAnalyticsEmitter`, `maybeEmitAnalyticsEvent`, `CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`

Both remain opt-in; no auth/analytics behavior is forced by default.

## Fixture-Backed Example

Runnable reference app:

- `docsfn/examples/next-docs-site`

Build it against canonical fixtures:

```bash
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/next-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/next-docs-site run build
```
