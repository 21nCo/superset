<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { DocHeading } from "@docsfn/core/browser";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export let surface: DocsPageSurface | undefined = undefined;
  export let headings: DocHeading[] | undefined = undefined;
  export let activeHash: string | undefined = undefined;

  let currentHash = activeHash || "";

  $: resolvedHeadings = headings ?? surface?.headings ?? [];

  let mounted = false;
  let observer: IntersectionObserver | undefined;
  let generation = 0;
  $: if (mounted) void observeHeadings(resolvedHeadings, activeHash);

  async function observeHeadings(items: DocHeading[], controlled: string | undefined) {
    const request = ++generation;
    observer?.disconnect();
    currentHash = controlled ?? "";
    if (controlled !== undefined) return;
    await tick();
    if (!mounted || request !== generation || typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.isIntersecting);
      if (entry?.target.id) currentHash = `#${entry.target.id}`;
    }, { rootMargin: "-80px 0px -80% 0px", threshold: 0 });
    for (const heading of items) {
      const element = document.getElementById(heading.slug);
      if (element) observer.observe(element);
    }
  }
  onMount(() => {
    mounted = true;
    return () => { mounted = false; generation += 1; observer?.disconnect(); };
  });

  function handleClick(e: MouseEvent, slug: string) {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    e.preventDefault();
    const element = document.getElementById(slug);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      currentHash = `#${slug}`;
      // Update URL without triggering navigation
      window.history.replaceState(null, "", `#${slug}`);
    }
  }
</script>

{#if resolvedHeadings.length > 0}
  <div class="docsfn-toc">
    <div class="docsfn-toc-viewport">
      <nav class="docsfn-toc-nav" aria-label="Table of contents">
        <div class="docsfn-toc-title">On this page</div>
        <ul class="docsfn-toc-list">
          {#each resolvedHeadings as h, i (h.slug)}
            {@const isActive = currentHash === `#${h.slug}` || (!currentHash && i === 0)}
            <li
              class="docsfn-toc-item"
              data-level={h.level}
              style="padding-left: {(h.level - 1) * 12}px"
            >
              <a
                href="#{h.slug}"
                on:click={(e) => handleClick(e, h.slug)}
                class="docsfn-toc-link {isActive ? 'active' : ''}"
                data-active={isActive}
                aria-current={isActive ? "location" : undefined}
              >
                {h.text}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    </div>
  </div>
{/if}
