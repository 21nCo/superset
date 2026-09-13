import { cleanup, render, screen } from "@testing-library/svelte";
import type { Sidebar } from "@docsfn/core/browser";
import { afterEach, describe, expect, it } from "vitest";
import DocsLayout from "./DocsLayout.svelte";

const sidebar: Sidebar = {
  id: "docs",
  items: [
    {
      type: "group",
      text: "Getting Started",
      items: [{ type: "link", text: "Installation", link: "/docs/installation" }],
    },
  ],
};

afterEach(() => {
  cleanup();
});

describe("DocsLayout", () => {
  it("can show the sidebar inside embedded mode when requested", () => {
    render(DocsLayout, {
      embedded: true,
      showSidebar: true,
      sidebar,
      preservedSearchParams: {
        embed: "1",
        showSidebar: "1",
      },
    });

    expect(screen.getByRole("navigation", { name: "Documentation navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Installation" }).getAttribute("href")).toBe(
      "/docs/installation?embed=1&showSidebar=1"
    );
  });
});
