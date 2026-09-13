<script lang="ts">
  import type { ComponentType } from "svelte";
  import {
    assertCompiledContentTrusted,
    compileSvelteContent,
    createDiagnostic,
    createDocsError,
    type CompiledContentArtifact,
    type CompiledContentBlock,
    type CompiledMermaidBlock,
    type DocsCompatPreset,
  } from "@docsfn/core/browser";
  import Icon, { type IconName } from "./Icon.svelte";
  import YouTubeEmbed from "./YouTubeEmbed.svelte";

  export let compiled: CompiledContentArtifact | undefined = undefined;
  export let blocks: CompiledContentBlock[] | undefined = undefined;
  export let content = "";
  export let sourcePath: string | undefined = undefined;
  export let compatPreset: DocsCompatPreset = "none";
  export let allowUnsafeHtml = false;
  export let unsafeHtmlAllowlist: string[] = [];
  export let components: Record<string, ComponentType | undefined> = {};
  export let renderMermaid: ComponentType<{ block: CompiledMermaidBlock }> | undefined =
    undefined;
  export let keyPath = "root";
  export let nested = false;

  let activeTabs: Record<string, string> = {};
  let copiedCodeKey: string | undefined = undefined;
  const builtinComponents: Record<string, ComponentType | undefined> = {
    YouTube: YouTubeEmbed,
  };

  $: compiledContent =
    compiled ??
    compileSvelteContent({
      source: content,
      sourcePath,
      compatPreset,
      allowRawHtml: allowUnsafeHtml,
    });

  $: if (compiled) {
    assertCompiledContentTrusted({
      source: compiled.transformedSource || compiled.source || "",
      sourcePath,
      policy: {
        allowUnsafeHtml,
        allowUnsafeHtmlAllowlist: unsafeHtmlAllowlist,
      },
    });
  }

  $: renderedBlocks = blocks ?? compiledContent.blocks;

  function activateTab(path: string, value: string) {
    activeTabs = {
      ...activeTabs,
      [path]: value,
    };
  }

  function createMissingComponentError(name: string) {
    return createDocsError({
      code: "DOCS_COMPONENT_UNRESOLVED",
      message: `component ${name} is not resolved`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_COMPONENT_UNRESOLVED",
          message: `component ${name} is not resolved`,
          details: {
            component: name,
          },
        }),
      ],
    });
  }

  function getCalloutLabel(kind: string): string {
    return {
      note: "Note",
      tip: "Tip",
      warning: "Warning",
      info: "Info",
      caution: "Caution",
    }[kind] ?? "Note";
  }

  function getCalloutIcon(kind: string): IconName {
    return {
      note: "circle-alert",
      tip: "lightbulb",
      warning: "triangle-alert",
      info: "info",
      caution: "circle-check",
    }[kind] ?? "circle-alert";
  }

  async function copyCode(code: string, codeKey: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(code);
    copiedCodeKey = codeKey;
    setTimeout(() => {
      if (copiedCodeKey === codeKey) {
        copiedCodeKey = undefined;
      }
    }, 1800);
  }

  function resolveComponent(name: string): ComponentType {
    const component = components[name] ?? builtinComponents[name];
    if (!component) {
      throw createMissingComponentError(name);
    }
    return component;
  }
</script>

<div class="docsfn-content">
  {#each renderedBlocks as block, index (`${keyPath}:${block.type}:${index}`)}
    {#if block.type === "heading"}
      <svelte:element this={`h${block.level}`} id={block.slug}>{@html block.html}</svelte:element>
    {:else if block.type === "paragraph"}
      <p>{@html block.html}</p>
    {:else if block.type === "list"}
      {@html block.html}
    {:else if block.type === "table"}
      <div class="docsfn-table-wrap">{@html block.html}</div>
    {:else if block.type === "code"}
      {@const codeKey = `${keyPath}.code.${index}`}
      <div class="docsfn-code-block">
        <div class="docsfn-code-header">
          <span>{block.lang ?? "Code"}</span>
          <button
            type="button"
            aria-label={copiedCodeKey === codeKey ? "Code copied" : "Copy code"}
            on:click={() => copyCode(block.code, codeKey)}
          >
            {#if copiedCodeKey === codeKey}
              <Icon name="check" size={14} strokeWidth={1.8} />
              Copied
            {:else}
              <Icon name="copy" size={14} strokeWidth={1.8} />
              Copy
            {/if}
          </button>
        </div>
        <pre data-docsfn-code="true"><code data-lang={block.lang}>{block.code}</code></pre>
      </div>
    {:else if block.type === "mermaid"}
      {#if renderMermaid}
        <svelte:component this={renderMermaid} {block} />
      {:else}
        <div data-docsfn-mermaid="true" data-mermaid-id={block.id}>
          <code>{block.code}</code>
        </div>
      {/if}
    {:else if block.type === "callout"}
      <aside data-docsfn-callout={block.kind}>
        <div class="docsfn-callout-title">
          <Icon name={getCalloutIcon(block.kind)} size={17} strokeWidth={1.8} />
          <span>{getCalloutLabel(block.kind)}</span>
        </div>
        <div class="docsfn-callout-content">{@html block.html}</div>
      </aside>
    {:else if block.type === "tabs"}
      {@const fallbackTab = block.items[0] ?? block.tabs[0]?.value ?? ""}
      {@const tabKey = `${keyPath}.tab.${index}`}
      {@const activeValue = activeTabs[tabKey] ?? fallbackTab}
      {@const activeTab = block.tabs.find((tab) => tab.value === activeValue) ?? block.tabs[0]}
      {@const tablistId = `docsfn-tabs-${tabKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
      {@const panelId = `${tablistId}-panel`}
      <div data-docsfn-tabs="true">
        <div role="tablist" aria-label="Tabs">
          {#each block.tabs as tab, tabIndex (tab.value)}
            <button
              type="button"
              role="tab"
              id={`${tablistId}-tab-${tabIndex}`}
              aria-selected={tab.value === activeValue}
              aria-controls={panelId}
              tabindex={tab.value === activeValue ? 0 : -1}
              on:click={() => activateTab(tabKey, tab.value)}
            >
              {tab.label ?? tab.value}
            </button>
          {/each}
        </div>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={
            activeTab
              ? `${tablistId}-tab-${block.tabs.findIndex((tab) => tab.value === activeTab.value)}`
              : undefined
          }
        >
          {#if activeTab}
            <svelte:self
              blocks={activeTab.nodes}
              {components}
              {renderMermaid}
              {allowUnsafeHtml}
              {unsafeHtmlAllowlist}
              keyPath={`${tabKey}.${activeTab.value}`}
              nested={true}
            />
          {/if}
        </div>
      </div>
    {:else}
      <svelte:component this={resolveComponent(block.name)} {...block.props}>
        {#if block.children.length > 0}
          <svelte:self
            blocks={block.children}
            {components}
            {renderMermaid}
            {allowUnsafeHtml}
            {unsafeHtmlAllowlist}
            keyPath={`${keyPath}.component.${block.name}.${index}`}
            nested={true}
          />
        {/if}
      </svelte:component>
    {/if}
  {/each}

  {#if !nested}
    <div data-docsfn-page-actions="true">
      <slot name="page-actions" />
    </div>
  {/if}
</div>
