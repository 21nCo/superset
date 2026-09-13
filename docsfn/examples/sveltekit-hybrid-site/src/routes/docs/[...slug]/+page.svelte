<script lang="ts">
  import Breadcrumbs from "@docsfn/svelte/Breadcrumbs.svelte";
  import DocsLayout from "@docsfn/svelte/DocsLayout.svelte";
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import Pagination from "@docsfn/svelte/Pagination.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<DocsLayout surface={data.surface} sidebar={data.sidebar} activePath={data.page.path}>
  <article class="docs-page">
    <Breadcrumbs surface={data.surface} />

    <DocsContent
      content={data.page.body}
      sourcePath={data.page.id}
      compatPreset={data.compatPreset}
    />

    <Pagination surface={data.surface} />
  </article>
</DocsLayout>

<style>
  .docs-page {
    display: grid;
    gap: 0.75rem;
    padding: 2rem 0 3rem;
    min-width: 0;
  }
</style>
