---
title: CLI
description: docsfn validate, build, and dev commands, options, artifacts, and pipeline overview.
---

# CLI

The **`docsfn`** CLI (`@docsfn/cli`) loads your config, runs the **manifest + search** pipeline, prints **diagnostics**, and writes **artifacts** to disk.

## Installation

- **One-off:** `npx docsfn <command>` from your docs site root.
- **Project dependency:** add `@docsfn/cli` to `devDependencies` and run `npx docsfn` or a package script.

## `docsfn validate [root]`

Validates configuration and content **without** writing artifacts (beyond what the pipeline needs in memory).

**Options:**

| Flag | Description |
| --- | --- |
| `--root <dir>` | Working directory containing `docsfn.config.*` (defaults to positional `[root]` or `.`). |
| `--config <path>` | Explicit config file path. |

**Output:** Human-readable diagnostics (errors, warnings, info) via `formatDiagnosticsForCli`, plus a summary line with counts.

**Exit code:** **`0`** when there are no error-severity diagnostics; **`1`** when any **error** exists (`hasErrorDiagnostics`).

## `docsfn build [root]`

Runs the full pipeline and writes output under **`--out-dir`** (default **`.docsfn`**). Legacy **`--out`** is accepted as an alias for the output directory.

**Artifacts** (`writeArtifacts`):

| File | Contents |
| --- | --- |
| `manifest.json` | Resolved `DocsManifest` (pages, routes, sidebars, blog, apis, …). |
| `search.json` | `DocsSearchArtifact` when `search.enabled` is true and the index builds successfully. |
| `diagnostics.json` | Array of `DocsDiagnostic` objects from the run. |
| `compat-report.json` | Compatibility preset report (e.g. fumadocs parity hints). |

**Console:** On success with a search artifact, the CLI prints build duration and **`search artifact` size in bytes**.

**Exit code:** Same rule as validate—**`1`** on error diagnostics.

## `docsfn dev [root]`

1. Runs an **initial** pipeline + `writeArtifacts` (same as build).
2. If errors occur, exits with code **`1`**.
3. Computes **watch targets**: config file candidates, content collection directories from config (and optional provider watch metadata), **excluding** the output directory.
4. Starts **chokidar** on those paths with `ignoreInitial: true`.
5. On any change, queues a **rebuild** (`runPipeline` with `changedPaths`), rewrites artifacts, and prints diagnostics + `dev:rebuild` summary.

**Output directory exclusion:** Changes **inside** `.docsfn` (or your chosen `--out-dir`) do **not** trigger rebuilds, preventing feedback loops.

## Pipeline overview

1. **Load config** — `loadDocsConfig` from `docsfn.config.ts` / `.mjs` / `.js`.
2. **Create provider** — default CLI uses **`FsContentProvider`** rooted at the site.
3. **Build manifest** — `buildManifest(provider, config)` resolves pages, meta, navigation, routes.
4. **Build search index** — `buildSearchIndex(manifest, { search, auth })` when enabled.
5. **Collect diagnostics** — config, content, compat, and search stages surface structured issues.
6. **Write artifacts** — on `build` / `dev` only.

For day-to-day authoring, run **`docsfn dev`** in one terminal and your framework dev server in another so JSON artifacts stay fresh.

See also: [Search](./search), [Content providers](./content-providers).
