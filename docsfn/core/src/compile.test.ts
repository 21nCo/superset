import { describe, expect, it } from "vitest";
import { compileReactContent } from "./compile/react";
import { compileSvelteContent } from "./compile/svelte";
import { compileMarkdown } from "./markdown";

describe("compile pipeline", () => {
  it("compiles fumadocs tabs + mermaid into canonical blocks (TV-MDX-001)", () => {
    const input = `import { Tab, Tabs } from "fumadocs-ui/components/tabs";

# Routes

<Tabs items={["TypeScript", "Python"]}>
  <Tab value="TypeScript">TS body</Tab>
  <Tab value="Python">PY body</Tab>
</Tabs>

\`\`\`mermaid
graph TD;
\`\`\`
`;

    const compiled = compileMarkdown({
      source: input,
      sourcePath: "content/docs/routes.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(compiled.renderModelVersion).toBe(2);
    expect(compiled.headings).toEqual([{ level: 1, text: "Routes", slug: "routes" }]);
    expect(compiled.componentsUsed).toEqual(["DocsTab", "DocsTabs", "MermaidBlock"]);
    expect(compiled.blocks.find((block) => block.type === "tabs")).toMatchObject({
      type: "tabs",
      items: ["TypeScript", "Python"],
      tabs: [
        {
          value: "TypeScript",
          label: "TypeScript",
          source: "TS body",
          content: "TS body",
          nodes: [{ type: "paragraph", text: "TS body" }],
        },
        {
          value: "Python",
          label: "Python",
          source: "PY body",
          content: "PY body",
          nodes: [{ type: "paragraph", text: "PY body" }],
        },
      ],
    });
    expect(compiled.blocks.find((block) => block.type === "mermaid")).toMatchObject({
      type: "mermaid",
      id: "mermaid-content/docs/routes-mdx-01",
      code: "graph TD;",
    });
  });

  it("parses callout blocks", () => {
    const compiled = compileMarkdown({
      source: `> [!NOTE] Keep this deterministic\n> across builds.`,
      sourcePath: "content/docs/note.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    expect(compiled.blocks[0]).toMatchObject({
      type: "callout",
      kind: "note",
      text: "Keep this deterministic\nacross builds.",
    });
    expect(typeof (compiled.blocks[0] as { html: string }).html).toBe("string");
    expect((compiled.blocks[0] as { html: string }).html.length).toBeGreaterThan(0);
  });

  it("rejects unsupported fumadocs constructs (TV-MIG-001 negative)", () => {
    const input = `import { Accordion } from "fumadocs-ui/components/accordion";\n<Accordion />`;
    expect(() =>
      compileMarkdown({
        source: input,
        sourcePath: "content/docs/bad.mdx",
        compatPreset: "fumadocs-v15",
      })
    ).toThrowError(/DOCS_COMPAT_UNSUPPORTED|Accordion/);
  });

  it("fails unresolved JSX components in compatibility mode with DOCS_COMPONENT_UNRESOLVED", () => {
    expect(() =>
      compileMarkdown({
        source: "# Title\n\n<Foo />",
        sourcePath: "content/docs/foo.mdx",
        compatPreset: "fumadocs-v15",
      })
    ).toThrowError(/DOCS_COMPONENT_UNRESOLVED|component Foo is not resolved/);
  });

  it("keeps imported non-fumadocs MDX components available in compatibility mode", () => {
    const compiled = compileMarkdown({
      source: `import { DemoCard } from "./DemoCard";\n\n# Demo\n\n<DemoCard />`,
      sourcePath: "content/docs/demo.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(compiled.blocks.some((block) => block.type === "component" && block.name === "DemoCard")).toBe(true);
  });

  it("preserves Fumadocs examples and supports aliased tab imports", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs as MyTabs, Tab as MyTab } from "fumadocs-ui/components/tabs";',
        "",
        "`<Tabs><Tab /></Tabs>`",
        "",
        "```tsx",
        'import { Tabs } from "fumadocs-ui/components/tabs";',
        "<Tabs><Tab /></Tabs>",
        "```",
        "",
        '<MyTabs items={["A"]}>',
        '  <MyTab value="A">Body</MyTab>',
        "</MyTabs>",
      ].join("\n"),
      sourcePath: "content/docs/aliased.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("`<Tabs><Tab /></Tabs>`");
    expect(compiled.transformedSource).toContain('import { Tabs } from "fumadocs-ui/components/tabs";');
    expect(compiled.blocks.some((block) => block.type === "tabs")).toBe(true);
  });

  it("does not rewrite Fumadocs tags inside quoted fences or false closing markers", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "> ```md",
        "> <Tabs><Tab /></Tabs>",
        "> ```",
        "",
        "```txt",
        "<Tabs>",
        "``` not-a-closer",
        "<Tab />",
        "```",
        "",
        "``<Tabs><Tab /></Tabs>``",
        "",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/quoted-fence.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("> <Tabs><Tab /></Tabs>");
    expect(compiled.transformedSource).toContain("<Tabs>");
    expect(compiled.transformedSource).toContain("<Tab />");
    expect(compiled.transformedSource).toContain("``<Tabs><Tab /></Tabs>``");
    expect(compiled.blocks.some((block) => block.type === "tabs")).toBe(true);
  });

  it("treats mixed fence markers as ordinary text", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "~`` not a fence",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/mixed-fence.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("<DocsTabs");
    expect(compiled.transformedSource).toContain("~`` not a fence");
  });

  it("closes an unquoted fence after a quoted fence loses quote depth", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "> ```js",
        "> unclosed quoted fence",
        "",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/quoted-fence.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("<DocsTabs");
  });

  it("treats list-item fences as code during fumadocs transforms", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "- ```html",
        "  <Tabs />",
        "  ```",
        "",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/list-fence.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("- ```html");
    expect(compiled.transformedSource).toContain("<Tabs />");
    expect(compiled.transformedSource).toContain("<DocsTabs");
  });

  it("closes four-space list-item fences before later fumadocs tags", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "- ```html",
        "    <Tabs />",
        "    ```",
        "",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/list-fence-indent.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("    ```");
    expect(compiled.transformedSource).toContain("<DocsTabs");
  });

  it("closes list-item blockquote fences before later fumadocs tags", () => {
    const compiled = compileMarkdown({
      source: [
        'import { Tabs, Tab } from "fumadocs-ui/components/tabs";',
        "",
        "- > ```js",
        "  > const ok = true;",
        "  > ```",
        "",
        '<Tabs items={["A"]}>',
        '  <Tab value="A">Body</Tab>',
        "</Tabs>",
      ].join("\n"),
      sourcePath: "content/docs/list-quote-fence.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(compiled.transformedSource).toContain("- > ```js");
    expect(compiled.transformedSource).toContain("<DocsTabs");
  });

  it("compiles nested component children and preserves normalized props", () => {
    const compiled = compileMarkdown({
      source: `import { DemoCard } from "./DemoCard";

# Demo

<DemoCard items={3} enabled rating={4.5}>
## Nested

Child body

\`\`\`mermaid
graph TD;
\`\`\`
</DemoCard>`,
      sourcePath: "content/docs/demo-card.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(compiled.blocks.find((block) => block.type === "component")).toMatchObject({
      type: "component",
      name: "DemoCard",
      props: {
        items: 3,
        enabled: true,
        rating: 4.5,
      },
      source: "## Nested\n\nChild body\n\n```mermaid\ngraph TD;\n```",
      body: "## Nested\n\nChild body\n\n```mermaid\ngraph TD;\n```",
      selfClosing: false,
      children: [
        { type: "heading", level: 2, text: "Nested", slug: "nested" },
        { type: "paragraph", text: "Child body" },
        { type: "mermaid", id: "mermaid-content/docs/demo-card-mdx-component-DemoCard-01-01", code: "graph TD;" },
      ],
    });
  });

  it("keeps mermaid ids unique across repeated tabs and component blocks", () => {
    const compiled = compileMarkdown({
      source: `import { DemoCard } from "./DemoCard";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

# Demo

<Tabs items={["One"]}>
  <Tab value="One">
\`\`\`mermaid
graph TD;
\`\`\`
  </Tab>
</Tabs>

<Tabs items={["Two"]}>
  <Tab value="Two">
\`\`\`mermaid
graph TD;
\`\`\`
  </Tab>
</Tabs>

<DemoCard>
\`\`\`mermaid
graph TD;
\`\`\`
</DemoCard>

<DemoCard>
\`\`\`mermaid
graph TD;
\`\`\`
</DemoCard>`,
      sourcePath: "content/docs/unique-mermaid.mdx",
      compatPreset: "fumadocs-v15",
    });

    const mermaidIds = JSON.stringify(compiled.blocks)
      .match(/mermaid-[A-Za-z0-9/_-]+/g)
      ?.sort() ?? [];
    expect(mermaidIds.length).toBe(4);
    expect(new Set(mermaidIds).size).toBe(4);
  });

  it("rejects unsafe html by default (TV-SEC-001)", () => {
    expect(() =>
      compileMarkdown({
        source: "# Unsafe\n\n<script>alert(1)</script>",
        sourcePath: "content/docs/unsafe.mdx",
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("fails malformed mdx with DOCS_MDX_COMPILE_FAILED", () => {
    expect(() =>
      compileMarkdown({
        source: `<DocsTabs items={["A"]}>\n<DocsTab value="A">x`,
        sourcePath: "content/docs/malformed.mdx",
      })
    ).toThrowError(/DOCS_MDX_COMPILE_FAILED|missing/);
  });

  it("produces a shared canonical block model for react and svelte compilers", () => {
    const source = `# Shared\n\nParagraph`;
    const reactCompiled = compileReactContent({ source, sourcePath: "content/docs/shared.mdx" });
    const svelteCompiled = compileSvelteContent({ source, sourcePath: "content/docs/shared.mdx" });

    expect(reactCompiled.framework).toBe("react");
    expect(svelteCompiled.framework).toBe("svelte");
    expect(reactCompiled.renderModelVersion).toBe(2);
    expect(svelteCompiled.renderModelVersion).toBe(2);
    expect(reactCompiled.blocks).toEqual(svelteCompiled.blocks);
    expect(reactCompiled.toc).toEqual(svelteCompiled.toc);
  });
});
