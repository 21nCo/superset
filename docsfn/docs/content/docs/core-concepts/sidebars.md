---
title: Sidebars
description: How docsfn builds sidebars from meta.json, directory trees, and navigation.sidebars in your config.
---

# Sidebars

Sidebars are built from your **docs collection** (Markdown files under `content.docsDir`) plus optional **`meta.json`** files in each directory. You can define **multiple named sidebars** in `docsfn.config.ts` and docsfn picks the one that contains the current route.

See also: [Configuration](./configuration), [Content format](./content-format), [Navigation](./navigation).

## Auto-build from directories

For each docs page, the filesystem path (relative to the docs directory) becomes part of the URL and the sidebar tree:

- A folder with an `index.md` can act as a **section root** (see `root` in `meta.json` below).
- Nested folders become **nested groups** in the sidebar unless `meta.json` changes ordering or visibility.

The manifest stores sidebars as trees of items with `type: "link" | "group" | "separator"`.

## Ordering with `meta.json`

Each directory may contain a `meta.json` (or the name from `content.metaFileName`). It controls **section title**, **root** behavior, and the **`pages`** array that orders children.

### `pages` array: string shorthand

Use strings for file or folder keys (without `.md`):

```json
{
  "title": "Core Concepts",
  "pages": ["index", "configuration", "sidebars"]
}
```

### Object rules: `key`, `label`, `icon`, `hidden`

Objects support:

| Field | Purpose |
| --- | --- |
| `key` / `id` / `page` / `name` | Which file or directory key to include (normalized slug). |
| `label` or `title` | Override the visible label (default: derived from filename). |
| `icon` | Optional string prefixed to the label (e.g. emoji) for display. |
| `hidden` | When `true`, the page is omitted from the sidebar (the route may still exist). |

Example:

```json
{
  "title": "Guides",
  "pages": [
    "index",
    { "key": "advanced", "label": "Advanced topics", "icon": "⚡" },
    { "key": "draft-page", "hidden": true }
  ]
}
```

## Custom sidebars in config

Under `navigation.sidebars`, each entry is a **`DocsSidebarDefinition`**:

```ts
navigation: {
  sidebars: {
    docs: {
      title: "Documentation",
      root: true,
      include: ["docs/**"],
    },
    api: {
      title: "API Reference",
      root: true,
      include: ["docs/api/**"],
    },
  },
},
```

- **`include`**: glob patterns matched against `docs/<sourcePath>` for each docs page. Only matching pages appear in that sidebar.
- **`title`**: Human-facing title for the sidebar (stored on the manifest surface for adapters).
- **`root`**: Passed through meta handling so flattened groups behave consistently with auto-built trees.

A **`default`** sidebar is always generated from all docs pages. Named sidebars **filter** that page set.

## Multiple sidebars and route switching

`resolveSidebarForRoute` walks **sorted sidebar ids** and picks the **first** sidebar whose flattened link list contains the current route. Alphabetical id order matters when two sidebars both contain the same path—e.g. `api` before `docs` means API wins for overlapping routes.

Configure non-overlapping `include` patterns (as in the [Configuration](./configuration) examples) to avoid ambiguity.

## Groups and nesting

- Subdirectories become **`group`** items with nested **`link`** children.
- If a child directory’s `meta.json` sets **`"root": true`**, its index and children are **promoted**: the section may render as a single top-level link plus flattened items instead of a deep exclusive group (see core `renderDirectory` / `root` handling).

## Default open vs collapsed groups

In `@docsfn/svelte`, `SidebarGroup` uses **collapsible** UI. A group is shown **open** when `expanded === true` on the item **or** when any descendant link matches the active route (`hasActiveChild`). To start specific groups open, set `expanded: true` on those `SidebarItem` groups in your sidebar model.

## Hidden pages

Set `"hidden": true` on a `meta.json` page rule. Those entries are **skipped** when building sidebar items; use this for WIP pages you still want routable or linked manually.

## Item types: `link`, `group`, `separator`

| Type | Meaning |
| --- | --- |
| `link` | Navigates to a docs route (`text` + `link`). |
| `group` | Named section containing nested items. |
| `separator` | Horizontal rule in the sidebar UI (`DocsSidebar` / `SidebarGroup`). |

Filesystem-driven trees emit **links** and **groups**. **`separator`** items are part of the shared `SidebarItem` model for manual or generated manifests.

## Resolution summary

1. Build **all docs pages** and **meta** map.
2. Build **`default`** sidebar from every docs page.
3. For each `navigation.sidebars` entry, **filter** pages by `include` globs and build a sidebar with the same meta rules.
4. At runtime, **`resolveSidebarForRoute`** selects the matching sidebar id for the active path.

## Example: docs + API sidebars

**Config** (abbreviated):

```ts
navigation: {
  sidebars: {
    docs: { title: "Documentation", root: true, include: ["docs/**"] },
    api: { title: "API Reference", root: true, include: ["docs/api/**"] },
  },
},
```

**Resulting behavior** (conceptually):

- Routes under `/docs/api/...` resolve to the **`api`** sidebar (first match with `api` before `docs` when both match).
- Other docs routes use the **`docs`** sidebar.
- [Navigation](./navigation) covers breadcrumbs and pagination for the active sidebar.
