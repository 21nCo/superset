<script lang="ts">
  import type { BlogPost } from "@docsfn/core/browser";

  export interface DatedCollectionListProps {
    posts: BlogPost[];
    title?: string;
    description?: string;
    embedded?: boolean;
    emptyLabel?: string;
    ariaLabel?: string;
    getPostHref?: (post: BlogPost) => string;
  }

  export let posts: BlogPost[] = [];
  export let title = "Updates";
  export let description: string | undefined = undefined;
  export let embedded = false;
  export let emptyLabel = "No entries yet.";
  export let ariaLabel: string | undefined = undefined;
  export let getPostHref: ((post: BlogPost) => string) | undefined = undefined;

  $: resolvedAriaLabel = ariaLabel ?? title;
  $: showDescription = Boolean(description) && !embedded;
</script>

<section
  class="docsfn-dated-list docsfn-layout"
  class:docsfn-dated-list--embedded={embedded}
  aria-label={resolvedAriaLabel}
>
  <header class="docsfn-dated-list-header">
    <h1>{title}</h1>
    {#if showDescription}
      <p>{description}</p>
    {/if}
  </header>

  {#if posts.length === 0}
    <p class="docsfn-dated-list-empty">{emptyLabel}</p>
  {:else}
    <ol class="docsfn-dated-list-items">
      {#each posts as post (post.id)}
        {@const href = getPostHref ? getPostHref(post) : post.path}
        <li>
          <a class="docsfn-dated-list-card" href={href}>
            <span class="docsfn-dated-list-date">
              <time datetime={post.date}>{post.date}</time>
            </span>
            <span class="docsfn-dated-list-title">{post.title}</span>
            {#if post.excerpt ?? post.summary}
              <p class="docsfn-dated-list-excerpt">{post.excerpt ?? post.summary}</p>
            {/if}
          </a>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .docsfn-dated-list {
    width: min(54rem, calc(100% - 2rem));
    margin-inline: auto;
    padding-block: 3.5rem 4rem;
  }

  .docsfn-dated-list--embedded {
    padding-block: 0;
    width: 100%;
    background: transparent;
  }

  .docsfn-dated-list-header h1 {
    margin: 0 0 0.5rem;
    font-size: 2.35rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-list--embedded .docsfn-dated-list-header h1 {
    font-size: 1.25rem;
  }

  .docsfn-dated-list-header p,
  .docsfn-dated-list-empty {
    margin: 0;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-dated-list-header {
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
  }

  .docsfn-dated-list-empty {
    margin-top: 2rem;
  }

  .docsfn-dated-list-items {
    list-style: none;
    margin: 2rem 0 0;
    padding: 0;
    display: grid;
    gap: 0;
  }

  .docsfn-dated-list--embedded .docsfn-dated-list-items {
    margin-top: 1rem;
  }

  .docsfn-dated-list-card {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: 0.4rem 1.5rem;
    padding: 1.35rem 0;
    border-radius: 0;
    border: 0;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
    text-decoration: none;
    color: inherit;
    background: transparent;
    transition: color 0.15s ease;
  }

  .docsfn-dated-list-card:hover {
    color: var(--docsfn-color-primary, #2563eb);
  }

  .docsfn-dated-list-date {
    grid-column: 1;
    grid-row: 1 / span 2;
    font-size: 0.8rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-dated-list-title {
    grid-column: 2;
    font-weight: 600;
    font-size: 1.05rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-dated-list-excerpt {
    grid-column: 2;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--docsfn-color-muted, #64748b);
  }

  @media (max-width: 640px) {
    .docsfn-dated-list {
      width: min(100% - 1.5rem, 54rem);
      padding-block: 2.25rem 3rem;
    }

    .docsfn-dated-list-card {
      grid-template-columns: 1fr;
      gap: 0.35rem;
    }

    .docsfn-dated-list-date,
    .docsfn-dated-list-title,
    .docsfn-dated-list-excerpt {
      grid-column: 1;
      grid-row: auto;
    }
  }
</style>
