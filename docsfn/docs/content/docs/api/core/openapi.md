---
title: core — OpenAPI
description: OpenAPI parsing and CanonicalOpenApiReference in @docsfn/core.
---

# OpenAPI (`@docsfn/core`)

## Pipeline functions

| Function | Role |
| --- | --- |
| **`parseOpenApiSource`** | Detect JSON vs YAML, parse to object, validate top-level shape. |
| **`normalizeOpenApiReference`** | Transform parsed spec → canonical reference (+ diagnostics for unsupported sections like webhooks). |
| **`buildOpenApiReference`** | High-level builder used by **`buildManifest`** (`body` string in). |
| **`resolveOpenApiRoute(reference, route)`** | Classify a path against `reference.routes` (overview, tag, operation, schema). |

## `CanonicalOpenApiReference` (summary)

| Area | Content |
| --- | --- |
| Identity | `schemaVersion`, `sourceId`, `sourcePath`, `sourceFormat`, `openapiVersion`. |
| Info | `title`, `description`, `version`, `info`, `servers`. |
| Model | `tags[]` (**`CanonicalOpenApiTagGroup`**), `operations[]`, `schemas[]`. |
| Routes | **`routes`**: `overview`, maps for `tags`, `operations`, `schemas`, plus **`all`**. |
| Meta | `sourceMeta` (etag, sha256, remoteUrl, …). |
| Diagnostics | OpenAPI-level warnings. |

Operation paths follow **`{apiRoot}/operations/{method}-{slug}`**; tags **`.../tags/{slug}`**; schemas **`.../schemas/{slug}`**.
