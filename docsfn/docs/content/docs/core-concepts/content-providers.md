---
title: Content Providers
description: The DocsContentProvider interface, FsContentProvider, and how to implement custom sources.
---

# Content providers

All docsfn pipelines read content through a **`DocsContentProvider`**. The reference implementation is **`FsContentProvider`** in **`@docsfn/provider-fs`**.

See also: [Content format](./content-format), [CLI](./cli).

## `DocsContentProvider` interface

```ts
interface DocsContentProvider {
  readonly providerId: string;
  listEntries(input: DocsProviderListEntriesInput): Promise<DocsSourceEntry[]>;
  loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry>;
  loadAsset?(input: {
    config: DocsConfig;
    relativePath: string;
  }): Promise<DocsProviderLoadAssetResult>;
  watch?(input: DocsProviderWatchInput): Promise<DocsProviderWatchSubscription>;
  list(): Promise<RawContentEntry[]>;
}
```

- **`listEntries`** — Primary API: returns normalized **`DocsSourceEntry`** rows for requested collections under the configured content root.
- **`loadEntry`** — For filesystem provider, returns the same entry (CMS providers may fetch lazily here).
- **`loadAsset`** — Optional binary/static asset loader (used for `assets` collection paths).
- **`watch`** — Optional; FS provider returns metadata describing watched directories (CLI dev mode uses this when available).
- **`list`** — Legacy compatibility helper that bulk-loads via `listEntries` and maps to **`RawContentEntry[]`**.

Implementations must emit **stable, unique** `id` values per entry; core validates this in **`assertUniqueSourceEntryIds`**.

## `FsContentProvider`

### Constructor options

```ts
new FsContentProvider({
  root: "/absolute/or/cwd/relative/site",
  docsDir: "content/docs",      // optional overrides; else config + defaults
  pagesDir: "content/pages",
  blogDir: "content/blog",
  apiDir: "content/api",
  assetsDir: "static",
});
```

CLI wiring passes explicit dirs from **`DocsConfig.content`** so the provider stays aligned with config.

### Collection directory mapping

Directories resolve relative to **`config.content.root`** (or `options.root`):

| Collection | Config key | Default candidates (when unset) |
| --- | --- | --- |
| `docs` | `content.docsDir` | `content/docs`, then `docs` |
| `pages` | `content.pagesDir` | `pages` |
| `blog` | `content.blogDir` | `blog` |
| `api` | `content.apiDir` | `api` |
| `assets` | `content.assetsDir` | `public`, then `assets` |

The first **existing** candidate wins for defaults. **`docs`** is **required** to exist when strict validation applies.

### Supported file types

- **Markdown:** `.md`, `.mdx` for `docs`, `pages`, and `blog`.
- **API:** `.json`, `.yaml`, `.yml` under the `api` collection (OpenAPI, etc.).
- **Control files:** `meta.json` (or `content.metaFileName`) parsed as navigation metadata.
- **Assets:** opaque files under the assets directory with hashed metadata.

### Discovery

`fast-glob` walks **`**/*`** under each collection root (files only, sorted). Paths are normalized to stable POSIX-style strings for IDs and diagnostics.

### Watch mode

`watch()` builds metadata via **`buildFsWatchMetadata`** listing watched directories; the current FS subscription is a **noop** close, but CLI **`dev`** still uses metadata to choose chokidar roots.

## Custom provider skeleton

```ts
import type {
  DocsContentProvider,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsSourceEntry,
  RawContentEntry,
} from "@docsfn/core";
// import { loadDocsConfig, toLegacyRawEntries } from "@docsfn/core";

export class CmsContentProvider implements DocsContentProvider {
  readonly providerId = "cms";

  async listEntries(input: DocsProviderListEntriesInput): Promise<DocsSourceEntry[]> {
    // Fetch remote / DB records, map to DocsSourceEntry (id, collection, relativePath, body, frontmatter, …)
    return [];
  }

  async loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry> {
    return input.entry;
  }

  async list(): Promise<RawContentEntry[]> {
    // const config = await loadDocsConfig({ cwd: process.cwd() });
    // const entries = await this.listEntries({
    //   config,
    //   collections: ["docs", "pages", "blog", "api", "assets"],
    // });
    // return toLegacyRawEntries(entries);
    return [];
  }
}
```

Use **`normalizeProviderPath`** when building `relativePath` values, and throw **`createDocsError`** with **`DOCS_PROVIDER_ERROR`** diagnostics on contract violations.

## When to use FS vs custom

- **FsContentProvider** — Local git repos, static site generators, CI checkout paths.
- **Custom** — Headless CMS, database-backed docs, generated content from another service, or multi-tenant sources.

Pass your provider to **`buildManifest`** the same way the CLI does.
