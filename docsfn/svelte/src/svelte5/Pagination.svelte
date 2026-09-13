<script lang="ts">
  export let surface: Record<string, any> | undefined = undefined;
  export let prev: { title: string; path: string } | undefined = undefined;
  export let next: { title: string; path: string } | undefined = undefined;

  $: resolvedPrev = prev ?? surface?.pagination?.prev;
  $: resolvedNext = next ?? surface?.pagination?.next;
</script>

{#if resolvedPrev || resolvedNext}
  <nav class="docsfn-pagination" aria-label="Docs pagination">
    {#if resolvedPrev}
      <a href={resolvedPrev.path}>Previous <strong>{resolvedPrev.title}</strong></a>
    {/if}
    {#if resolvedNext}
      <a href={resolvedNext.path}>Next <strong>{resolvedNext.title}</strong></a>
    {/if}
  </nav>
{/if}

<style>
  .docsfn-pagination {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    padding: 1rem;
  }

  .docsfn-pagination a {
    display: grid;
    gap: 0.2rem;
    border-radius: 1rem;
    background: rgba(61, 91, 64, 0.1);
    padding: 0.85rem;
    text-decoration: none;
  }

  .docsfn-pagination a:last-child {
    text-align: right;
  }
</style>
