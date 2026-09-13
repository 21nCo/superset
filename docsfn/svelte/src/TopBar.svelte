<script lang="ts">
  import type { ComponentType } from "svelte";
  import type { DocsTopNavItem } from "@docsfn/core/browser";
  import {
    Menu as DropdownMenu,
    MenuContent as DropdownMenuContent,
    MenuItem as DropdownMenuItem,
    MenuPositioner as DropdownMenuPositioner,
    MenuTrigger as DropdownMenuTrigger,
  } from "@uifn/svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";
  import Icon from "./Icon.svelte";

  export interface TopBarLink {
    label: string;
    href: string;
    external?: boolean;
  }

  export interface TopBarDropdown {
    label: string;
    items: TopBarLink[];
  }

  export type TopBarItem = TopBarLink | TopBarDropdown;

  export let surface: DocsPageSurface | undefined = undefined;
  export let brand: string | undefined = undefined;
  export let brandHref = "/";
  export let logo: ComponentType | undefined = undefined;
  export let items: Array<TopBarItem | DocsTopNavItem> | undefined = undefined;
  export let searchTrigger: ComponentType | undefined = undefined;
  export let versionSelector: ComponentType | undefined = undefined;
  export let mobileMenuTrigger: ComponentType | undefined = undefined;

  let mobileNavOpen = false;

  function mapTopNavItems(topNav: DocsTopNavItem[]): TopBarItem[] {
    return topNav.map((item) => {
      if (Array.isArray(item.children) && item.children.length > 0) {
        return {
          label: item.label,
          items: item.children.map((child) => ({
            label: child.label,
            href: child.href,
            external: child.external,
          })),
        };
      }

      return {
        label: item.label,
        href: item.href,
        external: item.external,
      };
    });
  }

  function isDropdown(item: TopBarItem): item is TopBarDropdown {
    return "items" in item;
  }

  function normalizeTopBarItems(
    input: Array<TopBarItem | DocsTopNavItem>
  ): TopBarItem[] {
    return input.map((item) => {
      if ("children" in item) {
        return mapTopNavItems([item])[0];
      }
      return item;
    });
  }

  $: resolvedItems = normalizeTopBarItems(items ?? surface?.topNav ?? []);
</script>

<header class="docsfn-topbar">
  <div class="docsfn-topbar-container">
    {#if logo || brand}
      <a class="docsfn-topbar-brand" href={brandHref} aria-label={brand ?? "Documentation home"}>
        {#if logo}
          <span class="docsfn-topbar-logo"><svelte:component this={logo} /></span>
        {:else}
          <span class="docsfn-topbar-brand-mark" aria-hidden="true">
            <Icon name="book-open" size={17} strokeWidth={2} />
          </span>
        {/if}
        {#if brand}
          <span class="docsfn-topbar-brand-name">{brand}</span>
        {/if}
      </a>
    {/if}

    <nav class="docsfn-topbar-nav" aria-label="Main navigation">
      {#each resolvedItems as item, index (`${item.label}:${index}`)}
        {#if isDropdown(item)}
          <DropdownMenu>
            <DropdownMenuTrigger class="docsfn-topbar-dropdown-trigger">
              {item.label}
              <Icon name="chevron-down" size={13} strokeWidth={1.8} />
            </DropdownMenuTrigger>
            <DropdownMenuPositioner>
              <DropdownMenuContent class="docsfn-topbar-dropdown-content">
                {#each item.items as subItem, subIndex (`${subItem.label}:${subIndex}`)}
                  <DropdownMenuItem value={`${subItem.label}:${subIndex}`}>
                    <a
                      href={subItem.href}
                      class="docsfn-topbar-dropdown-item"
                      target={subItem.external ? "_blank" : undefined}
                      rel={subItem.external ? "noreferrer noopener" : undefined}
                    >
                      {subItem.label}
                      {#if subItem.external}
                        <Icon name="external-link" size={13} strokeWidth={1.8} />
                      {/if}
                    </a>
                  </DropdownMenuItem>
                {/each}
              </DropdownMenuContent>
            </DropdownMenuPositioner>
          </DropdownMenu>
        {:else}
          <a
            href={item.href}
            class="docsfn-topbar-link"
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noreferrer noopener" : undefined}
          >
            {item.label}
            {#if item.external}
              <Icon name="external-link" size={13} strokeWidth={1.8} />
            {/if}
          </a>
        {/if}
      {/each}
    </nav>

    <div class="docsfn-topbar-actions">
      {#if searchTrigger}
        <svelte:component this={searchTrigger} />
      {/if}
      {#if versionSelector}
        <svelte:component this={versionSelector} />
      {/if}
      {#if mobileMenuTrigger}
        <svelte:component this={mobileMenuTrigger} />
      {:else if resolvedItems.length > 0}
        <button
          type="button"
          class="docsfn-topbar-mobile-trigger"
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileNavOpen}
          aria-controls="docsfn-topbar-mobile-nav"
          on:click={() => (mobileNavOpen = !mobileNavOpen)}
        >
          {#if mobileNavOpen}
            <Icon name="x" size={19} strokeWidth={1.8} />
          {:else}
            <Icon name="menu" size={19} strokeWidth={1.8} />
          {/if}
        </button>
      {/if}
    </div>
  </div>

  {#if mobileNavOpen}
    <nav id="docsfn-topbar-mobile-nav" class="docsfn-topbar-mobile-nav" aria-label="Mobile navigation">
      {#each resolvedItems as item, index (`mobile:${item.label}:${index}`)}
        {#if isDropdown(item)}
          <div class="docsfn-topbar-mobile-group">
            <span>{item.label}</span>
            {#each item.items as subItem (`mobile:${subItem.label}:${subItem.href}`)}
              <a
                href={subItem.href}
                target={subItem.external ? "_blank" : undefined}
                rel={subItem.external ? "noreferrer noopener" : undefined}
                on:click={() => (mobileNavOpen = false)}
              >
                {subItem.label}
                {#if subItem.external}
                  <Icon name="external-link" size={13} strokeWidth={1.8} />
                {/if}
              </a>
            {/each}
          </div>
        {:else}
          <a
            href={item.href}
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noreferrer noopener" : undefined}
            on:click={() => (mobileNavOpen = false)}
          >
            {item.label}
            {#if item.external}
              <Icon name="external-link" size={13} strokeWidth={1.8} />
            {/if}
          </a>
        {/if}
      {/each}
    </nav>
  {/if}
</header>
