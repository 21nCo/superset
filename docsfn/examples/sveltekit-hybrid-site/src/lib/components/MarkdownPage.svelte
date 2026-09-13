<script lang="ts">
  import type { DocsCompatPreset } from "@docsfn/core";
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";

  export let title: string;
  export let description: string | undefined = undefined;
  export let path: string;
  export let content: string;
  export let sourcePath: string;
  export let compatPreset: DocsCompatPreset = "none";
</script>

<article class="markdown-page">
  <div class="eyebrow">Standalone markdown page</div>
  <h1>{title}</h1>
  {#if description}
    <p class="lede">{description}</p>
  {/if}
  <p class="route">Route: {path}</p>

  <DocsContent content={content} {sourcePath} {compatPreset} />
</article>

<style>
  .markdown-page {
    display: grid;
    gap: 1rem;
    padding: 2rem 0 3rem;
  }

  .eyebrow {
    font-size: 0.8rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .lede,
  .route {
    color: #475569;
  }

  .route {
    font-size: 0.95rem;
  }
</style>
