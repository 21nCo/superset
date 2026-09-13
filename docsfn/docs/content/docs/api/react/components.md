---
title: "@docsfn/react — components"
description: Props and usage for DocsLayout, DocsSidebar, DocsContent, DocsSearch, ApiReferenceRenderer, and other React exports.
---

# Components

Reference for **`@docsfn/react`** exports. Types come from **`./DocsLayout`** or **`@docsfn/core`** as noted.

## Quick usage snippets

```tsx
// DocsLayout + TopBar + surface from @docsfn/next / @docsfn/sveltekit
<DocsLayout surface={surface} topbar={<TopBar surface={surface} searchTrigger={searchTriggerNode} />}>
  <Breadcrumbs surface={surface} />
  <DocsContent compiled={page.compiled} pageActionsSlot={editLinkSlot} />
  <Pagination surface={surface} />
</DocsLayout>
```

```tsx
// Standalone sidebar / TOC
<DocsSidebar sidebar={manifest.sidebars.default} activePath={page.path} />
<DocsToc headings={page.headings} />
```

```tsx
<DocsSearch loadSearchArtifact={() => fetch("/search.json").then((r) => r.json())} />
<ApiReferenceRenderer api={api} />
<BlogList posts={Object.values(manifest.posts)} />
<VersionSwitcher surface={surface} />
```

```tsx
<ThemeProvider defaultTheme="system">
  <ThemeToggle />
</ThemeProvider>
<EmbeddedPage page={{ title: "Embed", body: markdownSource, headings }} compiled={compiledArtifact} />
```

## `DocsLayout`

