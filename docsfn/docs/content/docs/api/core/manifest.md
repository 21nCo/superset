---
title: core — Manifest
description: buildManifest and DocsManifest in @docsfn/core.
---

# Manifest (`@docsfn/core`)

## `buildManifest(provider, config, options?)`

- **`provider`:** `DocsContentProvider` — typically **`FsContentProvider`**.
- **`config`:** `ManifestConfig` — either a full **`DocsConfig`** (`schemaVersion: 1`) or a **legacy** object with `content` partial + top-level fields (see source `LegacyManifestConfig`).
- **`options`:** `BuildManifestOptions`
  - **`preview?: boolean`** — passed through blog canonicalization (include drafts when true).
  - **`blogPageSize?: number`** — archive page size (default **10**).

**Returns:** `Promise<DocsManifest>`.

**Pipeline (summary):** list entries → trust/sanitize source → normalize pages/posts/apis/meta → build routes (conflict-checked) → OpenAPI references → sidebars → blog surface → optional embedded route table.

## `DocsManifest` (fields)

| Field | Description |
| --- | --- |
| `site` | `title`, optional `description`. |
| `versions` | Optional version list for UI. |
| `topNav` | From `navigation.topNav`. |
| `pages` | Map id → **`DocPage`**. |
| `posts` | Map id → **`BlogPost`**. |
| `apis` | Map id → **`ApiReference`** (`spec` holds **`CanonicalOpenApiReference`**). |
| `sidebars` | Map sidebar id → **`Sidebar`**. |
| `routes` | Map **route path** → **source id**. |
| `blog` | Optional **`BlogManifestSurface`**. |
| `collections` | Map dated collection id → **`DatedCollectionManifestSurface`** for sections like changelog. |
| `embedded` | Optional embedded route catalog for iframe-style hosts. |

See **[Types](./types)** for nested interfaces.
