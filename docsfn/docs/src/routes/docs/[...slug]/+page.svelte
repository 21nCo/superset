<script lang="ts">
  import DocsContent from "@site/docs-content";
  import ApiReferenceRenderer from "@site/api-reference-renderer";
  import Breadcrumbs from "@site/breadcrumbs";
  import Pagination from "@site/pagination";
  import PageActions from "@site/page-actions";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>{data.surface.title ?? data.siteTitle}</title>
  {#if data.surface.description}
    <meta name="description" content={data.surface.description} />
  {/if}
</svelte:head>

{#if !data.embed}
  <Breadcrumbs surface={data.surface} />
{/if}
{#if data.routeEntry.kind === "page" && data.compiled}
  <article class="docs-page-article">
    <DocsContent compiled={data.compiled}>
      <PageActions slot="page-actions" editLink={data.surface.editLink} />
    </DocsContent>
  </article>
{:else}
  <article class="docs-page-article">
    <ApiReferenceRenderer api={data.routeEntry.api} />
    <PageActions editLink={data.surface.editLink} />
  </article>
{/if}
{#if !data.embed}
  <Pagination surface={data.surface} />
{/if}

<style>
  .docs-page-article {
    margin-top: 0.5rem;
  }

  :global(.docsfn-layout--embedded) .docs-page-article {
    margin-top: 0;
  }
</style>
