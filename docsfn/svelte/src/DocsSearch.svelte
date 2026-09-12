<script lang="ts">
  import { onMount } from "svelte";
  import { maybeEmitAnalyticsEvent, type DocsAnalyticsEvent } from "@docsfn/core/analytics";
  import type { DocsSearchArtifact, DocsSearchScope } from "@docsfn/core/search";
  import {
    createDocsSearchRuntime,
    type CreateDocsSearchRuntimeInput,
    type DocsSearchRuntime,
    type DocsSearchRuntimeResultItem,
  } from "@docsfn/core/search-runtime";
  import {
    Dialog,
    DialogBackdrop as DialogOverlay,
    DialogContent,
    DialogPortal,
    DialogPositioner,
  } from "@uifn/svelte";
  import Icon from "./Icon.svelte";

  type SearchScopeFilter = DocsSearchScope | "all";

  export let searchArtifact: DocsSearchArtifact | undefined = undefined;
  export let searchIndex: DocsSearchArtifact | undefined = undefined;
  export let loadSearchArtifact: (() => Promise<DocsSearchArtifact>) | undefined =
    undefined;
  export let createSearchRuntime: (
    input: CreateDocsSearchRuntimeInput
  ) => DocsSearchRuntime = createDocsSearchRuntime;
  export let placeholder = "Search docs...";
  export let initialScope: SearchScopeFilter = "all";
  export let scopes: SearchScopeFilter[] | undefined = undefined;
  export let scopeLabels: Record<string, string> = {
    all: "All",
    docs: "Docs",
    api: "API",
    blog: "Blog",
    changelog: "Changelog",
  };
  export let preserveSearchParams: string[] = ["embed"];
  export let analytics:
    | {
        enabled?: boolean;
        respectDnt?: boolean;
        route?: string;
        onEvent?: (event: DocsAnalyticsEvent) => void;
      }
    | undefined = undefined;

  let isOpen = false;
  let query = "";
  let results: DocsSearchRuntimeResultItem[] = [];
  let selectedIndex = 0;
  let scope: SearchScopeFilter = initialScope;
  let inputRef: HTMLInputElement;
  let runtime: DocsSearchRuntime | null = null;
  let requestVersion = 0;
  let runtimeVersion = 0;
  let loadedScopes: DocsSearchScope[] | undefined;

  function normalizeScopes(input: SearchScopeFilter[]): SearchScopeFilter[] {
    const seen = new Set<SearchScopeFilter>();
    const normalized: SearchScopeFilter[] = [];
    for (const item of input) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      normalized.push(item);
    }
    return normalized;
  }

  function getScopeLabel(value: string): string {
    if (scopeLabels[value]) {
      return scopeLabels[value];
    }
    return value
      .split(/[-_\s]+/g)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  function getResultHref(result: DocsSearchRuntimeResultItem): string {
    if (typeof window === "undefined" || preserveSearchParams.length === 0) {
      return result.path;
    }

    try {
      const currentUrl = new URL(window.location.href);
      const targetUrl = new URL(result.path, currentUrl.origin);
      if (targetUrl.origin !== currentUrl.origin) {
        return result.path;
      }

      for (const param of preserveSearchParams) {
        const value = currentUrl.searchParams.get(param);
        if (value !== null && !targetUrl.searchParams.has(param)) {
          targetUrl.searchParams.set(param, value.length > 0 ? value : "1");
        }
      }

      return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
    } catch {
      return result.path;
    }
  }

  $: artifactScopes = (searchArtifact ?? searchIndex)?.scopes ?? loadedScopes;
  $: supportedScopes = normalizeScopes((scopes?.length ? scopes : ["all", ...(artifactScopes ?? [])])
    .filter(item => item === "all" || !artifactScopes || artifactScopes.includes(item)));
  $: if (!supportedScopes.includes(scope) && !(loadSearchArtifact && artifactScopes === undefined)) {
    scope = supportedScopes[0] ?? "all";
  }
  $: {
    const version = ++runtimeVersion;
    const artifact = searchArtifact ?? searchIndex;
    const loader = loadSearchArtifact;
    loadedScopes = undefined;
    runtime = createSearchRuntime({
      artifact,
      loadArtifact: loader ? async () => {
        const loaded = await loader();
        if (version === runtimeVersion) loadedScopes = loaded.scopes;
        return loaded;
      } : undefined,
    });
  }

  async function runQuery(
    activeRuntime: DocsSearchRuntime | null,
    queryText: string,
    scopeFilter: SearchScopeFilter
  ) {
    if (!activeRuntime || queryText.trim().length === 0) {
      requestVersion += 1;
      results = [];
      selectedIndex = 0;
      return;
    }

    const currentVersion = ++requestVersion;
    try {
      const nextResults = await activeRuntime.query({
        query: queryText,
        scope: scopeFilter,
        limit: 10,
      });
      if (requestVersion !== currentVersion) {
        return;
      }
      results = nextResults;
      selectedIndex = 0;
      maybeEmitAnalyticsEvent({
        enabled: Boolean(analytics?.enabled),
        respectDnt: analytics?.respectDnt ?? true,
        event: {
          name: "docs.search",
          timestamp: new Date().toISOString(),
          route: analytics?.route ?? window.location.pathname,
          searchScope: scopeFilter === "all" ? undefined : scopeFilter,
          resultCount: nextResults.length,
        },
        emit: (event) => analytics?.onEvent?.(event),
      });
    } catch {
      if (requestVersion !== currentVersion) {
        return;
      }
      results = [];
      selectedIndex = 0;
    }
  }

  $: void runQuery(runtime, query, scope);

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        isOpen = true;
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  $: if (isOpen && inputRef) {
    inputRef.focus();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      handleResultClick(results[selectedIndex]);
    }
  }

  function handleResultClick(result: DocsSearchRuntimeResultItem) {
    const href = getResultHref(result);
    maybeEmitAnalyticsEvent({
      enabled: Boolean(analytics?.enabled),
      respectDnt: analytics?.respectDnt ?? true,
      event: {
        name: "docs.search_result_click",
        timestamp: new Date().toISOString(),
        route: analytics?.route ?? window.location.pathname,
        searchScope: result.scope,
        targetUrl: href,
      },
      emit: (event) => analytics?.onEvent?.(event),
    });
    window.location.href = href;
    isOpen = false;
  }

  function handleOpenChange(open: boolean) {
    isOpen = open;
    if (!open) {
      query = "";
      results = [];
      selectedIndex = 0;
    }
  }
