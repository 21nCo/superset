<script lang="ts">
  import type { BlogPost } from "@docsfn/core/browser";
  import DatedCollectionEntry from "./DatedCollectionEntry.svelte";

  export let post: BlogPost;
  export let collectionLabel = "Changelog";
  export let collectionHref = "/changelog";
  export let embedded = false;
  export let showBackLink = true;
</script>

<DatedCollectionEntry
  {post}
  {collectionLabel}
  {collectionHref}
  {embedded}
  {showBackLink}
>
  <slot />
</DatedCollectionEntry>
