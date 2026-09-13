<script lang="ts">
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const tagline = "The documentation toolchain for superfunctions";
  const configDescription = $derived(data.source.config.site.description ?? "");
  const extraBlurb = $derived(
    configDescription && configDescription !== tagline ? configDescription : ""
  );

  const capabilities = [
    {
      title: "Multi-framework",
      text: "SvelteKit and Next.js adapters use the same manifest, routes, and search artifact.",
    },
    {
      title: "Native content",
      text: "Markdown, MDX, navigation metadata, OpenAPI pages, blog, and changelog content.",
    },
    {
      title: "Search built in",
      text: "Fast search across documentation, API references, blog posts, and changelog entries.",
    },
    {
      title: "Production tooling",
      text: "Validate content and generate manifests, diagnostics, and indexes in CI.",
    },
  ];

  const quickLinks = [
    { label: "Getting started", href: "/docs/getting-started", blurb: "Install docsfn and publish your first page." },
    { label: "Core concepts", href: "/docs/core-concepts", blurb: "Understand content, navigation, search, and configuration." },
    { label: "API reference", href: "/docs/api", blurb: "Browse the APIs exposed by each docsfn package." },
    { label: "Changelog", href: "/changelog", blurb: "See product updates and release notes." },
  ];
</script>

<svelte:head>
  <title>{data.source.siteTitle}</title>
  <meta name="description" content={data.source.config.site.description ?? tagline} />
</svelte:head>

