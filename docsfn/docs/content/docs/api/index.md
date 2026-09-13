---
title: API Reference
description: Package-level API reference for docsfn TypeScript packages.
---

# API Reference

docsfn ships as npm workspaces. This section documents the **primary runtime packages** used to build documentation sites.

| Package | Role | Reference |
| --- | --- | --- |
| **@docsfn/core** | Config loading, manifest build, search index, routing, Markdown compile, security, OpenAPI normalization | [Core](./core) |
| **@docsfn/sveltekit** | SvelteKit loaders, static params, route resolution, page surface, search response helper | [SvelteKit](./sveltekit) |
| **@docsfn/svelte** | Svelte 5 UI components (sidebar, top bar, search, content renderer, …) | [Svelte](./svelte) |
| **@docsfn/provider-fs** | Filesystem `DocsContentProvider` implementation | [Provider FS](./provider-fs) |
| **@docsfn/cli** | `validate`, `build`, and `dev` commands | [CLI](./cli) |
| **@docsfn/next** | Next.js App Router helpers (parity with SvelteKit kit) | [Next.js](./next) |
| **@docsfn/react** | React UI components (parity with `@docsfn/svelte`) | [React](./react) |

Conceptual guides (configuration, navigation, theming, integration) live under **[Guides](../guides)** and **[Core concepts](../core-concepts)**.
