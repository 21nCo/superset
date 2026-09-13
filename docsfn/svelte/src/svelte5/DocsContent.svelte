<script lang="ts">
  import { compileMarkdown } from "../../../core/dist/browser.js";

  type CompiledBlock = {
    type: string;
    html?: string;
    code?: string;
    lang?: string;
    text?: string;
    items?: Array<{ text: string }>;
  };

  export let compiled: { blocks?: CompiledBlock[] } | undefined = undefined;
  export let blocks: CompiledBlock[] | undefined = undefined;
  export let content = "";
  export let sourcePath: string | undefined = undefined;
  export let compatPreset = "none";
  export let allowUnsafeHtml = false;

  $: compiledContent =
    compiled ??
    compileMarkdown({
      source: content,
      sourcePath,
      framework: "svelte",
      compatPreset: compatPreset as "none" | "fumadocs-v15",
      allowRawHtml: allowUnsafeHtml
    });
  $: renderedBlocks = blocks ?? compiledContent.blocks ?? [];
</script>

<article class="docsfn-content">
  {#each renderedBlocks as block}
    {#if block.html}
      <section class={`docsfn-block docsfn-${block.type}`}>{@html block.html}</section>
    {:else if block.type === "code"}
      <pre class="docsfn-code"><code>{block.code}</code></pre>
    {:else if block.type === "mermaid"}
      <pre class="docsfn-code docsfn-mermaid"><code>{block.code}</code></pre>
    {:else if block.text}
      <p>{block.text}</p>
    {/if}
  {/each}
</article>

<style>
  .docsfn-content {
    display: grid;
    gap: 1rem;
    padding: 1.2rem;
  }

  .docsfn-content :global(h1),
  .docsfn-content :global(h2),
  .docsfn-content :global(h3) {
    letter-spacing: -0.04em;
    line-height: 1.02;
  }

  .docsfn-content :global(h1) {
    font-size: clamp(2rem, 5vw, 4.2rem);
  }

  .docsfn-content :global(h2) {
    font-size: clamp(1.4rem, 3vw, 2.3rem);
  }

  .docsfn-content :global(p),
  .docsfn-content :global(li) {
    color: rgba(23, 33, 25, 0.76);
    line-height: 1.65;
  }

  .docsfn-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    overflow: hidden;
    border-radius: 1rem;
  }

  .docsfn-content :global(th),
  .docsfn-content :global(td) {
    border-bottom: 1px solid rgba(23, 33, 25, 0.1);
    padding: 0.7rem;
    text-align: left;
  }

  .docsfn-code {
    overflow: auto;
    border-radius: 1rem;
    background: #172119;
    color: #fbf7ea;
    padding: 1rem;
  }
</style>
