import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { buildSearchIndex, type DocsManifest } from "@docsfn/core";
import { DocsSearch } from "./DocsSearch";
import { navigateTo } from "./navigation";

vi.mock("./navigation", () => ({
  navigateTo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

function createManifest(): DocsManifest {
  return {
    site: {
      title: "Search Docs",
    },
    pages: {
      "docs:guide": {
        kind: "page",
        id: "docs:guide",
        slug: "guides/search",
        path: "/docs/guides/search",
        title: "Search Guide",
        description: "Guide for search",
        body: "# Search Guide\n\nGuide body",
        headings: [{ level: 1, text: "Search Guide", slug: "search-guide" }],
        frontmatter: {},
      },
    },
    posts: {
      "blog:release": {
        kind: "post",
        id: "blog:release",
        slug: "release-1",
        path: "/docs/blog/release-1",
        title: "Search Release",
        date: "2026-03-01",
        excerpt: "Release highlights",
        summary: "Release summary",
        tags: ["release"],
        body: "Search blog body",
        frontmatter: {},
      },
    },
    apis: {
      "api:search": {
        kind: "api",
        id: "api:search",
        slug: "search",
        path: "/docs/api/search",
        title: "Search API",
        spec: {
          info: {
            title: "Search API",
            description: "API for search",
          },
        },
        frontmatter: {},
      },
    },
    sidebars: {},
    routes: {},
  };
}

describe("DocsSearch", () => {
  it("supports keyboard open, scope filtering, result display, and keyboard selection", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
      },
    });

    render(<DocsSearch searchArtifact={artifact} />);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          ctrlKey: true,
          key: "k",
        })
      );
    });

    const input = await screen.findByRole("textbox", { name: "Search query" });
    const apiScope = screen.getByRole("button", { name: "API" });
    const allScope = screen.getByRole("button", { name: "All" });
    expect(screen.queryByRole("button", { name: "Changelog" })).toBeNull();
    fireEvent.change(input, { target: { value: "search" } });

    await screen.findByText("Search API");
    await screen.findByText("Search Guide");

    const resultButtons = screen.getAllByRole("button").filter((element) =>
      element.className.includes("docsfn-search-item")
    );
    expect(resultButtons.length).toBeGreaterThanOrEqual(2);
    expect(resultButtons[0]?.textContent).toContain("/docs/");
    expect(resultButtons[0]?.textContent).toContain("Search");

    fireEvent.click(apiScope);
    await waitFor(() => {
      expect(screen.getByText("Search API")).toBeTruthy();
      expect(screen.queryByText("Search Guide")).toBeNull();
    });

    fireEvent.click(allScope);
    await waitFor(() => {
      expect(screen.getByText("Search API")).toBeTruthy();
      expect(screen.getByText("Search Guide")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "ArrowDown" });
    const selectedButtons = screen.getAllByRole("button").filter((element) =>
      element.getAttribute("data-selected") === "true"
    );
    expect(selectedButtons).toHaveLength(1);

    const selectedPath = selectedButtons[0]?.textContent?.match(/\/docs\/[^\s<]+/)?.[0];
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });

    expect(navigateTo).toHaveBeenCalledWith(selectedPath);
  });

  it("does not copy embedded search params onto external result URLs", async () => {
    const manifest = createManifest();
    manifest.pages["docs:guide"].path = "https://external.example.com/search-guide";
    const artifact = await buildSearchIndex(manifest, {
      search: {
        enabled: true,
        scopes: ["docs"],
      },
    });
    window.history.replaceState({}, "", "/docs?embed=1");

    render(<DocsSearch searchArtifact={artifact} />);
    fireEvent.click(screen.getByRole("button", { name: "Search documentation" }));
    const input = await screen.findByRole("textbox", { name: "Search query" });
    fireEvent.change(input, { target: { value: "search guide" } });
    fireEvent.click(await screen.findByText("Search Guide"));

    expect(navigateTo).toHaveBeenCalledWith(
      "https://external.example.com/search-guide"
    );
  });

it('reruns a populated search when the artifact is replaced', async () => {
  const manifest = createManifest();
  const first = await buildSearchIndex(manifest, { search: { enabled: true, scopes: ['docs'] } });
  const view = render(<DocsSearch searchArtifact={first} />);
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'k' })));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search query' }), { target: { value: 'search' } });
  await screen.findByText('Search Guide');
  manifest.pages['docs:guide'].title = 'Search Updated';
  const next = await buildSearchIndex(manifest, { search: { enabled: true, scopes: ['docs'] } });
  view.rerender(<DocsSearch searchArtifact={next} />);
  await screen.findByText('Search Updated');
  expect(screen.queryByText('Search Guide')).toBeNull();
});
it('retains a valid initial scope until a lazy artifact resolves', async () => {
  const artifact = await buildSearchIndex(createManifest(), { search: { enabled: true, scopes: ['docs', 'api'] } });
  render(<DocsSearch loadSearchArtifact={async () => artifact} initialScope="api" scopes={[]} />);
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'k' })));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search query' }), { target: { value: 'search' } });
  await screen.findByText('Search API');
  expect(screen.queryByText('Search Guide')).toBeNull();
});


  it("derives artifact scopes when the explicit list is empty", async () => {
    const artifact = await buildSearchIndex(createManifest(), { search: { enabled: true, scopes: ["docs", "api"] } });
    render(<DocsSearch searchArtifact={artifact} scopes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Search documentation" }));
    expect(screen.getByRole("button", { name: "API" })).toBeTruthy();
  });
});
