<section class="hero">
  <div class="hero-copy">
    <div class="eyebrow">SvelteKit + docsfn</div>
    <h1>One app, multiple content surfaces.</h1>
    <p>
      This example shows a realistic consumer setup: a custom landing page, docs sections with
      different sidebars, blog routes, standalone markdown pages, and a dedicated OpenAPI route.
    </p>

    <div class="actions">
      <a href="/docs" class="primary">Open docs</a>
      <a href="/papers" class="secondary">Browse papers</a>
    </div>
  </div>

  <div class="route-grid">
    <a href="/docs" class="card">
      <strong>Docs home</strong>
      <span>/docs</span>
    </a>
    <a href="/docs/product" class="card">
      <strong>Nested docs tree</strong>
      <span>/docs with nested folders in one sidebar</span>
    </a>
    <a href="/papers" class="card">
      <strong>Papers landing</strong>
      <span>/papers lists all papers</span>
    </a>
    <a href="/papers/edge-computing" class="card">
      <strong>Per-paper sidebar</strong>
      <span>/papers/&lt;paper&gt; gets its own sidebar</span>
    </a>
    <a href="/docs/api/commerce" class="card">
      <strong>Generated API reference</strong>
      <span>/docs/api/*</span>
    </a>
    <a href="/blog" class="card">
      <strong>Blog</strong>
      <span>/blog/*</span>
    </a>
    <a href="/help/faq" class="card">
      <strong>Standalone markdown pages</strong>
      <span>/help/* and /legal/*</span>
    </a>
  </div>
</section>

<style>
  .hero {
    padding: 4rem 0 3rem;
    display: grid;
    gap: 2rem;
  }

  .hero-copy {
    display: grid;
    gap: 1rem;
    max-width: 760px;
  }

  .eyebrow {
    font-size: 0.82rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #0f766e;
  }

  h1 {
    font-size: clamp(2.6rem, 6vw, 4.8rem);
    line-height: 0.95;
    margin: 0;
  }

  p {
    margin: 0;
    font-size: 1.08rem;
    color: #334155;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
  }

  .actions a {
    border-radius: 999px;
    padding: 0.8rem 1.2rem;
    text-decoration: none;
    font-weight: 700;
  }

  .primary {
    background: #0f766e;
    color: white;
  }

  .secondary {
    border: 1px solid rgba(15, 23, 42, 0.14);
    background: rgba(255, 255, 255, 0.8);
  }

  .route-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }

  .card {
    display: grid;
    gap: 0.35rem;
    padding: 1rem;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.88);
    border: 1px solid rgba(15, 23, 42, 0.08);
    text-decoration: none;
    box-shadow: 0 16px 40px rgba(15, 23, 42, 0.06);
  }

  .card span {
    color: #475569;
  }
</style>
