<script lang="ts">
  import EmbeddedPage from "@docsfn/svelte/EmbeddedPage.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<div data-docsfn-proof-surface="embedded">
  <EmbeddedPage
    title={data.page.title}
    description={data.page.description}
    content={data.page.body}
    headings={data.page.headings}
    compatPreset={data.compatPreset}
  />
</div>
