---
title: Installation
description: Add docsfn packages with npm, pnpm, or yarn; peer dependencies for SvelteKit and Next.js.
---

# Installation

docsfn is published as scoped packages under `@docsfn/*`. Install only what your app needs.

## Package overview

| Package | Role |
| --- | --- |
| `@docsfn/core` | Config loading, manifest, search index, markdown compile, navigation helpers |
| `@docsfn/provider-fs` | Filesystem content provider (Markdown, `meta.json`, assets) |
| `@docsfn/cli` | `docsfn validate`, `build`, `dev` |
| `@docsfn/svelte` | Svelte UI: layout, sidebar, TOC, breadcrumbs, search shell |
| `@docsfn/sveltekit` | SvelteKit loaders, static params, search response helpers |
| `@docsfn/next` | Next.js App Router helpers (static params, metadata, search) |
| `@docsfn/react` | React UI counterparts to `@docsfn/svelte` |

## npm / pnpm / yarn

**SvelteKit site** (typical):

```bash
npm install @docsfn/core @docsfn/provider-fs @docsfn/svelte @docsfn/sveltekit
npm install -D @docsfn/cli
```

**Next.js site**:

```bash
npm install @docsfn/core @docsfn/provider-fs @docsfn/react @docsfn/next
npm install -D @docsfn/cli
```

Use the same dependency lines with `pnpm add` or `yarn add` as you prefer.

## Peer dependencies

- **SvelteKit**: `@sveltejs/kit` ^2, `svelte` ^4 or ^5 (match versions required by your Kit release).
- **Next.js**: `next`, `react`, and `react-dom` versions supported by your `@docsfn/next` release.

The CLI is usually a **devDependency**; runtime packages belong in `dependencies`.

## Monorepo (npm workspaces / Turborepo)

In a monorepo, point `package.json` workspace dependencies at local packages, for example:

```json
{
  "dependencies": {
    "@docsfn/core": "*",
    "@docsfn/provider-fs": "*",
    "@docsfn/svelte": "*",
    "@docsfn/sveltekit": "*"
  },
  "devDependencies": {
    "@docsfn/cli": "*"
  }
}
```

Use `*` or `workspace:*` per your package manager. The official docs site aliases `@docsfn/*` to source for fast local development; published consumers use registry versions instead.

After installation, continue with [Quick Start](./quick-start).
