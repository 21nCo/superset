import { describe, expect, it } from "vitest";
import { resolveMarkdownRelativeLinks } from "./links";
import { compileMarkdown, extractHeadings } from "./markdown";

describe("extractHeadings", () => {
  it("extracts deterministic heading anchors from markdown", () => {
    const headings = extractHeadings(`# Heading 1\n\n## Heading 2\n\n### Heading 3\n`);
    expect(headings).toEqual([
      { level: 1, text: "Heading 1", slug: "heading-1" },
      { level: 2, text: "Heading 2", slug: "heading-2" },
      { level: 3, text: "Heading 3", slug: "heading-3" },
    ]);
  });

  it("ignores heading-like lines inside fenced code blocks (TV-MDX-002)", () => {
    const markdown = `## Overview

\`\`\`bash
# Not a heading
\`\`\`

## Overview
`;
    const headings = extractHeadings(markdown);
    expect(headings).toEqual([
      { level: 2, text: "Overview", slug: "overview" },
      { level: 2, text: "Overview", slug: "overview-1" },
    ]);
  });

  it("generates stable unicode slugs for japanese headings (TV-MDX-002)", () => {
    const headings = extractHeadings("## 日本語のヘディング\n");
    expect(headings).toEqual([
      {
        level: 2,
        text: "日本語のヘディング",
        slug: "ri-ben-yu-nohedingu",
      },
    ]);
  });

  it("returns an empty list when there are no headings", () => {
    expect(extractHeadings("just text\n\nno headings")).toEqual([]);
  });
});

