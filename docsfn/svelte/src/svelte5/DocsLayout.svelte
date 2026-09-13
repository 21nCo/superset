<script lang="ts">
  import DocsSidebar from "./DocsSidebar.svelte";
  import DocsToc from "./DocsToc.svelte";

  export let surface: Record<string, any> | undefined = undefined;
  export let sidebar: Record<string, any> | undefined = undefined;
  export let headings: Array<Record<string, any>> | undefined = undefined;
  export let activePath: string | undefined = undefined;

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
  $: resolvedHeadings = headings ?? surface?.headings ?? [];
  $: resolvedActivePath = activePath ?? surface?.route;
</script>

<div class="docsfn-layout">
  {#if resolvedSidebar}
    <aside class="docsfn-layout-sidebar">
      <DocsSidebar sidebar={resolvedSidebar} activePath={resolvedActivePath} />
    </aside>
  {/if}
  <section class="docsfn-layout-main">
    <slot />
  </section>
  {#if resolvedHeadings.length > 0}
    <aside class="docsfn-layout-toc">
      <DocsToc headings={resolvedHeadings} />
    </aside>
  {/if}
</div>

<style>
  .docsfn-layout {
    display: grid;
    grid-template-columns: minmax(11rem, 0.22fr) minmax(0, 1fr) minmax(10rem, 0.2fr);
    min-height: 100%;
  }

  .docsfn-layout-sidebar,
  .docsfn-layout-toc {
    border-color: rgba(23, 33, 25, 0.1);
    background: rgba(255, 252, 242, 0.54);
    padding: 1rem;
  }

  .docsfn-layout-sidebar {
    border-right: 1px solid rgba(23, 33, 25, 0.1);
  }

  .docsfn-layout-toc {
    border-left: 1px solid rgba(23, 33, 25, 0.1);
  }

  .docsfn-layout-main {
    min-width: 0;
  }

  @media (max-width: 980px) {
    .docsfn-layout {
      grid-template-columns: 1fr;
    }

    .docsfn-layout-sidebar,
    .docsfn-layout-toc {
      border: 0;
    }
  }
</style>
