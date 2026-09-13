---
title: "@docsfn/react"
description: React UI primitives for docsfn layouts, navigation, search, API reference, blog, and theming.
---

# @docsfn/react

Present **`DocsManifest`**-backed documentation in React: sidebar, TOC, content rendering, search dialog, top bar, and OpenAPI-style API pages.

```bash
npm install @docsfn/react
```

## Peer dependencies

- **`react`** — UI components are React function components.
- **`@docsfn/core`** — types and runtime (`DocPage`, `Sidebar`, `ApiReference`, search runtime, markdown compile helpers, etc.).
- **`@uifn/react`** — primitives used by search, sidebar collapsibles, scroll areas, and menus.

Ensure your bundler resolves **`@uifn/react`** and applies the same React instance as your app.

## Package layout

| Concern | Where |
| --- | --- |
| Page chrome | **`DocsLayout`**, **`TopBar`**, **`DocsSidebar`**, **`DocsToc`**, **`Breadcrumbs`**, **`Pagination`**, **`VersionSwitcher`** |
| Content | **`DocsContent`**, **`EmbeddedPage`** |
| API reference | **`ApiReferenceRenderer`** |
| Blog | **`BlogList`** |
| Search | **`DocsSearch`** |
| Theming | **`ThemeProvider`**, **`useTheme`**, **`ThemeToggle`** |

See **[Components](./components)** for props and usage patterns for each export.

## `DocsPageSurface`

Many components accept an optional **`surface`** shaped like the object returned by framework helpers (e.g. **`resolveDocsPageSurface`** from **`@docsfn/next`** or **`@docsfn/sveltekit`**): `route`, `title`, `description`, `sidebar`, `headings`, `breadcrumbs`, `pagination`, `topNav`, version fields, `editLink`, `pageActions`. You can omit **`surface`** and pass explicit props instead (e.g. **`DocsSidebar`** with **`sidebar`** + **`activePath`**).

## Styles

Components rely on **`docsfn-*`** class names (e.g. **`docsfn-layout`**, **`docsfn-sidebar`**). Import your docs site CSS that targets these classes, or the default theme package your starter uses.
