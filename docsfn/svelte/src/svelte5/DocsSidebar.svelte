<script lang="ts">
  export let surface: Record<string, any> | undefined = undefined;
  export let sidebar: { items?: Array<{ type: string; text: string; link?: string; items?: any[] }> } | undefined = undefined;
  export let activePath: string | undefined = undefined;

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
</script>

{#if resolvedSidebar}
  <nav class="docsfn-sidebar" aria-label="Docs">
    {#each resolvedSidebar.items ?? [] as item}
      {#if item.type === "separator"}
        <hr />
      {:else if item.type === "group"}
        <section>
          <strong>{item.text}</strong>
          {#each item.items ?? [] as child}
            <a class:active={child.link === activePath} href={child.link ?? "#"}>{child.text}</a>
          {/each}
        </section>
      {:else}
        <a class:active={item.link === activePath} href={item.link ?? "#"}>{item.text}</a>
      {/if}
    {/each}
  </nav>
{/if}

<style>
  .docsfn-sidebar,
  .docsfn-sidebar section {
    display: grid;
    gap: 0.45rem;
  }

  .docsfn-sidebar a {
    border-radius: 0.75rem;
    color: rgba(23, 33, 25, 0.76);
    padding: 0.45rem 0.6rem;
    text-decoration: none;
  }

  .docsfn-sidebar a.active,
  .docsfn-sidebar a:hover {
    background: rgba(61, 91, 64, 0.12);
    color: #172119;
  }
</style>