<div class="docs-home">
  <section class="docs-home-hero" aria-labelledby="docs-home-title">
    <p class="docs-home-eyebrow">Superfunctions documentation</p>
    <h1 id="docs-home-title">docsfn</h1>
    <p class="docs-home-tagline">{tagline}</p>
    {#if extraBlurb}
      <p class="docs-home-description">{extraBlurb}</p>
    {/if}
    <div class="docs-home-actions">
      <a class="docs-home-primary" href="/docs/getting-started">Get started</a>
      <a
        class="docs-home-secondary"
        href="https://github.com/21nCo/super-functions/tree/dev/docsfn"
        target="_blank"
        rel="noreferrer noopener"
      >
        View on GitHub
      </a>
    </div>
    <div class="docs-home-command" aria-label="Install docsfn">
      <span aria-hidden="true">$</span>
      <code>npm install @docsfn/core</code>
    </div>
  </section>

  <section class="docs-home-explore" aria-labelledby="docs-home-explore-title">
    <div class="docs-home-section-heading">
      <p>Explore docsfn</p>
      <h2 id="docs-home-explore-title">Start with what you need</h2>
    </div>
    <div class="docs-home-links">
      {#each quickLinks as link (link.href)}
        <a href={link.href}>
          <span>{link.label}</span>
          <p>{link.blurb}</p>
          <span class="docs-home-link-arrow" aria-hidden="true">→</span>
        </a>
      {/each}
    </div>
  </section>

  <section class="docs-home-capabilities" aria-label="Capabilities">
    {#each capabilities as capability (capability.title)}
      <article>
        <h2>{capability.title}</h2>
        <p>{capability.text}</p>
      </article>
    {/each}
  </section>
</div>

<style>
  .docs-home {
    width: 100%;
    color: var(--docsfn-color-fg);
  }

  .docs-home-hero,
  .docs-home-explore,
  .docs-home-capabilities {
    width: min(72rem, calc(100% - 3rem));
    margin-inline: auto;
  }

  .docs-home-hero {
    min-height: 27rem;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    padding-block: 3.5rem;
  }

  .docs-home-eyebrow,
  .docs-home-section-heading > p {
    margin: 0 0 0.65rem;
    color: var(--docsfn-color-primary);
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .docs-home-hero h1 {
    margin: 0;
    font-size: 3.6rem;
    line-height: 1;
    letter-spacing: 0;
  }

  .docs-home-tagline {
    max-width: 40rem;
    margin: 1.1rem 0 0;
    font-size: 1.35rem;
    font-weight: 550;
    line-height: 1.45;
  }

  .docs-home-description {
    max-width: 39rem;
    margin: 0.7rem 0 0;
    color: var(--docsfn-color-muted);
    line-height: 1.65;
  }

  .docs-home-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-top: 1.5rem;
  }

  .docs-home-actions a {
    min-height: 2.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.9rem;
    border: 1px solid var(--docsfn-color-border);
    border-radius: 0.375rem;
    font-size: 0.86rem;
    font-weight: 650;
    text-decoration: none;
  }

  .docs-home-primary {
    border-color: var(--docsfn-color-primary) !important;
    background: var(--docsfn-color-primary);
    color: #fff;
  }

  .docs-home-secondary {
    background: var(--docsfn-color-surface);
    color: var(--docsfn-color-fg);
  }

  .docs-home-command {
    min-height: 2.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    margin-top: 1.2rem;
    padding: 0 0.8rem;
    border: 1px solid var(--docsfn-color-border);
    border-radius: 0.375rem;
    background: var(--docsfn-color-surface-raised);
    color: var(--docsfn-color-muted);
    font-size: 0.8rem;
  }

  .docs-home-command code {
    color: var(--docsfn-color-fg);
    font-family: var(--docsfn-font-mono);
  }

  .docs-home-explore {
    padding-block: 3.5rem;
    border-top: 1px solid var(--docsfn-color-border);
  }

  .docs-home-section-heading h2 {
    margin: 0;
    font-size: 1.75rem;
    letter-spacing: 0;
  }

  .docs-home-links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1.5rem;
  }

  .docs-home-links > a {
    position: relative;
    min-height: 8.5rem;
    display: block;
    padding: 1.15rem 3rem 1.15rem 1.15rem;
    border: 1px solid var(--docsfn-color-border);
    border-radius: 0.5rem;
    background: var(--docsfn-color-surface);
    color: inherit;
    text-decoration: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .docs-home-links > a:hover {
    border-color: var(--docsfn-color-primary);
    box-shadow: 0 8px 24px rgb(15 23 42 / 0.08);
  }

  .docs-home-links > a > span:first-child {
    font-size: 0.96rem;
    font-weight: 700;
  }

  .docs-home-links p {
    max-width: 26rem;
    margin: 0.55rem 0 0;
    color: var(--docsfn-color-muted);
    font-size: 0.85rem;
    line-height: 1.55;
  }

  .docs-home-link-arrow {
    position: absolute;
    top: 1.1rem;
    right: 1.15rem;
    color: var(--docsfn-color-primary);
    font-size: 1.1rem;
  }

  .docs-home-capabilities {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding-block: 2.5rem 4rem;
    border-top: 1px solid var(--docsfn-color-border);
  }

  .docs-home-capabilities article {
    padding: 0.25rem 1.25rem;
    border-left: 1px solid var(--docsfn-color-border);
  }

  .docs-home-capabilities article:first-child {
    padding-left: 0;
    border-left: 0;
  }

  .docs-home-capabilities h2 {
    margin: 0;
    font-size: 0.9rem;
    letter-spacing: 0;
  }

  .docs-home-capabilities p {
    margin: 0.55rem 0 0;
    color: var(--docsfn-color-muted);
    font-size: 0.8rem;
    line-height: 1.55;
  }

  @media (max-width: 760px) {
    .docs-home-hero,
    .docs-home-explore,
    .docs-home-capabilities {
      width: min(100% - 1.5rem, 72rem);
    }

    .docs-home-hero {
      min-height: 24rem;
      padding-block: 2.5rem;
    }

    .docs-home-hero h1 {
      font-size: 2.75rem;
    }

    .docs-home-tagline {
      font-size: 1.1rem;
    }

    .docs-home-links,
    .docs-home-capabilities {
      grid-template-columns: 1fr;
    }

    .docs-home-capabilities article,
    .docs-home-capabilities article:first-child {
      padding: 1rem 0;
      border-left: 0;
      border-top: 1px solid var(--docsfn-color-border);
    }

    .docs-home-capabilities article:first-child {
      border-top: 0;
    }
  }
</style>
