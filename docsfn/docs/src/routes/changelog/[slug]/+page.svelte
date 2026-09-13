<script lang="ts">
  import { ChangelogEntry } from "@docsfn/svelte";
  import DocsContent from "@site/docs-content";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const collectionLabel = $derived(data.collection?.label ?? "Changelog");
</script>

<svelte:head>
  <title>{data.post.title} - {data.siteTitle}</title>
  {#if data.post.excerpt ?? data.post.summary}
    <meta name="description" content={data.post.excerpt ?? data.post.summary ?? ""} />
  {/if}
</svelte:head>

<ChangelogEntry
  post={data.post}
  {collectionLabel}
  embedded={data.embed}
>
  <DocsContent compiled={data.compiled} />
</ChangelogEntry>
