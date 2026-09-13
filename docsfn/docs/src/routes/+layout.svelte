<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { navigating, page } from "$app/stores";
  import type { Sidebar } from "@docsfn/core/browser";
  import type { Snippet } from "svelte";
  import DocsSiteSearch from "$lib/components/DocsSiteSearch.svelte";
  import DocsLayout, { type DocsPageSurface } from "@site/docs-layout";
  import DocsSiteShell from "@site/docs-site-shell";
  import type { LayoutData } from "./$types";

  interface Props {
    data: LayoutData;
    children: Snippet;
  }

  let { data, children }: Props = $props();

  // DocsSearch uses a client-side dialog, so add it after hydration.
  let clientSearchReady = $state(false);

  const isDocsRoute = $derived(
    $page.url.pathname === "/docs" || $page.url.pathname.startsWith("/docs/")
  );
  const navigationPending = $derived($navigating !== null);
  const docsRouteData = $derived(
    $page.data as LayoutData & {
      surface?: DocsPageSurface;
      sidebar?: Sidebar;
    }
  );
  const preservedSearchParams = $derived(
    data.embed
      ? {
          embed: "1",
          ...(data.embedSidebar ? { showSidebar: "1" } : {}),
        }
      : {}
  );

  onMount(() => {
    clientSearchReady = true;
  });
</script>

<div
  class="docsfn-navigation-progress"
  class:docsfn-navigation-progress--active={navigationPending}
  class:docsfn-navigation-progress--embedded={data.embed}
  role={navigationPending ? "progressbar" : undefined}
  aria-label={navigationPending ? "Loading page" : undefined}
>
  <span></span>
</div>

{#snippet routeContent()}
  <div
    class="docsfn-route-view"
    aria-busy={navigationPending}
  >
    {@render children()}
  </div>
{/snippet}

{#key `${data.embed}:${data.embedSidebar}`}
<DocsSiteShell
  embedded={data.embed}
  brand={data.source.siteTitle}
  brandHref="/"
  items={data.source.config.navigation?.topNav ?? []}
  searchTrigger={clientSearchReady ? DocsSiteSearch : undefined}
  showFooter={data.source.config.site.showFooter !== false}
  footerNote="Built at 21n.co"
  footerLinks={[{ label: "21n.co", href: "https://21n.co", external: true }]}
>
  {#if isDocsRoute && docsRouteData.surface}
    <DocsLayout
      surface={docsRouteData.surface}
      sidebar={docsRouteData.sidebar}
      embedded={data.embed}
      showSidebar={data.embed ? data.embedSidebar : undefined}
      {preservedSearchParams}
    >
      {@render routeContent()}
    </DocsLayout>
  {:else}
    {@render routeContent()}
  {/if}
</DocsSiteShell>
{/key}
