<script lang="ts">
  import "@docsfn/svelte/theme.css";
  import type { LayoutData } from "./$types";

  export let data: LayoutData;
</script>

<svelte:head>
  <title>{data.source.siteTitle}</title>
  <meta name="description" content="docsfn hybrid example app" />
</svelte:head>

<div class="shell">
  <header class="site-header">
    <a class="brand" href="/">
      <span>Northstar Cloud</span>
      <small>docsfn hybrid example</small>
    </a>

    <nav aria-label="Primary">
      <ul class="top-nav">
        {#each data.source.docs.manifest.topNav ?? [] as item (`${item.label}:${item.href}`)}
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        {/each}
      </ul>
    </nav>
  </header>

  <main class="page-shell">
    <slot />
  </main>
</div>

<style>
  :global(html) {
    --docsfn-docs-shell-max-width: 1120px;
    --docsfn-main-column-max-width: 760px;
    --docsfn-sticky-top-offset: 76px;
    --docsfn-sidebar-width: 17rem;
    --docsfn-toc-width: 15rem;
    --docsfn-main-padding-inline: 2.25rem;
    --docsfn-main-padding-block: 1.75rem;

    --docsfn-color-bg: #f7fbfc;
    --docsfn-color-surface: #ffffff;
    --docsfn-color-surface-raised: #f5f9fb;
    --docsfn-color-fg: #14213d;
    --docsfn-color-muted: #6b7a90;
    --docsfn-color-border: rgba(20, 33, 61, 0.12);
    --docsfn-color-primary: #0f766e;
    --docsfn-color-primary-hover: #115e59;
    --docsfn-color-primary-fg: #ffffff;
    --docsfn-color-accent-soft: rgba(15, 118, 110, 0.12);
    --docsfn-color-code-bg: #0f172a;
    --docsfn-color-code-fg: #e2e8f0;
    --docsfn-color-code-border: rgba(15, 23, 42, 0.18);
    --docsfn-sidebar-panel-bg: rgba(255, 255, 255, 0.84);
    --docsfn-font-sans: "Avenir Next", Avenir, "Segoe UI", sans-serif;
    --docsfn-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;

    background:
      radial-gradient(circle at top left, rgba(20, 184, 166, 0.15), transparent 30%),
      linear-gradient(180deg, #f8fafc 0%, #ecfeff 100%);
    color: #0f172a;
    font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
  }

  :global(body) {
    margin: 0;
  }

  :global(.docsfn-sidebar-col) {
    backdrop-filter: blur(10px);
  }

  :global(.docsfn-content h1) {
    font-size: clamp(2.2rem, 4vw, 3.4rem);
  }

  .shell {
    min-height: 100dvh;
  }

  .site-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 1.1rem 1.5rem;
    border-bottom: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(255, 255, 255, 0.75);
    backdrop-filter: blur(14px);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .brand {
    display: grid;
    text-decoration: none;
    font-weight: 700;
  }

  .brand small {
    font-size: 0.78rem;
    font-weight: 500;
    color: #475569;
  }

  .top-nav {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    margin: 0;
    padding: 0;
  }

  .top-nav a {
    text-decoration: none;
    color: #0f172a;
  }

  .page-shell {
    width: min(100%, calc(100vw - 2rem));
    margin: 0 auto;
  }

  @media (max-width: 720px) {
    .site-header {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