</script>

<Dialog bind:open={isOpen} onOpenChange={handleOpenChange}>
  <button
    class="docsfn-search-trigger"
    on:click={() => (isOpen = true)}
    aria-label="Search documentation"
  >
    <span class="docsfn-search-icon" aria-hidden="true">
      <Icon name="search" size={16} strokeWidth={1.8} />
    </span>
    <span class="docsfn-search-placeholder">{placeholder}</span>
    <kbd class="docsfn-search-kbd">
      <span>⌘</span>
      <span>K</span>
    </kbd>
  </button>

  <DialogPortal>
    <DialogOverlay class="docsfn-search-overlay" />
    <DialogPositioner>
      <DialogContent class="docsfn-search-content" on:keydown={handleKeyDown}>
      <div class="docsfn-search-header">
        <span class="docsfn-search-icon" aria-hidden="true">
          <Icon name="search" size={18} strokeWidth={1.8} />
        </span>
        <input
          bind:this={inputRef}
          type="text"
          class="docsfn-search-input"
          {placeholder}
          bind:value={query}
          aria-label="Search query"
        />
        {#if query}
          <button
            on:click={() => (query = "")}
            class="docsfn-search-clear"
            aria-label="Clear search"
          >
            <Icon name="x" size={17} strokeWidth={1.8} />
          </button>
        {/if}
      </div>

      <div class="docsfn-search-scopes" role="group" aria-label="Search scope">
        {#each supportedScopes as option}
          <button
            type="button"
            class:docsfn-search-scope-active={scope === option}
            aria-pressed={scope === option}
            on:click={() => (scope = option)}
          >
            {getScopeLabel(option)}
          </button>
        {/each}
      </div>

      <div class="docsfn-search-results">
          {#if results.length === 0 && query}
            <div class="docsfn-search-empty">
              <p>No results found for "{query}"</p>
            </div>
          {:else if results.length === 0 && !query}
            <div class="docsfn-search-empty">
              <p>Start typing to search...</p>
            </div>
          {:else}
            <div class="docsfn-search-results-list">
              {#each results as result, index (`${result.id}:${result.path}`)}
                {@const resultHref = getResultHref(result)}
                <button
                  on:click={() => handleResultClick(result)}
                  class="docsfn-search-item {index === selectedIndex ? 'selected' : ''}"
                  data-selected={index === selectedIndex}
                  data-scope={result.scope}
                  data-href={resultHref}
                >
                  <div class="docsfn-search-item-header">
                    <span class="docsfn-search-item-scope">{getScopeLabel(result.scope)}</span>
                    <span class="docsfn-search-item-title">{result.title}</span>
                  </div>
                  {#if result.summary}
                    <p class="docsfn-search-item-desc">{result.summary}</p>
                  {/if}
                  <div class="docsfn-search-item-footer">
                    <span class="docsfn-search-item-path">{result.path}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
      </div>
      </DialogContent>
    </DialogPositioner>
  </DialogPortal>
</Dialog>

<style>
  :global(.docsfn-search-overlay) {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: rgb(15 23 42 / 0.42);
    backdrop-filter: blur(3px);
  }

  :global(.docsfn-search-content) {
    position: fixed;
    top: min(14vh, 7rem);
    left: 50%;
    z-index: 71;
    transform: translateX(-50%);
    width: min(42rem, calc(100vw - 2rem));
    max-height: min(80vh, 42rem);
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    border-radius: 0.5rem;
    background: var(--docsfn-color-surface, #fff);
    color: var(--docsfn-color-fg, #0f172a);
    box-shadow: 0 24px 60px rgb(15 23 42 / 0.2);
    overflow: hidden;
  }

  .docsfn-search-trigger {
    width: min(18rem, 28vw);
    min-width: 11rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.45rem 0 0.7rem;
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    border-radius: 0.375rem;
    background: var(--docsfn-color-surface, #fff);
    color: var(--docsfn-color-muted, #64748b);
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease;
  }

  .docsfn-search-trigger:hover,
  .docsfn-search-trigger:focus-visible {
    border-color: var(--docsfn-color-primary, #2563eb);
    color: var(--docsfn-color-fg, #0f172a);
    box-shadow: 0 0 0 3px var(--docsfn-color-accent-soft, rgb(37 99 235 / 0.08));
    outline: 0;
  }

  .docsfn-search-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--docsfn-color-muted, #64748b);
  }

  .docsfn-search-placeholder {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.84rem;
  }

  .docsfn-search-kbd {
    min-width: 2.2rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    border-radius: 0.25rem;
    background: var(--docsfn-color-bg, #f8fafc);
    color: var(--docsfn-color-muted, #64748b);
    font-family: inherit;
    font-size: 0.68rem;
    line-height: 1;
  }

  .docsfn-search-header {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.9rem 1rem;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
  }

  .docsfn-search-input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: inherit;
    font: inherit;
  }

  .docsfn-search-clear {
    width: 1.9rem;
    height: 1.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.3rem;
    border: 0;
    background: transparent;
    color: var(--docsfn-color-muted, #64748b);
    cursor: pointer;
    font: inherit;
  }

  .docsfn-search-clear:hover {
    background: var(--docsfn-color-accent-soft, rgb(37 99 235 / 0.08));
    color: var(--docsfn-color-fg, #0f172a);
  }

  .docsfn-search-scopes {
    display: flex;
    gap: 0;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
    overflow-x: auto;
  }

  .docsfn-search-scopes button {
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    border-radius: 0;
    margin-left: -1px;
    padding: 0.35rem 0.7rem;
    background: transparent;
    color: var(--docsfn-color-muted, #64748b);
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .docsfn-search-scopes button:first-child {
    margin-left: 0;
    border-radius: 0.35rem 0 0 0.35rem;
  }

  .docsfn-search-scopes button:last-child {
    border-radius: 0 0.35rem 0.35rem 0;
  }

  .docsfn-search-scopes button:hover,
  .docsfn-search-scopes button.docsfn-search-scope-active {
    border-color: var(--docsfn-color-primary, #2563eb);
    color: var(--docsfn-color-primary, #2563eb);
    background: var(--docsfn-color-accent-soft, rgb(37 99 235 / 0.08));
  }

  .docsfn-search-results-list {
    display: grid;
    gap: 0.25rem;
    padding: 0.5rem;
  }

  .docsfn-search-item {
    width: 100%;
    display: grid;
    gap: 0.35rem;
    border: 1px solid transparent;
    border-radius: 0.6rem;
    padding: 0.75rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .docsfn-search-item:hover,
  .docsfn-search-item.selected {
    border-color: var(--docsfn-color-border, #e2e8f0);
    background: var(--docsfn-color-accent-soft, rgb(37 99 235 / 0.08));
  }

  .docsfn-search-item-header {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }

  .docsfn-search-item-scope {
    flex: 0 0 auto;
    border-radius: 0.25rem;
    padding: 0.18rem 0.48rem;
    background: var(--docsfn-color-border, #e2e8f0);
    color: var(--docsfn-color-fg, #0f172a);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.2;
  }

  .docsfn-search-item-title {
    min-width: 0;
    color: var(--docsfn-color-fg, #0f172a);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .docsfn-search-item-desc {
    margin: 0;
    color: var(--docsfn-color-muted, #64748b);
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .docsfn-search-item-footer {
    display: flex;
    min-width: 0;
  }

  .docsfn-search-item-path {
    min-width: 0;
    color: var(--docsfn-color-muted, #64748b);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .docsfn-search-empty {
    padding: 2rem 1rem;
    color: var(--docsfn-color-muted, #64748b);
    text-align: center;
  }

  .docsfn-search-empty p {
    margin: 0;
  }

  @media (max-width: 720px) {
    .docsfn-search-trigger {
      width: 2.25rem;
      min-width: 2.25rem;
      padding: 0;
      justify-content: center;
    }

    .docsfn-search-placeholder,
    .docsfn-search-kbd {
      display: none;
    }

    :global(.docsfn-search-content) {
      top: 0.75rem;
      width: calc(100vw - 1.5rem);
      max-height: calc(100vh - 1.5rem);
    }
  }
</style>
