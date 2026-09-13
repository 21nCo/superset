import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { compileReactContent } from "@docsfn/core";
import { vi } from "vitest";
import { DocsContent } from "./DocsContent";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-fixtures/repo"
);

async function readFixture(relativePath: string): Promise<string> {
  return readFile(resolve(FIXTURE_ROOT, relativePath), "utf8");
}

describe("DocsContent", () => {
  it("renders canonical tabs recursively without raw-source fallback (TV-REACT-001)", async () => {
    const source = await readFixture("datafn-docs/content/docs/documentation/server/routes.mdx");
    const compiled = compileReactContent({
      source,
      sourcePath: "content/docs/documentation/server/routes.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(<DocsContent compiled={compiled} />);

    const tablist = screen.getByRole("tablist", { name: "Tabs" });
    expect(tablist).toBeTruthy();
    expect(screen.getByRole("tabpanel").textContent).toContain("createDatafnServer");
    expect(screen.getByRole("tabpanel").textContent).not.toContain("<Tab value=");

    fireEvent.click(screen.getByRole("tab", { name: "Python (FastAPI)" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/FastAPI/)).toBeTruthy();
    expect(panel.textContent).not.toContain("<Tabs");
  });

  it("renders mermaid through the explicit renderer contract", async () => {
    const source = await readFixture("searchfn-docs/content/docs/architecture.mdx");
    const compiled = compileReactContent({
      source,
      sourcePath: "content/docs/architecture.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(
      <DocsContent
        compiled={compiled}
        renderMermaid={(block) => (
          <div data-rendered-mermaid={block.id}>
            <span>{block.code}</span>
          </div>
        )}
      />
    );

    const mermaid = document.querySelector("[data-rendered-mermaid]");
    expect(mermaid).toBeTruthy();
    expect(mermaid?.textContent).toContain("graph TD");
    expect(document.querySelector("pre[data-docsfn-mermaid='true']")).toBeNull();
  });

  it("renders mapped custom components with normalized props and compiled children", () => {
    const compiled = compileReactContent({
      source: `import { DemoCard } from "./DemoCard";\n\n<DemoCard tone="caution">\n## Nested\n\nChild body\n</DemoCard>`,
      sourcePath: "content/docs/demo-card.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(
      <DocsContent
        compiled={compiled}
        components={{
          DemoCard: ({ children, tone }) => (
            <section data-demo-card={String(tone)}>{children}</section>
          ),
        }}
      />
    );

    const demoCard = document.querySelector("[data-demo-card='caution']");
    expect(demoCard).toBeTruthy();
    expect(within(demoCard as HTMLElement).getByRole("heading", { name: "Nested" })).toBeTruthy();
    expect(within(demoCard as HTMLElement).getByText("Child body")).toBeTruthy();
  });

  it("renders built-in YouTube embeds without custom component wiring", () => {
    const compiled = compileReactContent({
      source: `<YouTube id="SeWdndc7y4A" title="Intro video" />`,
      sourcePath: "content/docs/quickstart.mdx",
      compatPreset: "none",
    });

    render(<DocsContent compiled={compiled} />);

    const iframe = document.querySelector(
      "[data-docsfn-youtube-embed='true'] iframe"
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.src).toContain("youtube-nocookie.com/embed/SeWdndc7y4A");
    expect(iframe?.title).toBe("Intro video");
  });

  it("fails closed on unresolved component mappings", () => {
    const compiled = compileReactContent({
      source: `import { DemoCard } from "./DemoCard";\n\n<DemoCard>\nChild body\n</DemoCard>`,
      sourcePath: "content/docs/demo-card.mdx",
      compatPreset: "fumadocs-v15",
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => render(<DocsContent compiled={compiled} />)).toThrowError(
        /DOCS_COMPONENT_UNRESOLVED|component DemoCard is not resolved/
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
