<script lang="ts">
  import type { BlogPost } from "@docsfn/core/browser";
  import DatedCollectionList from "./DatedCollectionList.svelte";

  export let posts: BlogPost[] = [];
  export let title = "Changelog";
  export let description: string | undefined = "Product updates and release notes.";
  export let embedded = false;
  export let emptyLabel = "No changelog entries yet.";
  export let getPostHref: ((post: BlogPost) => string) | undefined = undefined;
</script>

<DatedCollectionList
  {posts}
  {title}
  {description}
  {embedded}
  {emptyLabel}
  ariaLabel={title}
  {getPostHref}
/>
