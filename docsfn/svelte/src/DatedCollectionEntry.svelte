<script lang="ts">
  import type { BlogPost } from "@docsfn/core/browser";
  import Icon from "./Icon.svelte";

  export interface DatedCollectionEntryProps {
    post: BlogPost;
    collectionLabel?: string;
    collectionHref?: string;
    embedded?: boolean;
    showBackLink?: boolean;
  }

  export let post: BlogPost;
  export let collectionLabel = post.collectionLabel ?? "Updates";
  export let collectionHref: string | undefined = undefined;
  export let embedded = false;
  export let showBackLink = true;
</script>

<article
  class="docsfn-dated-entry docsfn-layout"
  class:docsfn-dated-entry--embedded={embedded}
>
  {#if !embedded && showBackLink && collectionHref}
    <a class="docsfn-dated-entry-back" href={collectionHref}>
      <Icon name="arrow-left" size={15} strokeWidth={1.8} />
      {collectionLabel}
    </a>
  {/if}

  <header class="docsfn-dated-entry-header">
    <p class="docsfn-dated-entry-date">
      <time datetime={post.date}>{post.date}</time>
    </p>
    <h1>{post.title}</h1>
    {#if post.tags?.length}
      <ul class="docsfn-dated-entry-tags">
        {#each post.tags as tag (tag)}
          <li>{tag}</li>
        {/each}
      </ul>
    {/if}
  </header>

  <div class="docsfn-dated-entry-body">
    <slot />
  </div>
</article>

<style>
  .docsfn-dated-entry {
    width: min(48rem, calc(100% - 2rem));
    margin-inline: auto;
    padding-block: 3.5rem 4rem;
  }

  .docsfn-dated-entry--embedded {
    padding-block: 0;
    max-width: none;
    width: 100%;
    background: transparent;
  }

  .docsfn-dated-entry-back {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--docsfn-color-primary, #2563eb);
    text-decoration: none;
  }

  .docsfn-dated-entry-back:hover {
    text-decoration: underline;
  }

  .docsfn-dated-entry-date {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-dated-entry-header h1 {
    margin: 0;
    font-size: 2.35rem;
    line-height: 1.18;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-entry--embedded .docsfn-dated-entry-header h1 {
    font-size: 1.5rem;
  }

  .docsfn-dated-entry-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
  }

  .docsfn-dated-entry-tags li {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--docsfn-color-border, #e2e8f0);
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-entry-body {
    margin-top: 1.75rem;
    padding-top: 1.75rem;
    border-top: 1px solid var(--docsfn-color-border, #e2e8f0);
  }

  @media (max-width: 640px) {
    .docsfn-dated-entry {
      width: min(100% - 1.5rem, 48rem);
      padding-block: 2.25rem 3rem;
    }

    .docsfn-dated-entry-header h1 {
      font-size: 1.9rem;
    }
  }
</style>
