import { describe, expect, it } from "vitest";
import { buildAutoSidebar } from "./sidebar";
import type { DocPage } from "./types";

function createPage(overrides: Partial<DocPage> & { id: string; slug: string; path: string; title: string }): DocPage {
  return {
    kind: "page",
    id: overrides.id,
    slug: overrides.slug,
    path: overrides.path,
    title: overrides.title,
    description: overrides.description,
    body: overrides.body ?? "",
    headings: overrides.headings ?? [],
    frontmatter: overrides.frontmatter ?? {},
    version: overrides.version,
  };
}

describe("buildAutoSidebar", () => {
  it("creates deterministic flat links for root-level pages", () => {
    const sidebar = buildAutoSidebar([
      createPage({
        id: "intro",
        slug: "intro",
        path: "/docs/intro",
        title: "Introduction",
      }),
      createPage({
        id: "getting-started",
        slug: "getting-started",
        path: "/docs/getting-started",
        title: "Getting Started",
      }),
    ]);

    expect(sidebar.items).toEqual([
      { type: "link", text: "Getting Started", link: "/docs/getting-started" },
      { type: "link", text: "Introduction", link: "/docs/intro" },
    ]);
  });

  it("keeps nested index routes as section parents", () => {
    const sidebar = buildAutoSidebar([
      createPage({
        id: "home",
        slug: "",
        path: "/docs",
        title: "Home",
      }),
      createPage({
        id: "reference-index",
        slug: "reference",
        path: "/docs/reference",
        title: "Reference",
      }),
      createPage({
        id: "reference-client",
        slug: "reference/client",
        path: "/docs/reference/client",
        title: "Client",
      }),
      createPage({
        id: "reference-server",
        slug: "reference/server",
        path: "/docs/reference/server",
        title: "Server",
      }),
    ]);

    expect(sidebar.items[0]).toEqual({
      type: "link",
      text: "Home",
      link: "/docs",
    });
    expect(sidebar.items[1]).toMatchObject({
      type: "group",
      text: "Reference",
    });
    expect(sidebar.items[1].items).toEqual([
      { type: "link", text: "Reference", link: "/docs/reference" },
      { type: "link", text: "Client", link: "/docs/reference/client" },
      { type: "link", text: "Server", link: "/docs/reference/server" },
    ]);
  });

  it("handles deep hierarchy with stable group ordering", () => {
    const sidebar = buildAutoSidebar([
      createPage({
        id: "api-core-types",
        slug: "api/core/types",
        path: "/docs/api/core/types",
        title: "Types",
      }),
      createPage({
        id: "api-core-utils",
        slug: "api/core/utils",
        path: "/docs/api/core/utils",
        title: "Utilities",
      }),
      createPage({
        id: "api-providers-fs",
        slug: "api/providers/fs",
        path: "/docs/api/providers/fs",
        title: "Filesystem Provider",
      }),
    ]);

    expect(sidebar.items).toHaveLength(1);
    expect(sidebar.items[0]).toMatchObject({
      type: "group",
      text: "Api",
    });
    expect(sidebar.items[0].items?.map((item) => item.text)).toEqual([
      "Core",
      "Providers",
    ]);
  });

  it("returns empty items for empty page input", () => {
    const sidebar = buildAutoSidebar([]);
    expect(sidebar).toEqual({ id: "default", items: [] });
  });
});
