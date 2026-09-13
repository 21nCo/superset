---
title: Customizing Components
description: Override docsfn UI primitives in Svelte and React without forking the toolchain.
---

# Customizing Components

The `@docsfn/svelte` and `@docsfn/react` packages ship opinionated chrome (**TopBar**, **DocsSidebar**, **Breadcrumbs**, **Pagination**, **DocsContent**, …). You can extend them by passing **props**, **component maps**, **slots**, or by **wrapping** exported building blocks.

See also: [SvelteKit integration](./sveltekit), [Next.js integration](./nextjs), [Markdown extensions](../core-concepts/markdown-extensions).

---

## `DocsContent` and custom Markdown components

Compiled Markdown may emit **`component`** blocks (PascalCase tags). Both **`DocsContent`** implementations accept a **`components`** map from **tag name → component**.

**Svelte (`@docsfn/svelte`)** — `components: Record<string, ComponentType | undefined>`:

```svelte
<s
cript lang="ts">
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import MyCallout from "$lib/MyCallout.svelte";
</script>

<DocsContent
  compiled={data.compiled}
  components={{ MyCallout }}
/>
```

(Join the split opening **scr**/**ipt** line when pasting.)

**React (`@docsfn/react`)** — same idea with React components:

```tsx
<DocsContent
  compiled={compiled}
  components={{ MyCallout }}
/>
```

Unknown component names render as a fallback **`data-docsfn-component`** container until you add a mapping.

---

## Sidebar: reuse or replace

1. **Tweak `DocsSidebar`** — set **`expanded: true`** on specific `SidebarItem` groups in your sidebar model to control which groups start open.
2. **Reuse `SidebarGroup`** — import **`SidebarGroup`** from **`@docsfn/svelte`** and walk your own `Sidebar` model if you need different HTML or icons per depth.
3. **Fork layout** — copy the small loop from **`DocsSidebar.svelte`** into your project only when you need radically different markup; keep **`resolveDocsPageSurface`** so breadcrumbs and pagination stay aligned.

---

## Breadcrumb separator

**`Breadcrumbs`** accepts **`separator`** (Svelte: component constructor; React: component type). Default is a chevron SVG. Provide a slash, text, or icon component:

```svelte
<s
cript lang="ts">
  import Breadcrumbs from "@docsfn/svelte/Breadcrumbs.svelte";
  import SlashSeparator from "$lib/SlashSeparator.svelte";
</script>

<Breadcrumbs surface={data.surface} separator={SlashSeparator} />
```

React: pass `separator={SlashSeparator}` similarly.

You can also bypass **`surface`** entirely and pass **`items`** as `{ label, href? }[]`.

---

## Pagination layout

**`Pagination`** resolves **`prev` / `next`** from **`surface.pagination`** or from explicit props:

- **`prevPage`** / **`nextPage`** — `{ title, path }` overrides.
- **`sectionContext`** — optional label above the links.

Wrap the component in your own grid or flex container; class names on the root **`docsfn-pagination`** node can be targeted from global CSS.

---

## TopBar composition

**`TopBar`** props:

- **`items`** — flat links or dropdown groups (see **`TopBarItem`** / **`TopBarDropdown`** types). If omitted, items are derived from **`surface.topNav`**.
- **`logo`** — component rendered in the left slot.
- **`searchTrigger`** — component rendered in the actions row (often **`DocsSearch`** or a thin wrapper).
- **`versionSelector`** — optional component (e.g. **`VersionSwitcher`**).
- **`mobileMenuTrigger`** — optional custom menu control.

Pass **`surface`** when you want nav + version links to come from the manifest in one shot.

---

## Custom CSS

Stable hooks include:

- **`docsfn-topbar`**, **`docsfn-sidebar-*`**, **`docsfn-breadcrumbs-*`**, **`docsfn-pagination-*`**, **`docsfn-content`**, **`docsfn-search-*`**, **`data-docsfn-*`** attributes on callouts, tabs, and code blocks.

Prefer overriding **CSS variables** (e.g. colors from [Theming](../core-concepts/theming)) before rewriting rules. Scope overrides under your root layout class to avoid leaking into non-docs routes.

---

## Wrapper components

Common patterns:

- **SearchWrapper** — renders **`DocsSearch`** with **`loadSearchArtifact`**, analytics callbacks, and narrowed **`scopes`**.
- **BrandedTopBar** — wraps **`TopBar`** and injects **`logo`** + **`items`** from CMS data while still using manifest **`surface`** for version links.
- **DocsPageShell** — wraps **`Breadcrumbs`**, **`DocsContent`**, **`Pagination`**, and **`DocsToc`** with your grid and sticky behavior.

Keep **`resolveDocsPageSurface`** (SvelteKit / Next) as the single source of truth for **`route`**, **`breadcrumbs`**, and **`pagination`** so you do not drift from core routing.

For React, keep component imports on the package root:

```tsx
import { DocsContent, TopBar } from "@docsfn/react";
```
