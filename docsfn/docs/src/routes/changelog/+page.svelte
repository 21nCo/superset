<script lang="ts">
  import { ChangelogList } from "@docsfn/svelte";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const title = $derived(data.collection?.label ?? "Changelog");
</script>

<svelte:head>
  <title>{title} - {data.source.siteTitle}</title>
  <meta name="description" content="Product updates and release notes." />
</svelte:head>

<ChangelogList
  posts={data.posts}
  {title}
  embedded={data.embed}
/>
