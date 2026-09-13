<script lang="ts">
  import DatedCollectionList from "@site/dated-collection-list";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>Blog — {data.source.siteTitle}</title>
</svelte:head>

<DatedCollectionList
  posts={data.posts}
  title="Blog"
  description="Release notes and announcements."
  emptyLabel="No posts yet."
  getPostHref={(post) => `/blog/${post.slug}`}
/>
