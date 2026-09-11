# @docsfn/sveltekit

SvelteKit site-kit helpers for `docsfn`.
Supports SvelteKit `2` with Svelte `5` (>=5.20.0).

## Install

```bash
npm install @docsfn/sveltekit @docsfn/core @docsfn/provider-fs @docsfn/svelte
```

## Migration Contract

When migrating existing Fumadocs content, use a `docsfn.config.ts|mjs|js` file with:

- `schemaVersion: 1`
- `compat.preset: "fumadocs-v15"`
- `content.docsDir: "content/docs"`

This keeps canonical compatibility behavior (`meta.json`, Tabs/Tab imports, Mermaid fences) and fails unsupported syntax with `DOCS_COMPAT_UNSUPPORTED`.

## Minimal Integration

```ts
// src/routes/docs/[...slug]/+page.ts
import {
  createPageLoad,
  resolveDocsPageSurface,
  resolveDocsRouteDataOrThrow,
} from "@docsfn/sveltekit";
import { buildManifest, loadDocsConfig } from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

const root = process.cwd();
const config = await loadDocsConfig({ cwd: root });
const provider = new FsContentProvider({ root });
const manifest = await buildManifest(provider, config);

export const load = createPageLoad(manifest, {
  basePath: config.site.basePath,
  canonicalUrl: config.site.canonicalUrl,
});
```

```svelte
<!-- src/routes/docs/[...slug]/+page.svelte -->
<script lang="ts">
  export let data;
</script>

<article>
  <h1>{data.page.title}</h1>
  <p>{data.surface.canonicalPath}</p>
</article>
```

## Static Path + Route Behavior

- Root docs path resolves when `params.slug` is absent.
- Nested routes resolve with canonical route semantics.
- Helper `resolveDocsRouteDataOrThrow` throws `DOCS_ROUTE_NOT_FOUND` for misses.

## Search Artifact Endpoint

```ts
// src/routes/api/search/+server.ts
import { createSearchArtifactResponse } from "@docsfn/sveltekit";

export async function GET() {
  return createSearchArtifactResponse({
    loadArtifact: async () => {
      // load .docsfn/search.json here
      return JSON.parse("{}");
    },
  });
}
```

Reserve the API collection for OpenAPI specs such as `content/api`. If you also want markdown package docs at `/docs/api/...`, place those files under `content/docs/api`, render them through the normal docs catch-all, and use `navigation.sidebars.api.include` plus `search.routeScopeOverrides` to classify them as API content.

## Optional Security/Analytics Hooks

`@docsfn/sveltekit` re-exports canonical security/analytics helpers from core:

- auth: `resolveDocsAuthMode`, `assertDocsRouteAccess`, `CANONICAL_DOCS_AUTH_MODES`
- analytics: `createDocsAnalyticsEmitter`, `maybeEmitAnalyticsEvent`, `CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`

Both remain opt-in.

## Fixture-Backed Example

Runnable reference app:

- `docsfn/examples/sveltekit-docs-site`

Build it against canonical fixtures:

```bash
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
```
