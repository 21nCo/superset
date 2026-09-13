---
title: OpenAPI
description: Adding OpenAPI 3.x specs to the api collection, generated routes, and rendering with ApiReferenceRenderer.
---

# OpenAPI

docsfn ingests **OpenAPI 3.x** specs from the **api** collection, builds a **`CanonicalOpenApiReference`**, registers **one route per surface** (overview, tag, operation, schema), and stores the canonical object on **`ApiReference.spec`** in the manifest.

See also: [Content providers](./content-providers), [Diagnostics](./diagnostics).

## Supported formats

- **JSON** — `.json`
- **YAML** — `.yaml`, `.yml`

Unsupported major versions fail with **`DOCS_OPENAPI_PARSE_FAILED`**.

## Where to put specs

Add files under your configured **`content.apiDir`** (commonly `content/api`). Each file becomes an **`ApiReference`** with a slug derived from its path.

Keep Markdown docs and OpenAPI specs as separate collections. If you want Markdown package docs under `/docs/api/...`, place those files under `content/docs/api` and classify their routes with `search.routeScopeOverrides`.

## API root path

**`buildApiRootPath(basePath, sourcePath)`** produces:

- **`{basePath}/api`** when the spec lives at the collection root, or
- **`{basePath}/api/{logicalPath}`** when nested (logical path from the file without extension).

All generated routes hang under that **`apiRootPath`**.

## Auto-generated routes

For each spec:

| Surface | Route pattern (under `apiRootPath`) |
| --- | --- |
| Overview | `{apiRootPath}` |
| Tag group | `{apiRootPath}/tags/{tag-slug}` |
| Operation | `{apiRootPath}/operations/{method}-{operation-slug}` |
| Schema | `{apiRootPath}/schemas/{schema-slug}` |

- **Operation slugs** use `operationId` when set (normalized); otherwise a slug from the path item.
- **Tag slugs** normalize the OpenAPI tag name.
- **Schema slugs** normalize component schema names.

**`CanonicalOpenApiRoutes`** exposes `overview`, `tags`, `operations`, `schemas`, and **`all`** (sorted list). The manifest **`routes`** map includes every path → api id.

## `CanonicalOpenApiReference`

Key fields include `schemaVersion`, `sourceId`, `sourcePath`, `sourceFormat`, `openapiVersion`, `info`, `servers`, **`tags`** (tag groups + operation ids), **`operations`**, **`schemas`**, **`routes`**, and **`diagnostics`** (e.g. warnings for unsupported features like webhooks).

## `ApiReferenceRenderer`

From **`@docsfn/svelte`**, pass **`api: ApiReference`** (from **`resolveDocsRouteDataOrThrow`** / manifest). The renderer reads **`api.spec`** as the canonical reference and presents operations, parameters, and responses using shared UI primitives (tabs, scroll areas).

Use your framework’s docs catch-all route to render **`ApiReferenceRenderer`** for `routeEntry.kind === "api"` (as in the docsfn docs site).
