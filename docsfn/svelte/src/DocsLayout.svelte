<script lang="ts">
  import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core/browser";
  import DocsSidebar from "./DocsSidebar.svelte";
  import DocsToc from "./DocsToc.svelte";
  import Icon from "./Icon.svelte";

  export interface DocsPageLink {
    title: string;
    path: string;
  }

  export interface DocsPageBreadcrumbItem {
    label: string;
    href: string;
  }

  export interface DocsPagePagination {
    prev?: DocsPageLink;
    next?: DocsPageLink;
  }

  export interface DocsPageSurface {
    route: string;
    title?: string;
    description?: string;
    canonicalPath?: string;
    canonicalUrl?: string;
    editLink?: string;
    pageActions?: Array<Record<string, unknown>>;
    sidebar?: Sidebar;
    sidebarId?: string;
    headings?: DocHeading[];
    breadcrumbs?: DocsPageBreadcrumbItem[];
    pagination?: DocsPagePagination;
    topNav?: DocsTopNavItem[];
    versions?: Version[];
    currentVersion?: string;
    versionLinks?: Record<string, string>;
  }

  export let surface: DocsPageSurface | undefined = undefined;
  export let sidebar: Sidebar | undefined = undefined;
  export let headings: DocHeading[] | undefined = undefined;
  export let activePath: string | undefined = undefined;
  export let embedded = false;
  export let showSidebar: boolean | undefined = undefined;
  export let preservedSearchParams: Record<string, string> = {};

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
  $: resolvedHeadings = headings ?? surface?.headings ?? [];
  $: resolvedActivePath = activePath ?? surface?.route;
  $: sidebarVisible = (showSidebar ?? !embedded) && Boolean(resolvedSidebar);
  $: showToc = !embedded && resolvedHeadings.length > 0;

  let sidebarOpen = false;
</script>

<div
  class="docsfn-layout"
  class:docsfn-layout--embedded={embedded}
  class:docsfn-layout--sidebar-visible={sidebarVisible}
>
  {#if !embedded && $$slots.topbar}
    <div class="docsfn-layout-topbar">
      <slot name="topbar" />
    </div>
  {/if}

  {#if sidebarVisible}
    <div class="docsfn-mobile-toolbar">
      <button
        type="button"
        class="docsfn-mobile-menu-btn"
        aria-expanded={sidebarOpen}
        aria-controls="docsfn-sidebar-panel"
        on:click={() => (sidebarOpen = !sidebarOpen)}
      >
        {#if sidebarOpen}
          <Icon name="x" size={17} strokeWidth={1.8} />
          Close
        {:else}
          <Icon name="menu" size={17} strokeWidth={1.8} />
          Menu
        {/if}
      </button>
    </div>

    {#if sidebarOpen}
      <button
        type="button"
        class="docsfn-mobile-backdrop"
        aria-label="Close menu"
        on:click={() => (sidebarOpen = false)}
      ></button>
    {/if}
  {/if}

  <div class="docsfn-container">
    {#if sidebarVisible && resolvedSidebar}
      <aside
        id="docsfn-sidebar-panel"
        class="docsfn-sidebar-col"
        class:docsfn-sidebar-col--open={sidebarOpen}
      >
        <DocsSidebar
          surface={surface}
          sidebar={resolvedSidebar}
          activePath={resolvedActivePath}
          {preservedSearchParams}
        />
      </aside>
    {/if}

    <main class="docsfn-main">
      <slot />
    </main>

    {#if showToc}
      <aside class="docsfn-toc-col">
        <DocsToc surface={surface} headings={resolvedHeadings} />
      </aside>
    {/if}
  </div>
</div>

<style>
  .docsfn-layout--embedded {
    min-height: auto;
    background: transparent;
  }

  .docsfn-layout--embedded .docsfn-container {
    display: block;
    max-width: none;
    margin: 0;
  }

  .docsfn-layout--embedded .docsfn-main {
    max-width: min(100%, var(--docsfn-embed-main-max-width, 56rem));
    justify-self: start;
    padding:
      var(--docsfn-embed-padding-block, 1.25rem)
      var(--docsfn-embed-padding-inline, clamp(1rem, 3vw, 2rem));
  }

  .docsfn-layout--embedded .docsfn-sidebar-col {
    top: 0;
    height: 100vh;
    max-height: 100vh;
  }

  .docsfn-mobile-toolbar {
    display: block;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
    background: var(--docsfn-color-surface, #fff);
  }

  @media (min-width: 1024px) {
    .docsfn-layout--embedded.docsfn-layout--sidebar-visible .docsfn-container {
      display: grid;
      grid-template-columns: var(--docsfn-sidebar-width) minmax(0, 1fr);
    }

    .docsfn-layout--embedded.docsfn-layout--sidebar-visible .docsfn-main {
      padding-left: var(--docsfn-embed-sidebar-gap, clamp(1.25rem, 2.4vw, 2rem));
    }

    /* Remove from layout flow entirely (avoids stray gap above .docsfn-container). */
    .docsfn-mobile-toolbar {
      display: none !important;
      height: 0;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 0;
      overflow: hidden;
    }
  }

  .docsfn-mobile-menu-btn {
    font: inherit;
    font-size: 0.875rem;
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    background: var(--docsfn-color-surface, #fff);
    cursor: pointer;
  }

  .docsfn-mobile-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: none;
    padding: 0;
    margin: 0;
    background: rgb(15 23 42 / 0.4);
    cursor: pointer;
  }

  @media (max-width: 1023px) {
    .docsfn-sidebar-col {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: min(18rem, 88vw);
      z-index: 40;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      /* Drawer: no left gutter bleed; restore outer scroll (viewport may be shallow). */
      overflow-y: auto;
      box-shadow: 4px 0 24px rgb(15 23 42 / 0.12);
    }

    .docsfn-sidebar-col--open {
      transform: translateX(0);
    }
  }
</style>