describe("compileMarkdown – list blocks", () => {
  it("parses unordered lists as a list block", () => {
    const compiled = compileMarkdown({
      source: "- Install\n- Configure\n- Deploy",
      sourcePath: "content/docs/list.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    const block = compiled.blocks[0];
    expect(block.type).toBe("list");
    if (block.type === "list") {
      expect(block.ordered).toBe(false);
      expect(block.items).toEqual([
        { text: "Install" },
        { text: "Configure" },
        { text: "Deploy" },
      ]);
      expect(block.html).toContain("<ul>");
      expect(block.html).toContain("<li>");
      expect(block.html).toContain("Install");
    }
  });

  it("parses ordered lists as a list block", () => {
    const compiled = compileMarkdown({
      source: "1. First\n2. Second\n3. Third",
      sourcePath: "content/docs/ordered.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("list");
    if (block.type === "list") {
      expect(block.ordered).toBe(true);
      expect(block.html).toContain("<ol>");
    }
  });

  it("list no longer merges into a paragraph block", () => {
    const compiled = compileMarkdown({
      source: "- Install\n- Configure\n- Deploy",
      sourcePath: "content/docs/list2.mdx",
    });
    const paragraphs = compiled.blocks.filter((b) => b.type === "paragraph");
    expect(paragraphs).toHaveLength(0);
  });

  it("mixed content: heading + paragraph + list", () => {
    const compiled = compileMarkdown({
      source: "# Steps\n\nDo this:\n\n- Alpha\n- Beta",
      sourcePath: "content/docs/mixed.mdx",
    });
    expect(compiled.blocks[0].type).toBe("heading");
    expect(compiled.blocks[1].type).toBe("paragraph");
    expect(compiled.blocks[2].type).toBe("list");
  });
});

describe("compileMarkdown – html fields", () => {
  it("heading block has an html field with rendered inline markdown", () => {
    const compiled = compileMarkdown({
      source: "## Install **docsfn**",
      sourcePath: "content/docs/h.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("heading");
    if (block.type === "heading") {
      expect(block.html).toContain("<strong>");
      expect(block.html).toContain("docsfn");
    }
  });

  it("paragraph block has an html field with rendered inline markdown", () => {
    const compiled = compileMarkdown({
      source: "Use `npm install` to get started.",
      sourcePath: "content/docs/p.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain("<code>");
      expect(block.html).toContain("npm install");
      expect(block.html).not.toContain("</p>");
    }
  });

  it("html field sanitizes javascript: href", () => {
    // allowRawHtml bypasses source-level blocking so we can verify output sanitization
    const compiled = compileMarkdown({
      source: "Click [here](javascript:alert(1)) for info.",
      sourcePath: "content/docs/xss.mdx",
      allowRawHtml: true,
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).not.toContain("javascript:");
    }
  });

  it("renders opted-in raw HTML through the canonical sanitizer", () => {
    const compiled = compileMarkdown({
      source: '<span class="note" onclick="alert(1)">safe</span>',
      sourcePath: "content/docs/raw-html.mdx",
      allowRawHtml: true,
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain('<span class="note">safe</span>');
      expect(block.html).not.toContain("onclick");
    }
  });

  it("projects the canonical MDFN URL policy into DocsFn output and diagnostics", () => {
    const compiled = compileMarkdown({
      source: "Click [here](java%0ascript:alert(1)) for info.",
      sourcePath: "content/docs/canonical-policy.mdx",
      allowRawHtml: true,
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain("data-mdfn-blocked-link");
      expect(block.html).not.toContain("href=");
    }
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DOCS_MARKDOWN_DIAGNOSTIC",
        details: expect.objectContaining({ mdfnCode: "MDFN_UNSAFE_URL" }),
      }),
    ]));
  });

  it("callout block has an html field", () => {
    const compiled = compileMarkdown({
      source: "> [!TIP] Use **bold** in callouts.",
      sourcePath: "content/docs/callout.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("callout");
    if (block.type === "callout") {
      expect(block.html).toContain("<strong>");
    }
  });
});

describe("compileMarkdown – table blocks", () => {
  it("parses a markdown table as a table block with rendered html", () => {
    const source = `| Name | Value |\n|------|-------|\n| Foo  | Bar   |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    const block = compiled.blocks[0];
    expect(block.type).toBe("table");
    if (block.type === "table") {
      expect(block.html).toContain("<table");
      expect(block.html).toContain("<th");
      expect(block.html).toContain("Name");
      expect(block.html).toContain("Value");
      expect(block.html).toContain("Foo");
    }
  });

  it("table no longer falls into a paragraph block", () => {
    const source = `| A | B |\n|---|---|\n| 1 | 2 |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table2.mdx",
    });
    const types = compiled.blocks.map((b) => b.type);
    expect(types).not.toContain("paragraph");
    expect(types).toContain("table");
  });

  it("table with alignment syntax produces correct html", () => {
    const source = `| Left | Center | Right |\n|:-----|:------:|------:|\n| a    |   b    |     c |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table3.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("table");
    if (block.type === "table") {
      expect(block.html).toContain("<table");
    }
  });

  it("table mixed with other blocks parses correctly", () => {
    const source = `## Overview\n\nSome text.\n\n| Key | Value |\n|-----|-------|\n| x   | y     |\n\nMore text.`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/mixed.mdx",
    });
    const types = compiled.blocks.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("table");
  });
});

describe("resolveMarkdownRelativeLinks", () => {
  it("resolves root index links against the docs route itself", () => {
    const compiled = compileMarkdown({
      source: "[Getting Started](./getting-started)",
      sourcePath: "content/docs/index.md",
    });

    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs",
      sourcePath: "content/docs/index.md",
    });

    expect(resolved.blocks[0]).toMatchObject({
      type: "paragraph",
      html: '<a href="/docs/getting-started">Getting Started</a>',
    });
  });

  it("resolves section index links against the section route", () => {
    const compiled = compileMarkdown({
      source: "[Node.js](./nodejs) and [Home](../getting-started)",
      sourcePath: "content/docs/quickstart/index.md",
    });

    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs/quickstart",
      sourcePath: "content/docs/quickstart/index.md",
    });

    const block = resolved.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain('href="/docs/quickstart/nodejs"');
      expect(block.html).toContain('href="/docs/getting-started"');
    }
  });

  it("resolves leaf page links against the parent route", () => {
    const compiled = compileMarkdown({
      source: "[Errors](./errors) and [Concepts](../core-concepts)",
      sourcePath: "content/docs/reference/envelopes.md",
    });

    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs/reference/envelopes",
      sourcePath: "content/docs/reference/envelopes.md",
    });

    const block = resolved.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain('href="/docs/reference/errors"');
      expect(block.html).toContain('href="/docs/core-concepts"');
    }
  });

  it("preserves absolute, hash, external, and special hrefs", () => {
    const compiled = compileMarkdown({
      source: [
        "[Absolute](/docs)",
        "[Hash](#intro)",
        "[External](https://example.com/docs)",
        "[Mail](mailto:hello@example.com)",
      ].join(" "),
      sourcePath: "content/docs/index.md",
    });

    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs",
      sourcePath: "content/docs/index.md",
    });

    const block = resolved.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain('href="/docs"');
      expect(block.html).toContain('href="#intro"');
      expect(block.html).toContain('href="https://example.com/docs"');
      expect(block.html).toContain('href="mailto:hello@example.com"');
    }
  });

  it("resolves root, query-only, and spaced href attributes without rewriting data-href", () => {
    const compiled = {
      ...compileMarkdown({ source: "text", sourcePath: "content/docs/page.md" }),
      blocks: [
        {
          type: "paragraph" as const,
          text: "links",
          html: '<a data-href="./wrong" href = "./child">child</a> <a href="?raw=1">raw</a>',
        },
      ],
    };
    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/",
      sourcePath: "content/docs/index.md",
    });
    expect((resolved.blocks[0] as { html: string }).html).toBe(
      '<a data-href="./wrong" href = "/child">child</a> <a href="/?raw=1">raw</a>'
    );

    const leaf = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs/page",
      sourcePath: "content/docs/page.md",
    });
    expect((leaf.blocks[0] as { html: string }).html).toContain('href="/docs/page?raw=1"');
  });

  it("resolves the real href when another attribute contains href text and normalizes query-only routes", () => {
    const compiled = {
      ...compileMarkdown({ source: "text", sourcePath: "content/docs/page.md" }),
      blocks: [
        {
          type: "paragraph" as const,
          text: "links",
          html: '<a data="href = decoy" href="./child">child</a> <a href="?raw=1">raw</a>',
        },
      ],
    };
    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "docs/page",
      sourcePath: "content/docs/page.md",
    });
    expect((resolved.blocks[0] as { html: string }).html).toContain('href="/docs/child"');
    expect((resolved.blocks[0] as { html: string }).html).toContain('data="href = decoy"');
    expect((resolved.blocks[0] as { html: string }).html).toContain('href="/docs/page?raw=1"');
  });

  it("preserves empty hrefs and quoted greater-than characters in relative anchors", () => {
    const compiled = {
      ...compileMarkdown({ source: "text", sourcePath: "content/docs/page.md" }),
      blocks: [
        {
          type: "paragraph" as const,
          text: "links",
          html: '<a href="">current</a> <a href="./a>b">child</a>',
        },
      ],
    };
    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs/page",
      sourcePath: "content/docs/page.md",
    });
    expect((resolved.blocks[0] as { html: string }).html).toContain('href=""');
    expect((resolved.blocks[0] as { html: string }).html).toContain('href="/docs/a%3Eb"');
  });

  it("leaves unterminated anchor openers unchanged", () => {
    const compiled = {
      ...compileMarkdown({ source: "text", sourcePath: "content/docs/page.md" }),
      blocks: [
        {
          type: "paragraph" as const,
          text: "links",
          html: '<a href="./never <a href="./also',
        },
      ],
    };
    const resolved = resolveMarkdownRelativeLinks({
      compiled,
      route: "/docs/page",
      sourcePath: "content/docs/page.md",
    });
    expect((resolved.blocks[0] as { html: string }).html).toBe(
      '<a href="./never <a href="./also'
    );
  });
});

