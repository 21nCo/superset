<script lang="ts">
  import MarkdownPage from "../../../lib/components/MarkdownPage.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<MarkdownPage
  title={data.page.title}
  description={data.page.description}
  path={data.page.path}
  content={data.page.body}
  sourcePath={data.page.id}
  compatPreset={data.compatPreset}
/>
