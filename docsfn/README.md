# docsfn

`docsfn` is the production docs toolchain for the Superfunctions monorepo.
It provides a canonical core engine, filesystem provider, framework site kits, and CLI workflows to migrate and run repo docs previously authored for Fumadocs.

## Packages

- `@docsfn/core` — canonical config/schema contracts, manifest/search/openapi pipelines
- `@docsfn/provider-fs` — filesystem provider for docs/pages/blog/api/assets
- `@docsfn/react` — React docs UI components
- `@docsfn/svelte` — Svelte docs UI components
- `@docsfn/next` — Next.js App Router site-kit helpers
- `@docsfn/sveltekit` — SvelteKit site-kit helpers
- `@docsfn/cli` — `docsfn validate|build|dev`

## Compatibility Preset

Use `compat.preset: "fumadocs-v15"` when migrating existing repo docs fixtures.
The preset supports canonical fixture constructs including:

- `meta.json` navigation control files
- `Tabs` / `Tab` from `fumadocs-ui/components/tabs`
- Mermaid code fences
- current fixture frontmatter surface from the spec

Unsupported compatibility syntax fails closed with `DOCS_COMPAT_UNSUPPORTED`.

## Canonical Config (Example)

```ts
// docsfn.config.ts
import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "My Docs",
    basePath: "/docs",
    canonicalUrl: "https://example.com",
  },
  compat: {
    preset: "fumadocs-v15",
  },
  content: {
    root: ".",
    docsDir: "content/docs",
    pagesDir: "content/pages",
    blogDir: "content/blog",
    apiDir: "content/api",
    assetsDir: "static",
    metaFileName: "meta.json",
  },
  // Optional: configure the legacy blog surface.
  blog: {
    routeBase: "/docs/blog",
    feedPath: "/docs/blog/rss.xml",
  },
  // Optional: add first-class dated collections such as changelog.
  collections: {
    changelog: {
      dir: "content/changelog",
      routeBase: "/changelog",
      feedPath: "/changelog/rss.xml",
      label: "Changelog",
      scope: "changelog",
    },
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog"],
    bodyIndexing: "summary",
    routeScopeOverrides: [
      { pattern: "/docs/api", scope: "api" },
      { pattern: "/docs/api/**", scope: "api" },
    ],
  },
  auth: {
    enabled: false,
    mode: "public",
  },
  analytics: {
    enabled: false,
    provider: "watchfn",
    respectDnt: true,
  },
};

export default config;
```

For a product changelog, keep one Markdown/MDX file per update and configure it as a first-class dated collection:

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

## CLI Commands

```bash
# Validate config/content and fail non-zero on error diagnostics
npx docsfn validate --root .

# Build canonical artifacts
npx docsfn build --root . --out-dir .docsfn

# Dev watcher with structured invalidation diagnostics
npx docsfn dev --root . --out-dir .docsfn
```

Build outputs:

- `manifest.json`
- `search.json` (when search is enabled)
- `diagnostics.json`
- `compat-report.json`

## Migration Guidance (Fumadocs -> docsfn)

1. Copy canonical fixture (or your docs site) into a docsfn root with `content/docs`.
2. Add `docsfn.config.ts` with `schemaVersion: 1` and `compat.preset: "fumadocs-v15"`.
3. Reserve the API collection for OpenAPI specs such as `content/api`; if you want markdown package docs under `/docs/api`, keep them in the docs collection at `content/docs/api` and classify them with sidebar globs plus `search.routeScopeOverrides`.
4. Run `docsfn validate` and fix blocking diagnostics.
5. Run `docsfn build` and inspect `manifest.json`, `search.json`, `compat-report.json`.
6. Wire your host app through `@docsfn/next` or `@docsfn/sveltekit` helpers.
7. Run the release matrix before cutting versions:

```bash
npm ci
node docsfn/scripts/release-preflight.mjs
node docsfn/scripts/docs-contract-check.mjs
node docsfn/scripts/release-gate.mjs
node docsfn/scripts/migration-check.mjs
```

## Reference Examples

- Next.js reference site: `docsfn/examples/next-docs-site`
- SvelteKit reference site: `docsfn/examples/sveltekit-docs-site`
- Example runbook: `docsfn/examples/README.md`

## Release Checklist

Before release, complete `docsfn/.conduct/release-checklist.md`.

## Operator administration

`@docsfn/admin` is the optional Super Console capability for DocsFn. It requires
an injected durable `DocsFnOperatorStore` and a real `DocsContentProvider`
resolver. Builds run through `@docsfn/core`'s `buildManifest`; the admin package
does not synthesize content or compiler results.

Sites and build records are isolated by the complete installation, workspace,
project, and optional environment scope. Compiler error details remain in the
owning store and are represented to operators only by `hasError`.
