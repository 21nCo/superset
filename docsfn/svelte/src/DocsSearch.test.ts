import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let DocsSearch: typeof import("./DocsSearch.svelte").default;

const searchResults = [
  {
    id: "docs:intro",
    score: 10,
    scope: "docs",
    kind: "page",
    path: "/docs/getting-started",
    title: "Getting Started",
    summary: "Install and configure docsfn.",
  },
  {
    id: "collection:changelog:docsfn-v0-1-0.md",
    score: 9,
    scope: "changelog",
    kind: "post",
    path: "/changelog/docsfn-v0-1-0",
    title: "Docsfn v0.1.0 Changelog Foundation",
    summary: "Reusable changelog UI components.",
  },
] as const;

const searchRuntime = {
  ensureReady: vi.fn(async () => undefined),
  getScopes: vi.fn(async () => ["docs", "api", "blog", "changelog"]),
  query: vi.fn(),
};

beforeAll(async () => {
  DocsSearch = (await import("./DocsSearch.svelte")).default;
});

beforeEach(() => {
  window.history.pushState({}, "", "/docs/api/core");
  searchRuntime.query.mockReset();
  searchRuntime.query.mockImplementation(async ({ scope }: { scope: string }) =>
    searchResults.filter((result) => scope === "all" || result.scope === scope)
  );
});

afterEach(() => {
  cleanup();
});

describe("DocsSearch scope UI", () => {
  it("shows friendly scope filters and labels result scopes", async () => {
    render(DocsSearch, {
      props: {
        createSearchRuntime: () => searchRuntime,
        scopes: ["all", "docs", "api", "blog", "changelog"],
      },
    });

    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "API" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Changelog" })).toBeTruthy();

    await fireEvent.input(screen.getByLabelText("Search query"), {
      target: { value: "docsfn" },
    });

    await waitFor(() => {
      expect(screen.getByText("Docsfn v0.1.0 Changelog Foundation")).toBeTruthy();
    });
    expect(screen.getAllByText("Changelog").length).toBeGreaterThanOrEqual(2);
  });

  it("ignores stale results after the query is cleared", async () => {
    let resolveQuery: (value: typeof searchResults) => void = () => undefined;
    searchRuntime.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        })
    );

    render(DocsSearch, {
      props: {
        createSearchRuntime: () => searchRuntime,
        scopes: ["all", "docs", "api", "blog", "changelog"],
      },
    });

    await fireEvent.input(screen.getByLabelText("Search query"), {
      target: { value: "docsfn" },
    });
    await fireEvent.input(screen.getByLabelText("Search query"), {
      target: { value: "" },
    });
    resolveQuery([...searchResults]);

    await waitFor(() => {
      expect(screen.getByText("Start typing to search...")).toBeTruthy();
    });
    expect(screen.queryByText("Getting Started")).toBeNull();
  });

  it("filters by changelog scope and preserves embed mode on result hrefs", async () => {
    window.history.pushState({}, "", "/docs/api/core?embed=1");

    render(DocsSearch, {
      props: {
        createSearchRuntime: () => searchRuntime,
        scopes: ["all", "docs", "api", "blog", "changelog"],
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Changelog" }));
    await fireEvent.input(screen.getByLabelText("Search query"), {
      target: { value: "foundation" },
    });

    await waitFor(() => {
      expect(searchRuntime.query).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "changelog",
        })
      );
      expect(screen.getByText("Docsfn v0.1.0 Changelog Foundation")).toBeTruthy();
    });

    const result = screen.getByRole("button", {
      name: /Docsfn v0\.1\.0 Changelog Foundation/,
    });
    expect(result.getAttribute("data-href")).toBe("/changelog/docsfn-v0-1-0?embed=1");
  });
});

it("derives filters from an explicit search artifact", () => {
  render(DocsSearch, { props: { searchArtifact: { scopes: ["docs"] } as any, createSearchRuntime: () => searchRuntime } });
  expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "API" })).toBeNull();
});
it("updates filters after loading a search artifact", async () => {
  render(DocsSearch, { props: {
    loadSearchArtifact: async () => ({ scopes: ["docs"] } as any),
    createSearchRuntime: input => ({ ...searchRuntime, query: async () => { await input.loadArtifact!(); return []; } }),
  } });
  await fireEvent.input(screen.getByLabelText("Search query"), { target: { value: "query" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "API" })).toBeNull();
});
