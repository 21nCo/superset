<script lang="ts">
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<div class="paper-layout">
  <aside class="sidebar">
    <p class="sidebar-label">{data.sidebarTitle} sidebar</p>
    <ul>
      {#each data.sidebarLinks as link (link.path)}
        <li>
          <a href={link.path} class:active={link.path === data.page.path}>{link.label}</a>
        </li>
      {/each}
    </ul>
  </aside>

  <article class="content">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      {#each data.surface.breadcrumbs ?? [] as crumb, index (`${crumb.label}:${crumb.href}`)}
        <a href={crumb.href}>{crumb.label}</a>{#if index < (data.surface.breadcrumbs?.length ?? 0) - 1}<span>/</span>{/if}
      {/each}
    </nav>

    <div class="eyebrow">Paper page</div>
    {#if data.page.description}
      <p class="lede">{data.page.description}</p>
    {/if}

    <DocsContent
      content={data.page.body}
      sourcePath={data.page.id}
      compatPreset={data.compatPreset}
    />
  </article>
</div>

<style>
  .paper-layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 2rem;
    padding: 2rem 0 3rem;
  }

  .sidebar {
    padding-top: 0.4rem;
  }

  .sidebar-label {
    margin: 0 0 0.8rem;
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .sidebar ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.45rem;
  }

  .sidebar a {
    text-decoration: none;
    color: #334155;
  }

  .sidebar a.active {
    color: #0f172a;
    font-weight: 700;
  }

  .content {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    font-size: 0.95rem;
    color: #475569;
  }

  .breadcrumbs a {
    text-decoration: none;
  }

  .eyebrow {
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .lede {
    color: #475569;
  }

  @media (max-width: 840px) {
    .paper-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
