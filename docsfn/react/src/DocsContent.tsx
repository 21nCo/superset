"use client";

import React from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  Lightbulb,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  assertCompiledContentTrusted,
  compileReactContent,
  createDiagnostic,
  createDocsError,
  type CompiledContentArtifact,
  type CompiledContentBlock,
  type DocsCompatPreset,
} from "@docsfn/core/browser";
import { YouTubeEmbed } from "./YouTubeEmbed";

type DocsContentComponentProps = Record<string, unknown> & {
  children?: React.ReactNode;
};

type MermaidBlock = Extract<CompiledContentBlock, { type: "mermaid" }>;

const builtinComponents: Record<string, React.ComponentType<DocsContentComponentProps>> = {
  YouTube: YouTubeEmbed,
};

export interface DocsContentProps {
  compiled?: CompiledContentArtifact;
  content?: string;
  sourcePath?: string;
  compatPreset?: DocsCompatPreset;
  allowUnsafeHtml?: boolean;
  unsafeHtmlAllowlist?: string[];
  components?: Record<string, React.ComponentType<DocsContentComponentProps>>;
  renderMermaid?: (block: MermaidBlock) => React.ReactNode;
  pageActionsSlot?: React.ReactNode;
}

function CodeBlock({ block }: { block: Extract<CompiledContentBlock, { type: "code" }> }) {
  const [copied, setCopied] = React.useState(false);

  const copyCode = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(block.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="docsfn-code-block">
      <div className="docsfn-code-header">
        <span>{block.lang ?? "Code"}</span>
        <button type="button" onClick={copyCode} aria-label={copied ? "Code copied" : "Copy code"}>
          {copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.8} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre data-docsfn-code="true">
        <code data-lang={block.lang}>{block.code}</code>
      </pre>
    </div>
  );
}

const calloutIcons: Record<string, LucideIcon> = {
  note: CircleAlert,
  tip: Lightbulb,
  warning: TriangleAlert,
  info: Info,
  caution: CircleCheck,
};

function Callout({ block }: { block: Extract<CompiledContentBlock, { type: "callout" }> }) {
  const Icon = calloutIcons[block.kind] ?? CircleAlert;
  const label = `${block.kind.slice(0, 1).toUpperCase()}${block.kind.slice(1)}`;
  return (
    <aside data-docsfn-callout={block.kind}>
      <div className="docsfn-callout-title">
        <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="docsfn-callout-content" dangerouslySetInnerHTML={{ __html: block.html }} />
    </aside>
  );
}

