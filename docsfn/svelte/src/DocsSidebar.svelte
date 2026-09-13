<script lang="ts">
  import type { Sidebar } from "@docsfn/core/browser";
  import SidebarGroup from "./SidebarGroup.svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export let surface: DocsPageSurface | undefined = undefined;
  export let sidebar: Sidebar | undefined = undefined;
  export let activePath: string | undefined = undefined;
  export let preservedSearchParams: Record<string, string> = {};

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
  $: resolvedActivePath = activePath ?? surface?.route;
</script>

{#if resolvedSidebar}
  <div class="docsfn-sidebar">
    <div class="docsfn-sidebar-viewport">
      <nav class="docsfn-sidebar-nav" aria-label="Documentation navigation">
        {#each resolvedSidebar.items as item, i (`${item.type}:${i}`)}
          <SidebarGroup
            {item}
            activePath={resolvedActivePath}
            {preservedSearchParams}
          />
        {/each}
      </nav>
    </div>
  </div>
{/if}
