---
title: Core Concepts
description: Configuration, content format, navigation, search, and the rest of the docsfn mental model.
---

# Core Concepts

These pages explain how docsfn interprets your **config**, your **Markdown**, your **`meta.json`** trees, and how features like **search**, **blog**, **OpenAPI**, and **auth** connect end to end.

## In this section

### Foundations

- **[Configuration](./configuration)** — Every `DocsConfig` field: types, defaults, and examples.
- **[Content format](./content-format)** — Markdown, frontmatter, `meta.json`, URLs, and collections.
- **[Sidebars](./sidebars)** — `meta.json` ordering, `navigation.sidebars`, multiple sidebars, groups, and resolution.
- **[Navigation](./navigation)** — Top nav, breadcrumbs, pagination, frontmatter overrides, active states, keyboard shortcuts.
- **[Search](./search)** — Scopes, body indexing, artifacts, `DocsSearch`, and scoring overview.
- **[SEO](./seo)** — Site metadata, canonical URLs, `basePath`, and SvelteKit head tags.
- **[Theming](./theming)** — `--docsfn-*` variables, `ThemeConfig`, Tailwind, dark mode.
- **[CLI](./cli)** — `validate`, `build`, `dev`, artifacts, exit codes.
- **[Content providers](./content-providers)** — `DocsContentProvider`, `FsContentProvider`, custom sources.

### Features

- **[Blog](./blog)** — Posts, drafts, tags, archives, `BlogManifestSurface`.
- **[Versioning](./versioning)** — Modes, URLs, static params, `VersionSwitcher`.
- **[OpenAPI](./openapi)** — Spec files, generated routes, `ApiReferenceRenderer`.
- **[Security](./security)** — HTML rules, auth modes, private routes, redaction, allowlist env.
- **[Analytics](./analytics)** — Canonical events, DNT, URL sanitization, `watchfn`.
- **[RSS](./rss)** — RSS 2.0 channel, Atom self-link, serving feeds.
- **[Markdown extensions](./markdown-extensions)** — Callouts, Mermaid, tabs, components.
- **[Diagnostics](./diagnostics)** — Error codes, severities, `diagnostics.json`, troubleshooting.
