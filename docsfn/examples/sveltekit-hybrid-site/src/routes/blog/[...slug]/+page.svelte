<script lang="ts">
  import DocsContent from "@docsfn/svelte/DocsContent.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<article class="post">
  <div class="eyebrow">Blog post</div>
  <h1>{data.post.title}</h1>
  <p class="meta">{new Date(data.post.publishedAt ?? data.post.date).toUTCString()}</p>
  {#if data.post.summary || data.post.excerpt}
    <p class="lede">{data.post.summary ?? data.post.excerpt}</p>
  {/if}

  <DocsContent
    content={data.post.body}
    sourcePath={data.post.id}
    compatPreset={data.compatPreset}
  />
</article>

<style>
  .post {
    display: grid;
    gap: 1rem;
    padding: 2rem 0 3rem;
  }

  .eyebrow {
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .meta,
  .lede {
    color: #475569;
  }
</style>
