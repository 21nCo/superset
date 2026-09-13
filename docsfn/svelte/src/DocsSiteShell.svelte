<script lang="ts">
  import { onMount, type ComponentType } from "svelte";
  import type { DocsTopNavItem } from "@docsfn/core/browser";
  import DocsFooter, { type DocsFooterLink } from "./DocsFooter.svelte";
  import TopBar, { type TopBarItem } from "./TopBar.svelte";

  export let embedded = false;
  export let brand = "Documentation";
  export let brandHref = "/";
  export let logo: ComponentType | undefined = undefined;
  export let items: Array<TopBarItem | DocsTopNavItem> = [];
  export let searchTrigger: ComponentType | undefined = undefined;
  export let versionSelector: ComponentType | undefined = undefined;
  export let showFooter = true;
  export let footerNote = "Built with docsfn";
  export let footerLinks: DocsFooterLink[] = [];
  export let preserveEmbedRoutes = ["/docs", "/blog", "/changelog"];
  export let preserveEmbedParams = ["showSidebar", "showsidebar", "sidebar"];

  function shouldPreserveEmbedMode(url: URL): boolean {
    return (
      url.origin === window.location.origin &&
      preserveEmbedRoutes.some(
        (route) => url.pathname === route || url.pathname.startsWith(`${route}/`)
      )
    );
  }

  onMount(() => {
    if (!embedded) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!(event.target instanceof Element)) {
        return;
      }

      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) {
        return;
      }

      const rawHref = anchor.getAttribute("href");
      if (!rawHref || rawHref.startsWith("#")) {
        return;
      }

      const currentUrl = new URL(window.location.href);
      const nextUrl = new URL(anchor.href, window.location.href);
      if (!shouldPreserveEmbedMode(nextUrl)) {
        return;
      }

      nextUrl.searchParams.set("embed", "1");
      for (const param of preserveEmbedParams) {
        const value = currentUrl.searchParams.get(param);
        if (value !== null && !nextUrl.searchParams.has(param)) {
          nextUrl.searchParams.set(param, value);
        }
      }
      anchor.href = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  });
</script>

<div class="docsfn-site-shell" class:docsfn-site-shell--embedded={embedded}>
  {#if !embedded}
    <TopBar
      {brand}
      {brandHref}
      {logo}
      {items}
      {searchTrigger}
      {versionSelector}
    />
  {/if}

  <div class="docsfn-site-shell-main">
    <slot />
  </div>

  {#if !embedded && showFooter}
    <DocsFooter note={footerNote} links={footerLinks} />
  {/if}
</div>
