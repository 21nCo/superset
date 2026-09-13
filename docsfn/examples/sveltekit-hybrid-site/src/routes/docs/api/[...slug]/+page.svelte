<script lang="ts">
  import ApiReferenceRenderer from "@docsfn/svelte/ApiReferenceRenderer.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<div class="api-layout">
  <aside class="sidebar">
    <p class="sidebar-label">OpenAPI references</p>
    <ul>
      {#each data.apiLinks as link (link.path)}
        <li>
          <a href={link.path} class:active={link.path === data.api.path}>{link.title}</a>
        </li>
      {/each}
    </ul>
  </aside>

  <article class="content">
    <div class="eyebrow">Generated from content/api</div>
    <h1>{data.api.title}</h1>
    <p class="lede">
      This route is intentionally thin: it loads the OpenAPI entry directly through
      <code>loadApiData()</code> and renders it with <code>ApiReferenceRenderer</code>.
    </p>

    <ApiReferenceRenderer api={data.api} />
  </article>
</div>

<style>
  .api-layout {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 2rem;
    padding: 2rem 0 3rem;
  }

  .sidebar-label,
  .eyebrow {
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .sidebar ul {
    list-style: none;
    margin: 0.8rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.45rem;
  }

  .sidebar a {
    text-decoration: none;
    color: #334155;
  }

  .sidebar a.active {
    font-weight: 700;
    color: #0f172a;
  }

  .content {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .lede {
    color: #475569;
  }

  @media (max-width: 840px) {
    .api-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