it("rejects executable table HTML through the compiler", () => {
  expect(() => compileMarkdown({ source: "| X |\n| --- |\n| <svg/onload=alert(1)> |" })).toThrow(/unsafe HTML/);
});

it("sanitizes browser URL whitespace and slash handlers in trusted HTML tables", () => {
  const compiled = compileMarkdown({ source: '| X |\n| --- |\n| <svg/onload=alert(1)> <a href="java&#x09;script:alert(1)">click</a> |', allowRawHtml: true });
  const table = compiled.blocks.find((block) => block.type === "table");
  expect(table).toBeDefined();
  expect(JSON.stringify(table)).not.toMatch(/<svg\/onload=|java&#x09;script:/);
});

it('sanitizes unquoted executable URLs while preserving text and safe URL paths', () => {
  const result = compileMarkdown({ source: '<a href=javascript:alert(1)>click</a> /onload=text <a href="/onload=value">safe</a>', allowRawHtml: true });
  const text = JSON.stringify(result.blocks);
  expect(text).not.toContain('href=javascript:');
  expect(text).toContain('/onload=text');
  expect(text).toContain('/onload=value');
});
it('does not merge independent links into a forbidden scheme', () => {
  expect(() => compileMarkdown({ source: '[one](java)[two](script:foo) <a href="/onload=value">safe</a>' })).not.toThrow();
});

describe("shared component heading anchors and form URL policy", () => {
  it("shares heading slugs across page headings, components, and tabs", () => {
    const compiled = compileMarkdown({ source: '# Intro\n\n<Callout>\n\n## Intro\n\n</Callout>\n\n<DocsTabs items={["One"]}>\n<DocsTab value="One">\n\n## Intro\n\n</DocsTab>\n</DocsTabs>\n\n## Intro', sourcePath: 'anchors.mdx', components: { Callout: () => null, DocsTabs: () => null, DocsTab: () => null } });
    expect(compiled.headings.map((heading) => heading.slug)).toEqual(['intro', 'intro-1', 'intro-2', 'intro-3']);
    expect(compiled.toc).toEqual(compiled.headings);
  });
  it("rejects executable form URLs unless raw HTML is allowed, then neutralizes them", () => {
    const source = '<form action="javascript:alert(1)"><button formaction="java&#x73;cript:alert(2)">Go</button></form>';
    expect(() => compileMarkdown({ source })).toThrow();
    const compiled = compileMarkdown({ source, allowRawHtml: true });
    expect(compiled.blocks[0]).toMatchObject({ html: '<form action="#"><button formaction="#">Go</button></form>\n' });
  });
  it("preserves commented-out event-handler examples", () => {
    const source = '<!-- <a onclick="demo()">example</a> -->';
    expect(() => compileMarkdown({ source })).not.toThrow();
  });
});

it('rejects duplicate tab values before producing renderer artifacts', () => {
  expect(() => compileMarkdown({ sourcePath: 'tabs.mdx', source: '<DocsTabs>\n<DocsTab value="same">First</DocsTab>\n<DocsTab value="same">Second</DocsTab>\n</DocsTabs>' })).toThrow(/duplicate tab value/);
});

it.each([["./other.md?view=1#part", "/docs/other?view=1#part"], ["./guide/index.mdx", "/docs/guide/"], ["./getting-started/", "/docs/getting-started/"]])("resolves source links from manifest root IDs: %s", (href, expected) => {
  const compiled = compileMarkdown({ source: `[Link](${href})`, sourcePath: "docs:index.md" });
  const resolved = resolveMarkdownRelativeLinks({ compiled, route: "/docs", sourcePath: "docs:index.md" });
  expect(resolved.blocks[0]).toMatchObject({ html: `<a href="${expected}">Link</a>` });
});
