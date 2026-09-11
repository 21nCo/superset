<script lang="ts">
  import type { Version } from "@docsfn/core/browser";
  import {
    Menu as DropdownMenu,
    MenuContent as DropdownMenuContent,
    MenuItem as DropdownMenuItem,
    MenuPositioner as DropdownMenuPositioner,
    MenuTrigger as DropdownMenuTrigger,
  } from "@uifn/svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export interface VersionSwitcherProps {
    basePath?: string;
    versionMode?: "path-prefix" | "path-segment";
    surface?: DocsPageSurface;
    versions?: Version[];
    currentVersion?: string;
    onVersionChange?: (versionSlug: string) => void;
  }

  export let basePath = "/docs";
  export let versionMode: "path-prefix" | "path-segment" = "path-prefix";
  export let surface: DocsPageSurface | undefined = undefined;
  export let versions: Version[] | undefined = undefined;
  export let currentVersion: string | undefined = undefined;
  export let onVersionChange: ((versionSlug: string) => void) | undefined = undefined;

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  $: resolvedVersions = versions ?? surface?.versions ?? [];
  $: resolvedCurrentVersion =
    currentVersion ??
    surface?.currentVersion ??
    resolvedVersions.find((version) => version.isDefault)?.slug ??
    resolvedVersions[0]?.slug;
  $: current = resolvedVersions.find((version) => version.slug === resolvedCurrentVersion);

  function handleChange(versionSlug: string) {
    if (onVersionChange) {
      onVersionChange(versionSlug);
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const explicitLink = surface?.versionLinks?.[versionSlug];
    if (explicitLink) {
      window.location.href = explicitLink;
      return;
    }

    const pattern = resolvedVersions.map((version) => escapeRegExp(version.slug)).join("|");
    if (!pattern) {
      return;
    }

    const nextPath = window.location.pathname.replace(
      versionMode === "path-segment"
        ? new RegExp(`/(${pattern})$`)
        : new RegExp(`^${escapeRegExp(basePath.replace(/\/+$/, ""))}/(${pattern})(?=/|$)`),
      versionMode === "path-segment"
        ? `/${versionSlug}`
        : `${basePath.replace(/\/+$/, "")}/${versionSlug}`
    );
    if (nextPath !== window.location.pathname) {
      window.location.href = `${nextPath}${window.location.search}${window.location.hash}`;
    }
  }
</script>

{#if resolvedVersions.length > 1 && resolvedCurrentVersion}
  <DropdownMenu>
    <DropdownMenuTrigger class="docsfn-version-switcher-trigger">
      <span class="docsfn-version-label">{current?.label || resolvedCurrentVersion}</span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3 5L6 8L9 5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </DropdownMenuTrigger>
    <DropdownMenuPositioner>
      <DropdownMenuContent class="docsfn-version-switcher-content">
        {#each resolvedVersions as version (version.slug)}
          {@const isActive = version.slug === resolvedCurrentVersion}
          <DropdownMenuItem
            value={version.slug}
            on:click={() => handleChange(version.slug)}
            class="docsfn-version-item {isActive ? 'active' : ''}"
            data-active={isActive}
          >
            <span class="docsfn-version-item-label">{version.label}</span>
            {#if version.isDefault}
              <span class="docsfn-version-badge">Default</span>
            {/if}
            {#if isActive}
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                class="docsfn-version-check"
                aria-hidden="true"
              >
                <path
                  d="M13 4L6 11L3 8"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            {/if}
          </DropdownMenuItem>
        {/each}
      </DropdownMenuContent>
    </DropdownMenuPositioner>
  </DropdownMenu>
{/if}
