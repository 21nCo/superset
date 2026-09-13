---
title: core — Config
description: loadDocsConfig, defaults, and config validation in @docsfn/core.
---

# Config (`@docsfn/core`)

## `DEFAULT_CONFIG_FILENAMES`

Readonly list of filenames tried under `cwd` when no explicit path is given:

- `docsfn.config.ts`
- `docsfn.config.mjs`
- `docsfn.config.js`

## `LoadDocsConfigInput`

| Field | Type | Description |
| --- | --- | --- |
| `cwd` | `string` | Working directory to resolve from. |
| `configPath` | `string` (optional) | Explicit config file path (absolute or relative to `cwd`). |

## `loadDocsConfig(input)`

- **Returns:** `Promise<DocsConfig>`
- **Behavior:** Discovers a config module, imports it (TypeScript supported via optional `typescript` transpile when native import fails), validates with the internal Zod schema, and returns a typed **`DocsConfig`**. If no file exists, returns **`createDefaultDocsConfig({ cwd })`**.
- **Throws:** **`DocsError`** with code **`DOCS_CONFIG_INVALID`** when the file is missing (explicit path), unloadable, or fails schema validation.

There is **no separate public `validateConfig` export**; validation runs inside **`loadDocsConfig`**. Use **`isDocsConfigError`** to narrow caught errors.

## `createDefaultDocsConfig({ cwd })`

Builds a minimal valid **`DocsConfig`** for tooling and tests (default dirs, search on, auth off).

## `isDocsConfigError(value)`

Type guard: returns true when `value` is a **`DocsError`** (`name === "DocsError"` with `code`).

## Related types

Full schema fields are described under **[Types](./types)** and **[Configuration](../../core-concepts/configuration)**.
