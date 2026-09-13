---
title: Configuration
description: Exhaustive reference for docsfn.config.ts — every DocsConfig field, defaults, and examples.
---

# Configuration

docsfn loads **`docsfn.config.ts`**, **`docsfn.config.mjs`**, or **`docsfn.config.js`** from your project root (or `--config`). The loaded object must satisfy **`DocsConfig`** and is validated with **schema version `1`**.

## Config file names

| File | Notes |
| --- | --- |
| `docsfn.config.ts` | Recommended; TypeScript, `export default` object or factory. |
| `docsfn.config.mjs` | ESM JavaScript. |
| `docsfn.config.js` | CommonJS or ESM depending on your package `"type"`. |

If no file is found, docsfn uses **built-in defaults** (see [`createDefaultDocsConfig`](https://github.com/21nCo/super-functions/tree/dev/docsfn/core) behavior in `@docsfn/core`).

---

## `schemaVersion`

| | |
| --- | --- |
| **Type** | literal `1` |
| **Required** | yes |
| **Default** | none (must be set explicitly in real configs) |
| **Description** | Locks the config document to the v1 schema understood by the CLI and manifest. |

**Example**

```typescript
schemaVersion: 1,
```

---

## `site`

Top-level site metadata and presentation hints.

### `site.title`

| | |
| --- | --- |
| **Type** | `string` (non-empty) |
| **Required** | yes |
| **Default** (implicit default config) | `"Docs"` |
| **Description** | Short site name; used in manifests, sidebars, and chrome. |

**Example:** `title: "docsfn"`

### `site.description`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | One-line summary for SEO and search snippets. |

**Example:** `description: "The documentation toolchain for superfunctions"`

### `site.basePath`

| | |
| --- | --- |
| **Type** | `` `/${string}` `` (must start with `/`) |
| **Required** | no |
| **Default** | `"/docs"` |
| **Description** | URL prefix for the **docs** collection. |

**Example:** `basePath: "/docs"`

### `site.canonicalUrl`

| | |
| --- | --- |
| **Type** | absolute URL `string` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Origin used when resolving canonical URLs for pages. |

**Example:** `canonicalUrl: "https://docs.example.com"`

### `site.defaultLocale`

| | |
| --- | --- |
| **Type** | `string` (non-empty) |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Reserved for future i18n; pass-through in config today. |

### `site.theme`

| | |
| --- | --- |
| **Type** | `Record<string, unknown>` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Opaque theme tokens for UI adapters (structure is product-specific). |

**Example:** `theme: { primary: "#2563eb" }`

### `site.editLink`

| | |
| --- | --- |
| **Type** | `Record<string, unknown>` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Edit-on-GitHub style metadata; often includes a `pattern` with `{path}` placeholder. |

**Example:**

```typescript
editLink: {
  pattern: "https://github.com/org/repo/edit/main/docs/{path}",
},
```

### `site.pageActions`

| | |
| --- | --- |
| **Type** | `Array<Record<string, unknown>>` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Declarative actions surfaced by UI packages. Each entry is passed through to the page surface as-is. Adapters expose them via `surface.pageActions` and components like `DocsContent` render them in the `pageActionsSlot` region. Common use: edit links, “View source” buttons, or feedback widgets. |

---

## `compat`

Controls compatibility transforms for legacy content.

### `compat.preset`

| | |
| --- | --- |
| **Type** | `"none"` \| `"fumadocs-v15"` |
| **Required** | no (object optional) |
| **Default** | `"none"` when compat block present |
| **Description** | `"none"` = native Markdown pipeline; `"fumadocs-v15"` enables Fumadocs-oriented transforms where supported. |

### `compat.allowRawHtml`

| | |
| --- | --- |
| **Type** | only `false` allowed when set |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Explicit opt-out hook for raw HTML policies in stricter modes. |

**Example**

```typescript
compat: { preset: "none" },
```

---

## `versions`

Optional **versioned documentation**.

### `versions.mode`

| | |
| --- | --- |
| **Type** | `"none"` \| `"path-prefix"` \| `"path-segment"` |
| **Required** | yes (when `versions` is set) |
| **Default** | n/a |
| **Description** | How version slugs appear in URLs (prefix vs segment). |

### `versions.versions`

| | |
| --- | --- |
| **Type** | `Array<{ slug: string; label: string; default?: boolean }>` (min 1 entry) |
| **Required** | yes (when `versions` is set) |
| **Default** | n/a |
| **Description** | Catalog of versions; at most one entry may set `default: true`. |

**Example**

```typescript
versions: {
  mode: "path-prefix",
  versions: [
    { slug: "v1", label: "1.x", default: true },
    { slug: "v2", label: "2.x" },
  ],
},
```

---

## `content`

All paths are resolved relative to **`content.root`** unless already absolute.

### `content.root`

| | |
| --- | --- |
| **Type** | `string` (non-empty) |
| **Required** | yes |
| **Default** | process cwd when using implicit default config |
| **Description** | Workspace root for collections. Often `"."`. |

### `content.docsDir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"content/docs"` |
| **Description** | Directory for documentation Markdown. |

### `content.pagesDir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"pages"` |
| **Description** | Optional standalone **pages** collection. |

### `content.blogDir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"blog"` |
| **Description** | Legacy blog Markdown directory. For changelog or other first-class dated sections, prefer `collections.<id>.dir`. |

### `content.apiDir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"api"` |
| **Description** | OpenAPI spec files (`.json`, `.yaml`, `.yml`). Not for hand-written API Markdown. |

### `content.assetsDir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"public"` |
| **Description** | Static assets root for the FS provider. |

### `content.metaFileName`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | `"meta.json"` |
| **Description** | Control file name for sidebar ordering per folder. |

---

## `navigation`

### `navigation.topNav`

| | |
| --- | --- |
| **Type** | `DocsTopNavItem[]` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Top bar links. Each item: `label`, `href`, optional `external`, optional nested `children`. |

**Example**

```typescript
topNav: [
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: "https://github.com/org/repo", external: true },
],
```

### `navigation.sidebars`

| | |
| --- | --- |
| **Type** | `Record<string, { title?: string; root?: boolean; include?: string[] }>` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Named sidebars. **`include`** globs match internal paths like `docs/<sourcePath>` (not `content/docs/...`). A built-in **`default`** sidebar includes all docs pages. |

**Example**

```typescript
sidebars: {
  docs: { title: "Documentation", root: true, include: ["docs/**"] },
  api: { title: "API Reference", root: true, include: ["docs/api/**"] },
},
```

---

## `collections`

Named collections let docsfn reuse the dated Markdown engine for product sections that are not blogs, such as changelog.

Each key becomes a collection id. For example, `collections.changelog` creates `manifest.collections.changelog`, reads from its own folder, and can use the `changelog` search scope.

### `collections.<id>.dir`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | yes |
| **Description** | Folder containing one `.md` / `.mdx` file per dated update. |

### `collections.<id>.routeBase`

| | |
| --- | --- |
| **Type** | `string` starting with `/` |
| **Required** | yes |
| **Description** | Public list/post/tag route base for this collection. |

### `collections.<id>.feedPath`

| | |
| --- | --- |
| **Type** | `string` starting with `/` |
| **Required** | no |
| **Default** | `${routeBase}/rss.xml` |
| **Description** | Public RSS feed path for this collection. |

### `collections.<id>.label`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Description** | Display label such as `"Changelog"`. |

### `collections.<id>.scope`

| | |
| --- | --- |
| **Type** | `string` |
| **Required** | no |
| **Default** | collection id |
| **Description** | Search scope used by posts in this collection. |

**Changelog example**

```typescript
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

---

## `blog`

The blog section controls the legacy blog route surface for dated Markdown posts. It remains supported for existing docs sites. For changelog, use `collections.changelog`.

### `blog.routeBase`

| | |
| --- | --- |
| **Type** | `string` starting with `/` |
| **Required** | no |
| **Default** | `${site.basePath}/blog` |
| **Description** | Public list/post/tag route base for the dated post collection. |

### `blog.feedPath`

| | |
| --- | --- |
| **Type** | `string` starting with `/` |
| **Required** | no |
| **Default** | `${blog.routeBase}/rss.xml` |
| **Description** | Public RSS feed path. |

**Blog example**

```typescript
content: {
  root: ".",
  docsDir: "content/docs",
  blogDir: "content/blog",
},
blog: {
  routeBase: "/docs/blog",
},
```

---

## `search`

### `search.enabled`

| | |
| --- | --- |
| **Type** | `boolean` |
| **Required** | yes (when `search` is set) |
| **Default** | `true` (implicit default config) |
| **Description** | Master switch for search index generation. |

### `search.scopes`

| | |
| --- | --- |
| **Type** | `("docs" \| "api" \| "blog")[]` |
| **Required** | yes (when `search` is set) |
| **Default** | `["docs"]` |
| **Description** | Which collections appear in the search artifact. |

### `search.bodyIndexing`

| | |
| --- | --- |
| **Type** | `"full"` \| `"summary"` \| `"disabled"` |
| **Required** | no |
| **Default** | `"summary"` |
| **Description** | Trade-off between artifact size and body depth in the index. |

### `search.maxArtifactBytes`

| | |
| --- | --- |
| **Type** | positive integer |
| **Required** | no |
| **Default** | internal default in `@docsfn/core` |
| **Description** | Hard cap for serialized search JSON size. |

### `search.routeScopeOverrides`

| | |
| --- | --- |
| **Type** | `DocsSearchRouteScopeOverride[]` — each entry `{ pattern: string; scope: string }` |
| **Required** | no |
| **Default** | `undefined` |
| **Description** | Override the search scope for routes matching a glob pattern. Useful when some pages belong to a different logical scope than their collection. For example, an API reference page under the `docs` collection can be forced into the `api` scope. Resolved by **`resolveSearchScopeForRoute`** at index-build time. |

**Example**

```typescript
search: {
  enabled: true,
  scopes: ["docs", "api", "changelog"],
  routeScopeOverrides: [
    { pattern: "/docs/api/**", scope: "api" },
  ],
},
```

---

## `auth`

### `auth.enabled` / `auth.mode`

| | |
| --- | --- |
| **Type** | `enabled: boolean`, `mode: "public" \| "private" \| "mixed"` |
| **Required** | yes (when `auth` is set) |
| **Default** | `enabled: false`, `mode: "public"` |
| **Description** | Route/content access mode for private docs setups. |

---

## `analytics`

### `analytics.enabled` / `provider` / `respectDnt`

| | |
| --- | --- |
| **Type** | `enabled: boolean`, `provider: "watchfn"`, `respectDnt: boolean` |
| **Required** | yes (when `analytics` is set) |
| **Default** | `enabled: false`, `provider: "watchfn"`, `respectDnt: true` |
| **Description** | Pluggable analytics; `watchfn` is the supported provider id today. |

---

## Full example

```typescript
import type { DocsConfig } from "@docsfn/core";

const config: DocsConfig = {
  schemaVersion: 1,
  site: {
    title: "My product",
    description: "Docs",
    basePath: "/docs",
    canonicalUrl: "https://example.com",
    editLink: { pattern: "https://github.com/org/repo/edit/main/{path}" },
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
    topNav: [{ label: "Home", href: "/docs" }],
    sidebars: {
      docs: { title: "Docs", include: ["docs/**"] },
    },
  },
  blog: {
    routeBase: "/docs/blog",
  },
  collections: {
    changelog: {
      dir: "content/changelog",
      routeBase: "/changelog",
      label: "Changelog",
      scope: "changelog",
    },
  },
  search: {
    enabled: true,
    scopes: ["docs", "api", "blog", "changelog"],
    bodyIndexing: "summary",
  },
  auth: { enabled: false, mode: "public" },
  analytics: { enabled: false, provider: "watchfn", respectDnt: true },
};

export default config;
```

Run **`npx docsfn validate --root .`** after edits; fix **DOCS_CONFIG_INVALID** diagnostics before shipping.
