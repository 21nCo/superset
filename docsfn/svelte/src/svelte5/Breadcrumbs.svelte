<script lang="ts">
  export let surface: Record<string, any> | undefined = undefined;
  export let items: Array<{ label: string; href?: string }> | undefined = undefined;

  $: resolvedItems = items ?? surface?.breadcrumbs ?? [];
</script>

{#if resolvedItems.length > 0}
  <nav class="docsfn-breadcrumbs" aria-label="Breadcrumbs">
    {#each resolvedItems as item, index}
      <a href={item.href ?? "#"}>{item.label}</a>
      {#if index < resolvedItems.length - 1}
        <span>/</span>
      {/if}
    {/each}
  </nav>
{/if}

<style>
  .docsfn-breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    color: rgba(23, 33, 25, 0.62);
    font-size: 0.85rem;
  }

  .docsfn-breadcrumbs a {
    color: inherit;
    text-decoration: none;
  }

  .docsfn-breadcrumbs a:hover {
    color: #172119;
  }
</style>
