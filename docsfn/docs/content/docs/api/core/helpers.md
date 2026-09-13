---
title: core — Helpers
description: High-level navigation helper exports from @docsfn/core.
---

# Helpers (`@docsfn/core`)

The **`helpers.ts`** module composes navigation primitives for adapters:

| Function | Description |
| --- | --- |
| **`generateBreadcrumbs`** | Sidebar-aware or page-walking breadcrumbs (see [Navigation](./navigation)). |
| **`getPaginationFromSidebar`** | Safe wrapper around **`resolvePaginationFromSidebar`** (swallows not-found). |
| **`getPaginationFromSidebarWithTitles`** | Adds titles from manifest pages + frontmatter overrides. |
| **`getTopNavigation`** | Returns manifest top nav array. |

Types **`BreadcrumbItem`** and **`PaginationLinks`** are exported alongside these functions.