**Props (`DocsLayoutProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`children`** | `ReactNode` | Main column body |
| **`surface`** | `DocsPageSurface?` | Optional aggregated nav/content metadata |
| **`sidebar`** | `Sidebar?` | Overrides `surface.sidebar` |
| **`headings`** | `DocHeading[]?` | Overrides `surface.headings` for TOC |
| **`activePath`** | `string?` | Active sidebar href; default `surface.route` |
| **`topbar`** | `ReactNode?` | Rendered in **`docsfn-topbar`** above the container |

Renders **`docsfn-layout`**: optional top bar, sidebar column (**`DocsSidebar`**), main (**`children`**), TOC column (**`DocsToc`**) when headings exist.

## `DocsSidebar`

**Props (`DocsSidebarProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | Supplies `sidebar` and `route` when props below omitted |
| **`sidebar`** | `Sidebar?` | From manifest; required unless on `surface` |
| **`activePath`** | `string?` | Highlights current item |

Uses **`@uifn/react`** **`Collapsible`** + **`ScrollArea`** for nested sidebar items. Groups expand when `item.expanded === true` or when a descendant link matches `activePath`.

## `Breadcrumbs`

**Props (`BreadcrumbsProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | Uses `surface.breadcrumbs` when `items` empty |
| **`items`** | `BreadcrumbItem[]?` | `{ label, href? }` — explicit trail wins |
| **`separator`** | `ReactNode?` | Between crumbs |
| **`className`** | `string?` | Wrapper class |

Returns **`null`** if there are no items.

## `DocsContent`

Renders compiled markdown blocks (headings, paragraphs, code, mermaid placeholders, callouts, tabs) or compiles **`content`** on the client via **`compileReactContent`**.

**Props (`DocsContentProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`compiled`** | `CompiledContentArtifact?` | Pre-compiled blocks from core |
| **`content`** | `string?` | Raw markdown / MDX source to compile |
| **`sourcePath`** | `string?` | Passed to compiler for diagnostics |
| **`compatPreset`** | `DocsCompatPreset?` | Default **`"none"`** |
| **`allowUnsafeHtml`** | `boolean?` | Default **`false`** |
| **`unsafeHtmlAllowlist`** | `string[]?` | Tag allowlist when unsafe HTML enabled |
| **`components`** | `Record<string, ComponentType<{children?}>>?` | Custom MDX-style components by name |
| **`renderMermaid`** | `(block: MermaidBlock) => ReactNode?` | Custom render function for Mermaid diagram blocks |
| **`pageActionsSlot`** | `ReactNode?` | Injected near the article actions region |

Trust path: when using **`compiled`**, core’s **`assertCompiledContentTrusted`** applies.

## `DocsToc`

**Props (`DocsTocProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | Default headings from `surface.headings` |
| **`headings`** | `DocHeading[]?` | Explicit outline |
| **`activeHash`** | `string?` | Controlled hash for active section |

Uses **`IntersectionObserver`** (when no controlled `activeHash`) to highlight the visible heading.

## `Pagination`

**Props (`PaginationProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | Uses `surface.pagination.prev` / `next` |
| **`prevPage`** / **`nextPage`** | `DocsPageLink?` | `{ title, path }` overrides |
| **`sectionContext`** | `string?` | Optional label for a11y |
| **`className`** | `string?` | Wrapper class |

Registers **`Alt+ArrowLeft` / `Alt+ArrowRight`** to navigate prev/next when defined.

## `DocsSearch`

Client search UI over a **`DocsSearchArtifact`** (or async loader). Uses **`createDocsSearchRuntime`** from core.

**Props (`DocsSearchProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`searchArtifact`** | `DocsSearchArtifact?` | Inline index |
| **`searchIndex`** | `DocsSearchArtifact?` | Alias of artifact |
| **`loadSearchArtifact`** | `() => Promise<DocsSearchArtifact>?` | Lazy load |
| **`placeholder`** | `string?` | Default **`"Search docs..."`** |
| **`initialScope`** | `DocsSearchScope \| "all"` | Default **`"all"`** |
| **`scopes`** | Array of scope or **`"all"`** | Default all scopes |
| **`analytics`** | `{ enabled?, respectDnt?, route?, onEvent? }` | Forwards to **`maybeEmitAnalyticsEvent`** |

Either provide an artifact or **`loadSearchArtifact`**.

## `ApiReferenceRenderer`

Renders an **`ApiReference`** (OpenAPI-derived) with tabs for paths, schemas, etc.

**Props (`ApiReferenceRendererProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`api`** | `ApiReference` | Required |
| **`className`** | `string?` | Root wrapper class |

Depends on **`@uifn/react`** **`Tabs`** and **`ScrollArea`**.

## `BlogList`

**Props (`BlogListProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`posts`** | `BlogPost[]` | Required |
| **`selectedTag`** | `string?` | Filter posts whose tags include this (case-insensitive) |
| **`onTagClick`** | `(tag: string) => void?` | Tag chip handler |

Sorts by date (newest first) when parseable, else by slug.

## `VersionSwitcher`

**Props (`VersionSwitcherProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | `versions`, `currentVersion`, `versionLinks` |
| **`versions`** | `Version[]?` | Override list |
| **`currentVersion`** | `string?` | Active slug |
| **`onVersionChange`** | `(versionSlug: string) => void?` | Selection callback (e.g. router push) |
| **`className`** | `string?` | Wrapper class |

Uses the **`@uifn/react`** **`Menu`** primitive.

## `ThemeProvider`

**Props (`ThemeProviderProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`children`** | `ReactNode` | Required |
| **`defaultTheme`** | **`Theme`** (`"light"` \| `"dark"` \| `"system"`) | Default **`"system"`** |
| **`storageKey`** | `string?` | **`localStorage`** key; default **`"docsfn-theme"`** |

Sets **`document.documentElement`** classes **`light`/`dark`** and **`data-docsfn-theme`**.

Also exported:

- **`useTheme()`** → **`ThemeContextValue`**: `{ theme, setTheme, actualTheme }` — throws if used outside provider.
- **`ThemeToggle({ className? })`** — simple toggle control.

## `TopBar`

**Props (`TopBarProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`surface`** | `DocsPageSurface?` | Maps `topNav` to items when `items` omitted |
| **`logo`** | `ReactNode?` | Brand slot |
| **`items`** | **`TopBarItem[]?`** | Links or dropdowns (**`TopBarLink`**, **`TopBarDropdown`**) |
| **`searchTrigger`** | `ReactNode?` | e.g. button opening search |
| **`versionSelector`** | `ReactNode?` | e.g. **`VersionSwitcher`** |
| **`mobileMenuTrigger`** | `ReactNode?` | Hamburger / drawer trigger |
| **`className`** | `string?` | Appended to **`docsfn-topbar`** |

**`TopBarLink`:** `label`, `href`, `external?`. **Dropdown:** `label`, `items: TopBarLink[]`.

## `EmbeddedPage`

For docs or marketing surfaces that are not full **`DocsLayout`** pages: article + optional TOC + **`DocsContent`**.

**Props (`EmbeddedPageProps`):**

| Prop | Type | Description |
| --- | --- | --- |
| **`page`** | **`EmbeddedPageModel`** | `title`, `description?`, `body`, `headings?` |
| **`compiled`** | `CompiledContentArtifact?` | Passed through to **`DocsContent`** |
| **`compatPreset`** | `DocsCompatPreset?` | Default **`"none"`** |
| **`components`** | Custom component map | Same as **`DocsContent`** |
| **`showToc`** | `boolean?` | Default **`true`** |
| **`tocLabel`** | `string?` | Default **`"On this page"`** |
| **`pageActionsSlot`** | `ReactNode?` | Forwarded to **`DocsContent`** |

### VersionSwitcher path configuration

`basePath` is the site mount (default `/docs`). `versionMode` accepts `path-prefix` (default) or `path-segment`. When no version-link override is available, `path-prefix` replaces the version immediately after the mount; `path-segment` replaces the trailing version segment. Navigation preserves the remaining path, trailing slash, query, and hash.
