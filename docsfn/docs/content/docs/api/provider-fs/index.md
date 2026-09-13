---
title: "@docsfn/provider-fs"
description: Filesystem DocsContentProvider for docsfn.
---

# @docsfn/provider-fs

## `FsContentProvider`

### Constructor

```ts
new FsContentProvider({
  root: string;
  docsDir?: string;
  pagesDir?: string;
  blogDir?: string;
  apiDir?: string;
  assetsDir?: string;
})
```

Paths in **`FsProviderOptions`** override config defaults when passed from your bootstrap (CLI mirrors **`DocsConfig.content`** into these fields).

### `DocsContentProvider` methods

| Method | Description |
| --- | --- |
| **`listEntries({ config, collections })`** | Walks configured directories with **fast-glob** `**/*`, returns **`DocsSourceEntry[]`**. |
| **`loadEntry({ config, entry })`** | Identity pass-through for FS (entry already hydrated). |
| **`loadAsset({ config, relativePath })`** | Reads bytes from assets root, returns length + sha256. |
| **`watch({ config, onChange, collections? })`** | Returns subscription metadata for watched dirs (CLI dev uses metadata paths). Optional `collections` (`DocsCollection[]`) limits which collection directories are watched. |
| **`list()`** | Legacy: loads default collections and maps to **`RawContentEntry[]`**. |

### Collection directory resolution

Relative to **`config.content.root`** (or `options.root`):

| Collection | Config key | Default candidates |
| --- | --- | --- |
| docs | `content.docsDir` | `content/docs`, `docs` |
| pages | `content.pagesDir` | `pages` |
| blog | `content.blogDir` | `blog` |
| api | `content.apiDir` | `api` |
| assets | `content.assetsDir` | `public`, `assets` |

### File types

- Markdown **`.md` / `.mdx`** — docs, pages, blog.
- **`.json` / `.yaml` / `.yml`** — api collection (OpenAPI).
- **`meta.json`** (or `metaFileName`) — control files.
- **Assets** — opaque binary/text files.

## `DocsContentProvider` interface (core)

Defined in **`@docsfn/core`**: `providerId`, `listEntries`, `loadEntry`, optional `loadAsset` / `watch`, and legacy **`list()`**.

## Provider utility functions (`@docsfn/core`)

These helpers are useful when implementing custom content providers:

| Function | Description |
| --- | --- |
| **`normalizeProviderPath(inputPath)`** | Normalizes a file path to POSIX forward-slash format. |
| **`createSourceEntryId(collection, relativePath)`** | Generates a stable, unique id for a source entry. |
| **`stableSortSourceEntries(entries)`** | Deterministic sort by collection then relativePath. |
| **`assertUniqueSourceEntryIds(entries)`** | Throws `DOCS_PROVIDER_ERROR` on duplicate ids. |
| **`validateSourceEntries(entries)`** | Returns `DocsDiagnostic[]` for invalid entries (non-throwing). |
| **`assertValidSourceEntries(entries)`** | Validates and returns entries; throws on errors. |
| **`createProviderError(input)`** | Factory for `DOCS_PROVIDER_ERROR` `DocsError`. |
| **`createProviderRemoteFetchError(input)`** | Factory for `DOCS_REMOTE_FETCH_FAILED` `DocsError`. |
| **`sha256FromBuffer(buffer)`** | Computes SHA-256 hex digest from a `Buffer`. |
| **`normalizeToPosixPath(value)`** | Converts backslashes to forward slashes. |
| **`toLegacyRawEntries(entries)`** | Maps `DocsSourceEntry[]` to `RawContentEntry[]` for legacy consumers. |
