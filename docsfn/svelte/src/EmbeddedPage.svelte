<script lang="ts">
  import type { CompiledContentArtifact, DocHeading, DocsCompatPreset } from "@docsfn/core/browser";
  import type { ComponentType } from "svelte";
  import DocsContent from "./DocsContent.svelte";

  export let title = "";
  export let description: string | undefined = undefined;
  export let content = "";
  export let headings: DocHeading[] = [];
  export let compiled: CompiledContentArtifact | undefined = undefined;
  export let compatPreset: DocsCompatPreset = "none";
  export let components: Record<string, ComponentType | undefined> = {};
  export let showToc = true;
  export let tocLabel = "On this page";
</script>

<article class="docsfn-embedded-page" data-docsfn-embedded-page="true">
  <header class="docsfn-embedded-page-header">
    <h1>{title}</h1>
    {#if description}
      <p>{description}</p>
    {/if}
  </header>

  {#if showToc && headings.length > 0}
    <nav aria-label={tocLabel} class="docsfn-embedded-page-toc">
      <h2>{tocLabel}</h2>
      <ol>
        {#each headings as heading (heading.slug)}
          <li>
            <a href={`#${heading.slug}`}>{heading.text}</a>
          </li>
        {/each}
      </ol>
    </nav>
  {/if}

  <DocsContent {compiled} {content} {compatPreset} {components}>
    <slot name="page-actions" slot="page-actions" />
  </DocsContent>
</article>
