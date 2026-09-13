---
title: core — Navigation
description: Sidebar and breadcrumb helpers in @docsfn/core.
---

# Navigation (`@docsfn/core`)

## Building sidebars

### `buildSidebarFromPages(input)`

Builds a single **`Sidebar`** from normalized pages + per-directory **`meta.json`** rules.

### `buildSidebars(input)`

Produces **`Record<string, Sidebar>`**: always includes **`default`**, then one entry per **`config.navigation.sidebars`** key filtered by `include` globs.

### `buildAutoSidebar(pages)`

Convenience function: builds a **`Sidebar`** directly from an array of **`DocPage`** objects without config or meta rules. Useful for programmatic sidebar construction.

## Sidebar utilities

### `flattenSidebarLinks(sidebar)`

Depth-first list of `{ label, path }` link leaves (skips separators).

### `resolveSidebarForRoute({ sidebars, route })`

Returns the **first** sidebar id (alphabetical id order) whose flattened links contain **`route`**, or **`null`**.

## Breadcrumbs

### `resolveBreadcrumbsFromSidebar({ sidebar, route, rootLabel?, rootHref? })`

Builds breadcrumb items from the active sidebar trail.

### `generateBreadcrumbs(path, pagesOrManifest, options?)`

High-level API: when given a manifest with sidebars, delegates to sidebar resolution; otherwise falls back to path/page walking.

## Pagination

### `resolvePaginationFromSidebar({ sidebar, route })`

Prev/next links from flattened sidebar order; throws **`DOCS_ROUTE_NOT_FOUND`** if the route is not in that sidebar.

### `getPaginationFromSidebar(currentPath, sidebar)` / `getPaginationFromSidebarWithTitles(...)`

**`getPaginationFromSidebarWithTitles`** applies **`frontmatter.prev` / `frontmatter.next`** overrides when present.

## Top navigation

### `getTopNavigation(manifest)`

Returns **`manifest.topNav ?? []`**.