function DefaultMermaidRenderer({ block }: { block: MermaidBlock }) {
  return (
    <div data-docsfn-mermaid="true" data-mermaid-id={block.id}>
      <code>{block.code}</code>
    </div>
  );
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

function renderBlocks(input: {
  blocks: CompiledContentBlock[];
  components?: DocsContentProps["components"];
  renderMermaid?: DocsContentProps["renderMermaid"];
  activeTabs: Record<string, string>;
  setActiveTabs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  keyPath: string;
}): React.ReactNode {
  return input.blocks.map((block, index) => (
    <React.Fragment key={`${input.keyPath}:${block.type}:${index}`}>
      {renderBlock({
        block,
        index,
        components: input.components,
        renderMermaid: input.renderMermaid,
        activeTabs: input.activeTabs,
        setActiveTabs: input.setActiveTabs,
        keyPath: `${input.keyPath}.${index}`,
      })}
    </React.Fragment>
  ));
}

function renderBlock(input: {
  block: CompiledContentBlock;
  index: number;
  components?: DocsContentProps["components"];
  renderMermaid?: DocsContentProps["renderMermaid"];
  activeTabs: Record<string, string>;
  setActiveTabs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  keyPath: string;
}) {
  const { block } = input;
  if (block.type === "heading") {
    const headingTag = `h${Math.max(1, Math.min(6, block.level))}`;
    return React.createElement(headingTag, {
      id: block.slug,
      dangerouslySetInnerHTML: { __html: block.html },
    });
  }

  if (block.type === "paragraph") {
    return <p dangerouslySetInnerHTML={{ __html: block.html }} />;
  }

  if (block.type === "list") {
    return <div dangerouslySetInnerHTML={{ __html: block.html }} />;
  }

  if (block.type === "table") {
    return <div className="docsfn-table-wrap" dangerouslySetInnerHTML={{ __html: block.html }} />;
  }

  if (block.type === "code") {
    return <CodeBlock block={block} />;
  }

  if (block.type === "mermaid") {
    return input.renderMermaid ? input.renderMermaid(block) : <DefaultMermaidRenderer block={block} />;
  }

  if (block.type === "callout") {
    return <Callout block={block} />;
  }

  if (block.type === "tabs") {
    const fallbackTab = block.items[0] ?? block.tabs[0]?.value ?? "";
    const activeValue = input.activeTabs[input.keyPath] ?? fallbackTab;
    const activeTab = block.tabs.find((tab) => tab.value === activeValue) ?? block.tabs[0];
    const tablistId = `docsfn-tabs-${input.keyPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const panelId = `${tablistId}-panel`;
    return (
      <div data-docsfn-tabs="true">
        <div role="tablist" aria-label="Tabs">
          {block.tabs.map((tab, tabIndex) => {
            const tabId = `${tablistId}-tab-${tabIndex}`;
            const isActive = tab.value === activeValue;
            return (
            <button
              type="button"
              key={tab.value}
              id={tabId}
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() =>
                input.setActiveTabs((current) => ({
                  ...current,
                  [input.keyPath]: tab.value,
                }))
              }
            >
              {tab.label ?? tab.value}
            </button>
            );
          })}
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
          {activeTab
            ? renderBlocks({
                blocks: activeTab.nodes,
                components: input.components,
                renderMermaid: input.renderMermaid,
                activeTabs: input.activeTabs,
                setActiveTabs: input.setActiveTabs,
                keyPath: `${input.keyPath}.tab.${activeTab.value}`,
              })
            : null}
        </div>
      </div>
    );
  }

  const Component = input.components?.[block.name] ?? builtinComponents[block.name];
  if (!Component) {
    throw createMissingComponentError(block.name);
  }

  return (
    <Component {...block.props}>
      {renderBlocks({
        blocks: block.children,
        components: input.components,
        renderMermaid: input.renderMermaid,
        activeTabs: input.activeTabs,
        setActiveTabs: input.setActiveTabs,
        keyPath: `${input.keyPath}.component.${block.name}`,
      })}
    </Component>
  );
}

export function DocsContent({
  compiled,
  content,
  sourcePath,
  compatPreset = "none",
  allowUnsafeHtml = false,
  unsafeHtmlAllowlist,
  components,
  renderMermaid,
  pageActionsSlot,
}: DocsContentProps) {
  const compiledContent = React.useMemo(() => {
    if (compiled) {
      assertCompiledContentTrusted({
        source: compiled.transformedSource || compiled.source || "",
        sourcePath,
        policy: {
          allowUnsafeHtml,
          allowUnsafeHtmlAllowlist: unsafeHtmlAllowlist,
        },
      });
      return compiled;
    }
    return compileReactContent({
      source: content ?? "",
      sourcePath,
      compatPreset,
      allowRawHtml: allowUnsafeHtml,
    });
  }, [
    compiled,
    content,
    sourcePath,
    compatPreset,
    allowUnsafeHtml,
    unsafeHtmlAllowlist,
  ]);

  const [activeTabs, setActiveTabs] = React.useState<Record<string, string>>({});

  return (
    <div className="docsfn-content">
      {renderBlocks({
        blocks: compiledContent.blocks,
        components,
        renderMermaid,
        activeTabs,
        setActiveTabs,
        keyPath: "root",
      })}
      {pageActionsSlot ? (
        <div data-docsfn-page-actions="true">{pageActionsSlot}</div>
      ) : null}
    </div>
  );
}
