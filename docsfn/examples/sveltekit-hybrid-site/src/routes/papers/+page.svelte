<script lang="ts">
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<section class="papers">
  <div class="eyebrow">Paper library</div>
  <h1>Long-form research and implementation papers</h1>
  <p class="lede">
    Each paper lives under <code>content/papers</code> and gets its own sidebar once you open it.
  </p>

  <div class="paper-grid">
    {#each data.papers as paper (paper.id)}
      <a class="paper-card" href={paper.path}>
        <strong>{paper.title}</strong>
        {#if paper.description}
          <span>{paper.description}</span>
        {/if}
      </a>
    {/each}
  </div>
</section>

<style>
  .papers {
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

  .lede {
    color: #475569;
  }

  .paper-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }

  .paper-card {
    display: grid;
    gap: 0.45rem;
    padding: 1rem;
    text-decoration: none;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.88);
    border: 1px solid rgba(15, 23, 42, 0.08);
  }

  .paper-card span {
    color: #475569;
  }
</style>
