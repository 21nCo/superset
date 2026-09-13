<script lang="ts">
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<section class="blog-list">
  <div class="eyebrow">Blog collection</div>
  <h1>Product updates and field notes</h1>

  <div class="posts">
    {#each data.posts as post (post.id)}
      <a class="post" href={`/blog/${post.slug}`}>
        <strong>{post.title}</strong>
        <span>{post.summary ?? post.excerpt ?? "No summary provided."}</span>
      </a>
    {/each}
  </div>
</section>

<style>
  .blog-list {
    padding: 2rem 0 3rem;
    display: grid;
    gap: 1rem;
  }

  .eyebrow {
    font-size: 0.8rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #0f766e;
  }

  .posts {
    display: grid;
    gap: 1rem;
  }

  .post {
    display: grid;
    gap: 0.4rem;
    padding: 1rem;
    text-decoration: none;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(15, 23, 42, 0.08);
  }

  .post span {
    color: #475569;
  }
</style>
