<script lang="ts">
  import DocsContent from "@site/docs-content";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head>
  <title>{data.post.title} — {data.siteTitle}</title>
  {#if data.post.summary ?? data.post.excerpt}
    <meta name="description" content={data.post.summary ?? data.post.excerpt ?? ""} />
  {/if}
</svelte:head>

<article class="blog-post docsfn-layout">
  <header class="blog-post-header">
    <h1>{data.post.title}</h1>
    <div class="blog-post-meta">
      <time datetime={data.post.date}>{data.post.date}</time>
      {#if data.post.author}
        <span class="blog-post-author">{data.post.author}</span>
      {/if}
    </div>
    {#if data.post.tags?.length}
      <ul class="blog-post-tags">
        {#each data.post.tags as tag (tag)}
          <li>{tag}</li>
        {/each}
      </ul>
    {/if}
  </header>

  <div class="blog-post-body">
    <DocsContent compiled={data.compiled} />
  </div>
</article>

<style>
  .blog-post {
    padding-block: 2rem 3rem;
    max-width: 48rem;
  }

  .blog-post-header h1 {
    margin: 0 0 0.75rem;
    font-size: 2rem;
    color: var(--docsfn-color-fg, #0f172a);
  }

  .blog-post-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.9rem;
    color: var(--docsfn-color-muted, #64748b);
  }

  .blog-post-author::before {
    content: "·";
    margin-right: 0.75rem;
  }

  .blog-post-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
  }

  .blog-post-tags li {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--docsfn-color-border, #e2e8f0);
    color: var(--docsfn-color-fg, #0f172a);
  }

  .blog-post-body {
    margin-top: 2rem;
  }
</style>
