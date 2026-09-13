---
title: core — Markdown
description: Markdown compilation and CompiledContentBlock types in @docsfn/core.
---

# Markdown (`@docsfn/core`)

## Pipelines

| Function | Output |
| --- | --- |
| **`compileMarkdown(input)`** | `CompiledContentArtifact` — base compiler (framework-agnostic). |
| **`compileSvelteContent(input)`** | `CompiledContentArtifact` with `framework: "svelte"`. |
| **`compileReactContent(input)`** | `CompiledContentArtifact` with `framework: "react"`. |

`compileSvelteContent` and `compileReactContent` are thin wrappers around **`compileMarkdown`** that set the `framework` field.

**`CompileMarkdownInput`:** `source`, optional `sourcePath`, `framework`, **`compatPreset`**, **`allowRawHtml`**.

## `extractHeadings`

```ts
extractHeadings(markdown: string): DocHeading[]
```

Parses raw Markdown and returns an array of **`DocHeading`** objects (`{ level, text, slug }`) without running the full compile pipeline. Useful for building a table of contents from source text before compilation.

## `CompiledContentArtifact`

| Field | Description |
| --- | --- |
| `framework` | `core` \| `svelte` \| `react`. |
| `source` / `transformedSource` | Original and compat-transformed Markdown. |
| `blocks` | Ordered **`CompiledContentBlock[]`**. |
| `headings` / `toc` | Extracted heading metadata. |
| `componentsUsed` | PascalCase components detected. |
| `diagnostics` | Compile-time issues. |

## `CompiledContentBlock` union

| `type` | Payload |
| --- | --- |
| `heading` | `level`, `text`, `slug`. |
| `paragraph` | `text`. |
| `list` | `ordered`, `items[]` (each `{ text }`), `html`. |
| `code` | `lang?`, `code`. |
| `mermaid` | `code` (diagram source). |
| `tabs` | `items`, `tabs[]` with `value` + `content`. |
| `callout` | `kind`: note \| tip \| warning \| info \| caution; `text`. |
| `table` | `html` (rendered HTML table). |
| `component` | `name`, optional `body`, `selfClosing`. |

Fumadocs preset may rewrite `Tabs`/`Tab` imports to docsfn component names before parsing.
