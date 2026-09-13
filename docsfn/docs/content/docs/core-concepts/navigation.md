---
title: Navigation
description: Top navigation, breadcrumbs, pagination, active states, and keyboard shortcuts in docsfn.
---

# Navigation

docsfn separates **global top navigation** (`navigation.topNav` in config) from **per-page surfaces** resolved in your framework adapter (breadcrumbs, pagination, sidebar id, canonical URL).

See also: [Sidebars](./sidebars), [Configuration](./configuration), [SEO](./seo).

## Top navigation (`topNav`)

Configure an array of **`DocsTopNavItem`** entries:

```ts
navigation: {
  topNav: [
    { label: "Docs", href: "/docs" },
    { label: "Blog", href: "/blog" },
    {
      label: "More",
      href: "/docs",
      children: [
        { label: "Guides", href: "/docs/guides" },
        { label: "GitHub", href: "https://github.com/...", external: true },
      ],
    },
  ],
},
```

- **`label` / `href`**: Required for each item.
- **`external`**: Marks off-site links (e.g. for `rel` or styling in your layout).
- **`children`**: Optional nested items for dropdown-style menus in UI components that support them.

The manifest exposes `topNav` via **`getTopNavigation`**; SvelteKit’s **`resolveDocsPageSurface`** includes `topNav` on the surface for layouts.

## Breadcrumbs

Breadcrumbs are derived from the **active sidebar** and the **current route**:

1. **`flattenSidebarLinks`** collects ordered links (depth-first through groups).
2. A **root** crumb uses `homeLabel` / `homeHref` options (often the site title and `/docs`).
3. **`resolveBreadcrumbsFromSidebar`** walks the sidebar tree to locate the trail to the active link.
4. **Groups** on the trail add a crumb pointing at the **first link inside that group** (so group labels are navigable).

In SvelteKit, call **`resolveDocsPageSurface`** with `homeHref` and `homeLabel` aligned to your app’s docs landing route. The returned **`breadcrumbs`** array is ready for a `Breadcrumbs` component.

## Pagination (prev / next)

Pagination links are the **previous and next sibling links** in the **flattened order** of the **active sidebar** (same order as breadcrumbs’ linear link list).

- Implemented in core as **`resolvePaginationFromSidebar`**.
- Titles are filled from manifest pages via **`getPaginationFromSidebarWithTitles`**.

If the current route is **not** in that sidebar’s flattened list, pagination resolution throws `DOCS_ROUTE_NOT_FOUND`—keep routes and sidebar `include` patterns in sync.

## Frontmatter overrides

On a **`DocPage`**, frontmatter keys **`prev`** and **`next`** override sidebar-derived pagination when present.

Supported shapes:

- **String**: treated as the target path.

```yaml
---
title: Custom flow
prev: /docs/core-concepts/configuration
next:
  path: /docs/core-concepts/search
  title: Search
---
```

- **Object**: `path` or `href` (required), optional `title`.

When either override is set, **both** prev and next come from frontmatter only (missing side means `undefined`).

## Active page in the sidebar

`DocsSidebar` accepts **`activePath`** (usually `surface.route`). **`SidebarGroup`** marks a link active when `item.link === activePath`, sets `aria-current="page"`, and applies an `active` class. Parent **groups** expand when **`hasActiveChild`** is true so nested pages stay visible.

## Keyboard shortcuts: Alt + arrows

The **`Pagination`** component from `@docsfn/svelte` registers a window **`keydown`** listener:

- **Alt + ArrowLeft** → navigate to **previous** page (if present).
- **Alt + ArrowRight** → navigate to **next** page (if present).

This matches keyboard-centric docs browsing without focusing the pagination links first.

## SvelteKit wiring

Typical flow:

1. **`resolveDocsRouteDataOrThrow`** — resolve slug to a manifest entry.
2. **`resolveDocsPageSurface`** — breadcrumbs, pagination, `canonicalUrl`, `sidebarId`, etc.
3. Pass **`surface`** to **`DocsSidebar`**, **`Breadcrumbs`**, and **`Pagination`**.

See your app’s `+page.server.ts` for the exact options (`basePath`, `canonicalUrl`, `homeHref`).
