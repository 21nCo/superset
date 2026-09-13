<script lang="ts">
  import ApiReferenceRenderer from "@docsfn/svelte/ApiReferenceRenderer.svelte";
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<div class="docs-example-grid">
  <aside class="docs-example-sidebar">
    <h2>Navigation</h2>
    {#if data.sidebarLinks.length > 0}
      <ul class="docs-example-sidebar-list">
        {#each data.sidebarLinks as link (`${link.path}:${link.depth}`)}
          <li data-depth={link.depth} style="padding-left: {link.depth * 12}px">
            <a
              href={link.path}
              class:active={link.path === data.surface.route}
              aria-current={link.path === data.surface.route ? "page" : undefined}
            >
              {link.label}
            </a>
          </li>
        {/each}
      </ul>
    {:else}
      <p>No sidebar</p>
    {/if}
  </aside>

  <main class="docs-example-main">
    <header class="docs-example-topbar">
      <nav aria-label="Main navigation">
        <ul class="docs-example-topnav">
          {#each data.surface.topNav ?? [] as item (`${item.label}:${item.href}`)}
            <li>
              <a href={item.href}>{item.label}</a>
            </li>
          {/each}
        </ul>
      </nav>
      <p class="docs-example-search-status">
        Search ready: {data.searchDocumentCount} docs ({data.searchScopes})
      </p>
      <p class="docs-example-search-status" data-docsfn-search-runtime="true">
        Search probe: {data.searchProbe.resultCount} hits for "{data.searchProbe.query}"
        {#if data.searchProbe.firstPath}
          -> {data.searchProbe.firstPath}
        {/if}
      </p>
    </header>

    <nav aria-label="Breadcrumb">
      <ol class="docs-example-breadcrumbs">
        {#each data.surface.breadcrumbs ?? [] as crumb (`${crumb.label}:${crumb.href}`)}
          <li>
            <a href={crumb.href}>{crumb.label}</a>
          </li>
        {/each}
      </ol>
    </nav>

    {#if data.surface.versionLinks}
      <div class="docs-example-versions">
        <span>Versions:</span>
        {#each Object.entries(data.surface.versionLinks) as [slug, href] (slug)}
          <a href={href} class:active={slug === data.surface.currentVersion}>{slug}</a>
        {/each}
      </div>
    {/if}

    {#if data.routeEntry.kind === "page"}
      <article class="docs-example-article" data-docsfn-proof-surface="docs">
        <h1>{data.routeEntry.page.title}</h1>
        {#if data.routeEntry.page.description}
          <p>{data.routeEntry.page.description}</p>
        {/if}

        {#if (data.surface.headings ?? []).length > 0}
          <section>
            <h2>On this page</h2>
            <ul class="docs-example-toc">
              {#each data.surface.headings ?? [] as heading (heading.slug)}
                <li>
                  <a href={`#${heading.slug}`}>{heading.text}</a>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <DocsContent
          compiled={data.compiled}
        />
      </article>
    {:else}
      <article class="docs-example-article" data-docsfn-proof-surface="api">
        <h1>{data.routeEntry.api.title}</h1>
        <p>Route: {data.routeEntry.api.path}</p>
        <ApiReferenceRenderer api={data.routeEntry.api} />
      </article>
    {/if}

    {#if data.surface.pagination?.prev || data.surface.pagination?.next}
      <nav class="docs-example-pagination" aria-label="Pagination">
        {#if data.surface.pagination?.prev}
          <a href={data.surface.pagination.prev.path}>
            Previous: {data.surface.pagination.prev.title}
          </a>
        {:else}
          <span></span>
        {/if}
        {#if data.surface.pagination?.next}
          <a href={data.surface.pagination.next.path}>
            Next: {data.surface.pagination.next.title}
          </a>
        {:else}
          <span></span>
        {/if}
      </nav>
    {/if}
  </main>
</div>

<style>
  .docs-example-grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    min-height: 100dvh;
    font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
  }

  .docs-example-sidebar {
    border-right: 1px solid #e5e7eb;
    padding: 1.25rem;
  }

  .docs-example-sidebar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }

  .docs-example-sidebar-list a {
    color: #1f2937;
    text-decoration: none;
  }

  .docs-example-sidebar-list a.active {
    font-weight: 600;
  }

  .docs-example-main {
    padding: 1.5rem;
    display: grid;
    gap: 1rem;
  }

  .docs-example-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 0.75rem;
  }

  .docs-example-topnav {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 0.75rem;
  }

  .docs-example-search-status {
    margin: 0;
    font-size: 0.9rem;
    color: #6b7280;
  }

  .docs-example-breadcrumbs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .docs-example-breadcrumbs li:not(:last-child)::after {
    content: "/";
    margin-left: 0.5rem;
    color: #9ca3af;
  }

  .docs-example-versions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .docs-example-versions a.active {
    font-weight: 700;
  }

  .docs-example-article {
    display: grid;
    gap: 0.75rem;
  }

  .docs-example-toc {
    list-style: disc;
    margin: 0;
    padding-left: 1.25rem;
  }
  .docs-example-pagination {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    border-top: 1px solid #e5e7eb;
    padding-top: 0.75rem;
  }

  @media (max-width: 900px) {
    .docs-example-grid {
      grid-template-columns: 1fr;
    }

    .docs-example-sidebar {
      border-right: none;
      border-bottom: 1px solid #e5e7eb;
    }
  }
</style>
