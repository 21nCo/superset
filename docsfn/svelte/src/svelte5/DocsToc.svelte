<script lang="ts">
  export let surface: Record<string, any> | undefined = undefined;
  export let headings: Array<{ level?: number; depth?: number; text: string; slug?: string; id?: string }> | undefined =
    undefined;

  $: resolvedHeadings = headings ?? surface?.headings ?? [];
</script>

{#if resolvedHeadings.length > 0}
  <nav class="docsfn-toc" aria-label="On this page">
    <strong>On this page</strong>
    {#each resolvedHeadings as heading}
      <a
        href={`#${heading.slug ?? heading.id ?? ""}`}
        style={`--depth: ${(heading.level ?? heading.depth ?? 2) - 1}`}
      >
        {heading.text}
      </a>
    {/each}
  </nav>
{/if}

<style>
  .docsfn-toc {
    display: grid;
    gap: 0.45rem;
  }

  .docsfn-toc a {
    color: rgba(23, 33, 25, 0.68);
    font-size: 0.85rem;
    padding-left: calc(var(--depth, 1) * 0.6rem);
    text-decoration: none;
  }

  .docsfn-toc a:hover {
    color: #172119;
  }
</style>
