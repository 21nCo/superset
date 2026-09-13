---
title: core — Types
description: Primary TypeScript types exported from @docsfn/core.
---

# Types (`@docsfn/core`)

## Content models

| Type | Purpose |
| --- | --- |
| **`DocPage`** | Docs collection page: `kind: "page"`, `id`, `slug`, `path`, `title`, `body`, `headings`, `frontmatter`, optional `version`, `lastUpdated`, `description`. |
| **`BlogPost`** | Blog entry: `kind: "post"`, `id`, `slug`, `path`, `title`, `date`, `tags`, `draft`, `excerpt`/`summary`, `body`, `frontmatter`, optional `version`, `publishedAt`, `author`. |
| **`ApiReference`** | API entry: `kind: "api"`, `id`, `slug`, `path`, `title`, `spec` (canonical OpenAPI object), `frontmatter`, optional `version`. |
| **`DocHeading`** | TOC node: level, text, slug. |

## Provider / source

| Type | Purpose |
| --- | --- |
| **`DocsSourceEntry`** | Normalized file row from a provider: `id`, `collection`, `relativePath`, `absolutePath?`, `entryType` (`"content"` \| `"control"` \| `"asset"`), `frontmatter`, `body?`, `bytes?`, `sha256?`, `etag?`, `updatedAt?`, `meta?`. |
| **`DocsContentProvider`** | Interface: `listEntries`, `loadEntry`, optional `loadAsset` / `watch`, legacy **`list()`**. |

## Navigation

| Type | Purpose |
| --- | --- |
| **`SidebarItem`** | `type`: `link` \| `group` \| `separator`; text; optional `link`, `items`, `expanded`. |
| **`Sidebar`** | `id` + `items[]`. |
| **`DocsTopNavItem`** | Top nav node with optional nested **`children`**. |

## Config

| Type | Purpose |
| --- | --- |
| **`DocsConfig`** | Root config (`schemaVersion: 1`, `site`, `content`, `navigation`, `search`, `auth`, `analytics`, …). Full field list: **[Config](./config)** + **[Configuration](../../core-concepts/configuration)**. |
| **`DocsCompatPreset`** | `"none"` \| `"fumadocs-v15"`. |

## Embedded

| Type | Purpose |
| --- | --- |
| **`EmbeddedPageRoute`** | `pageId`, `sourcePath`, `pageRoute`, `surfaceRoute`, `title`, `tocCount`. |
| **`EmbeddedManifestSurface`** | `pageRoutePrefix`, `surfaceRoutePrefix`, `hasSidebar`, `hasSearchTrigger`, `hasTopNavSlot`, `pages` (map id → `EmbeddedPageRoute`). |

## Errors

**`DocsErrorCode`** — string union of all 17 **`DOCS_*`** codes (see **[Diagnostics](./diagnostics)**).

**`DocsDiagnostic`** — `code`, `severity`, `message`, optional `location`, `details`, `suggestion`.

**`LegacyDocsErrorCode`** — `"DOCS_PROVIDER_INVALID"` | `"DOCS_ROUTE_INVALID"` | `"DOCS_COMPILE_FAILED"` | `"DOCS_SEARCH_FAILED"`. Mapped to current codes via **`normalizeDocsErrorCode`**.

**`AnyDocsErrorCode`** — `DocsErrorCode | LegacyDocsErrorCode`.
