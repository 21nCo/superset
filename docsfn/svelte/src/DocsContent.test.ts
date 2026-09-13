import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSvelteContent } from "@docsfn/core/browser";
import ApiReferenceRenderer from "./ApiReferenceRenderer.svelte";
import DocsContent from "./DocsContent.svelte";
import EmbeddedPage from "./EmbeddedPage.svelte";
import { handlePaginationShortcut } from "./navigation";
import Pagination from "./Pagination.svelte";
import TestCard from "./test-utils/TestCard.svelte";
import TestMermaid from "./test-utils/TestMermaid.svelte";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/repo");

async function readFixture(relativePath: string): Promise<string> {
  return readFile(resolve(FIXTURE_ROOT, relativePath), "utf8");
}

const SUPPORTED_PUBLIC_IMPORTS = [
  "@docsfn/svelte/ApiReferenceRenderer.svelte",
  "@docsfn/svelte/Breadcrumbs.svelte",
  "@docsfn/svelte/ChangelogEntry.svelte",
  "@docsfn/svelte/ChangelogList.svelte",
  "@docsfn/svelte/DatedCollectionEntry.svelte",
  "@docsfn/svelte/DatedCollectionList.svelte",
  "@docsfn/svelte/DocsContent.svelte",
  "@docsfn/svelte/DocsLayout.svelte",
  "@docsfn/svelte/DocsSearch.svelte",
  "@docsfn/svelte/DocsSidebar.svelte",
  "@docsfn/svelte/DocsToc.svelte",
  "@docsfn/svelte/EmbeddedPage.svelte",
  "@docsfn/svelte/Pagination.svelte",
  "@docsfn/svelte/SidebarGroup.svelte",
  "@docsfn/svelte/TopBar.svelte",
  "@docsfn/svelte/VersionSwitcher.svelte",
  "@docsfn/svelte/YouTubeEmbed.svelte",
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DocsContent", () => {
  it("renders canonical tabs recursively without raw-source fallback (TV-SVELTE-001)", async () => {
    const source = await readFixture("datafn-docs/content/docs/documentation/server/routes.mdx");
    const compiled = compileSvelteContent({
      source,
      sourcePath: "content/docs/documentation/server/routes.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(DocsContent, {
      compiled,
    });

    const tablist = screen.getByRole("tablist", { name: "Tabs" });
    expect(tablist).toBeTruthy();
    expect(screen.getByRole("tabpanel").textContent).toContain("createDatafnServer");
    expect(screen.getByRole("tabpanel").textContent).not.toContain("<Tab value=");

    await fireEvent.click(screen.getByRole("tab", { name: "Python (FastAPI)" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/FastAPI/)).toBeTruthy();
    expect(panel.textContent).not.toContain("<Tabs");
  });

  it("renders mermaid through the explicit renderer contract", async () => {
    const source = await readFixture("searchfn-docs/content/docs/architecture.mdx");
    const compiled = compileSvelteContent({
      source,
      sourcePath: "content/docs/architecture.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(DocsContent, {
      compiled,
      renderMermaid: TestMermaid,
    });

    const mermaid = document.querySelector("[data-rendered-mermaid]");
    expect(mermaid).toBeTruthy();
    expect(mermaid?.textContent).toContain("graph TD");
    expect(document.querySelector("pre[data-docsfn-mermaid='true']")).toBeNull();
  });

  it("renders mapped custom components with normalized props and compiled children", () => {
    const compiled = compileSvelteContent({
      source: `import { DemoCard } from "./DemoCard";\n\n<DemoCard tone="caution">\n## Nested\n\nChild body\n</DemoCard>`,
      sourcePath: "content/docs/demo-card.mdx",
      compatPreset: "fumadocs-v15",
    });

    render(DocsContent, {
      compiled,
      components: {
        DemoCard: TestCard,
      },
    });

    const demoCard = document.querySelector("[data-test-card='caution']");
    expect(demoCard).toBeTruthy();
    expect(within(demoCard as HTMLElement).getByRole("heading", { name: "Nested" })).toBeTruthy();
    expect(within(demoCard as HTMLElement).getByText("Child body")).toBeTruthy();
  });

  it("renders built-in YouTube embeds without custom component wiring", () => {
    const compiled = compileSvelteContent({
      source: `<YouTube id="SeWdndc7y4A" title="Intro video" />`,
      sourcePath: "content/docs/quickstart.mdx",
      compatPreset: "none",
    });

    render(DocsContent, {
      compiled,
    });

    const iframe = document.querySelector(
      "[data-docsfn-youtube-embed='true'] iframe"
    ) as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    expect(iframe?.src).toContain("youtube-nocookie.com/embed/SeWdndc7y4A");
    expect(iframe?.title).toBe("Intro video");
  });

  it("fails closed on unresolved component mappings", () => {
    const compiled = compileSvelteContent({
      source: `import { DemoCard } from "./DemoCard";\n\n<DemoCard>\nChild body\n</DemoCard>`,
      sourcePath: "content/docs/demo-card.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(() =>
      render(DocsContent, {
        compiled,
      })
    ).toThrowError(/DOCS_COMPONENT_UNRESOLVED|component DemoCard is not resolved/);
  });

  it("renders blog surfaces without raw-source fallback", async () => {
    render(DocsContent, {
      content: "# SearchFn v1.2 Release\n\nThis release introduces deterministic manifest and search artifacts.",
      sourcePath: "content/blog/alpha.mdx",
      compatPreset: "fumadocs-v15",
    });
    expect(document.body.textContent).toContain("SearchFn v1.2 Release");
    expect(document.body.textContent).not.toContain("<Tabs");
  });

  it("renders embedded surfaces without raw-source fallback", async () => {
    const embeddedSource = await readFixture("datafn-docs/content/docs/documentation/server/routes.mdx");

    render(EmbeddedPage, {
      title: "Server Routes",
      description: "Embedded surface",
      content: embeddedSource,
      headings: [{ id: "server-routes", slug: "server-routes", text: "Server Routes", level: 2 }],
      compatPreset: "fumadocs-v15",
    });

    expect(document.querySelector("[data-docsfn-embedded-page='true']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-tabs='true']")).toBeTruthy();
    expect(document.querySelector(".docs-example-content")).toBeNull();
  });

  it("renders API surfaces through ApiReferenceRenderer", () => {
    render(ApiReferenceRenderer, {
      api: {
        kind: "api",
        id: "api:index.json",
        slug: "",
        path: "/docs/api",
        title: "Search API",
        frontmatter: {},
        spec: {
          info: {
            title: "Search API",
            version: "1.0.0",
          },
          operations: [
            {
              id: "get:/search",
              method: "GET",
              path: "/search",
              routePath: "/docs/api/operations/get-search",
              parameters: [],
              responses: [{ statusCode: "200", description: "ok", content: [] }],
            },
          ],
          schemas: [],
          tags: [],
        },
      },
    });

    expect(screen.getByText("Search API")).toBeTruthy();
    expect(screen.getByText("/docs/api/operations/get-search")).toBeTruthy();
  });

  it("supports keyboard search interaction and pagination shortcuts", async () => {
    const { default: DocsSearch } = await import("./DocsSearch.svelte");

    render(DocsSearch, {
      analytics: { enabled: false },
    });

    await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByLabelText("Search query");
    await fireEvent.input(input, { target: { value: "getting" } });

    await waitFor(() => {
      expect(screen.getByText('No results found for "getting"')).toBeTruthy();
    });

    render(Pagination, {
      prevPage: { title: "Prev", path: "/docs/prev" },
      nextPage: { title: "Next", path: "/docs/next" },
    });

    expect(document.querySelector("[rel='next']")).toBeTruthy();

    const navigate = vi.fn();
    const handled = handlePaginationShortcut({
      event: new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }),
      nextPage: { path: "/docs/next" },
      navigate,
    });

    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/docs/next");
  });

  it("resolves supported public component subpaths and rejects internal source paths", async () => {
    for (const specifier of SUPPORTED_PUBLIC_IMPORTS) {
      const module = await import(/* @vite-ignore */ specifier);
      expect(module.default).toBeTruthy();
    }

    const invalidSpecifier = ["@docsfn", "svelte", "src/DocsContent.svelte"].join("/");
    await expect(import(/* @vite-ignore */ invalidSpecifier)).rejects.toThrow();
  });
});
