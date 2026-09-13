import { describe, expect, it } from "vitest";
import {
  buildSidebars,
  flattenSidebarLinks,
  resolveBreadcrumbsFromSidebar,
  resolvePaginationFromSidebar,
  resolveSidebarForRoute,
} from "./navigation";
import type { MetaDocument, NormalizedPageRecord } from "./normalize";
import type { DocsConfig } from "./types";

function createConfig(overrides: Partial<DocsConfig> = {}): DocsConfig {
  return {
    schemaVersion: 1,
    site: {
      title: "SearchFn Docs",
      basePath: "/docs",
      ...(overrides.site ?? {}),
    },
    compat: {
      preset: "fumadocs-v15",
      ...(overrides.compat ?? {}),
    },
    content: {
      root: "/repo/searchfn-docs",
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
      ...(overrides.content ?? {}),
    },
    versions: overrides.versions,
    navigation: overrides.navigation,
    search: overrides.search,
    auth: overrides.auth,
    analytics: overrides.analytics,
  };
}

function createPage(input: {
  id: string;
  sourcePath: string;
  path: string;
  title: string;
}): NormalizedPageRecord {
  const segments = input.sourcePath.split("/");
  return {
    id: input.id,
    collection: "docs",
    sourcePath: input.sourcePath,
    sourceDirectory: segments.slice(0, -1).join("/"),
    sourceName: segments[segments.length - 1] ?? "index",
    slug: input.sourcePath.replace(/\/index$/, ""),
    path: input.path,
    title: input.title,
    body: "",
    headings: [],
    frontmatter: {},
  };
}

function mapMeta(entries: MetaDocument[]): Map<string, MetaDocument> {
  return new Map(entries.map((entry) => [entry.directory, entry]));
}

describe("navigation", () => {
  it("honors meta.json sibling ordering (TV-NAV-001)", () => {
    const pages: NormalizedPageRecord[] = [
      createPage({ id: "docs:index", sourcePath: "index", path: "/docs", title: "SearchFn" }),
      createPage({
        id: "docs:getting-started",
        sourcePath: "getting-started",
        path: "/docs/getting-started",
        title: "Getting Started",
      }),
      createPage({
        id: "docs:architecture",
        sourcePath: "architecture",
        path: "/docs/architecture",
        title: "Architecture",
      }),
      createPage({
        id: "docs:reference:index",
        sourcePath: "reference/index",
        path: "/docs/reference",
        title: "Reference",
      }),
      createPage({
        id: "docs:reference:client",
        sourcePath: "reference/client",
        path: "/docs/reference/client",
        title: "Client",
      }),
      createPage({
        id: "docs:integrations:datafn",
        sourcePath: "integrations/datafn",
        path: "/docs/integrations/datafn",
        title: "DataFn",
      }),
      createPage({
        id: "docs:operations:setup",
        sourcePath: "operations/setup",
        path: "/docs/operations/setup",
        title: "Setup",
      }),
    ];

    const metaByDirectory = mapMeta([
      {
        directory: "",
        title: "SearchFn",
        pages: [
          { key: "index" },
          {
            key: "getting-started",
            icon: "rocket",
            badge: "New",
            description: "Start building",
          },
          { key: "architecture" },
          { key: "reference" },
          { key: "integrations" },
          { key: "operations" },
        ],
      },
      {
        directory: "reference",
        title: "Reference",
        pages: [{ key: "index" }, { key: "client" }],
      },
    ]);

    const sidebars = buildSidebars({
      pages,
      metaByDirectory,
      config: createConfig(),
    });

    expect(sidebars.default.items.map((item) => item.text)).toEqual([
      "SearchFn",
      "Getting Started",
      "Architecture",
      "Reference",
      "Integrations",
      "Operations",
    ]);
    expect(sidebars.default.items[1]).toMatchObject({
      icon: "rocket",
      badge: "New",
      description: "Start building",
    });
  });

  it("supports meta.root flattening and hidden entries", () => {
    const pages: NormalizedPageRecord[] = [
      createPage({ id: "docs:index", sourcePath: "index", path: "/docs", title: "Home" }),
      createPage({
        id: "docs:reference:index",
        sourcePath: "reference/index",
        path: "/docs/reference",
        title: "Reference Home",
      }),
      createPage({
        id: "docs:reference:client",
        sourcePath: "reference/client",
        path: "/docs/reference/client",
        title: "Client",
      }),
      createPage({
        id: "docs:reference:server",
        sourcePath: "reference/server",
        path: "/docs/reference/server",
        title: "Server",
      }),
    ];

    const metaByDirectory = mapMeta([
      {
        directory: "",
        pages: [{ key: "index" }, { key: "reference" }],
      },
      {
        directory: "reference",
        title: "Reference",
        root: true,
        pages: [
          { key: "index" },
          { key: "client", hidden: true },
          { key: "server" },
        ],
      },
    ]);

    const sidebars = buildSidebars({
      pages,
      metaByDirectory,
      config: createConfig(),
    });

    const links = flattenSidebarLinks(sidebars.default).map((entry) => entry.path);
    expect(links).toEqual(["/docs", "/docs/reference", "/docs/reference/server"]);
    expect(sidebars.default.items.map((item) => item.text)).toContain("Reference");
  });

  it("throws DOCS_META_INVALID for unknown meta.json references", () => {
    const pages: NormalizedPageRecord[] = [
      createPage({ id: "docs:index", sourcePath: "index", path: "/docs", title: "Home" }),
    ];

    const metaByDirectory = mapMeta([
      {
        directory: "",
        pages: [{ key: "index" }, { key: "missing-page" }],
      },
    ]);

    expect(() =>
      buildSidebars({
        pages,
        metaByDirectory,
        config: createConfig(),
      })
    ).toThrowError(/DOCS_META_INVALID|missing-page/);
  });

  it("builds multiple sidebars and resolves breadcrumbs/pagination from active tree", () => {
    const pages: NormalizedPageRecord[] = [
      createPage({ id: "docs:index", sourcePath: "index", path: "/docs", title: "Home" }),
      createPage({
        id: "docs:getting-started",
        sourcePath: "getting-started",
        path: "/docs/getting-started",
        title: "Getting Started",
      }),
      createPage({
        id: "docs:operations:setup",
        sourcePath: "operations/setup",
        path: "/docs/operations/setup",
        title: "Setup",
      }),
      createPage({
        id: "docs:operations:troubleshooting",
        sourcePath: "operations/troubleshooting",
        path: "/docs/operations/troubleshooting",
        title: "Troubleshooting",
      }),
    ];
    const sidebars = buildSidebars({
      pages,
      metaByDirectory: mapMeta([
        {
          directory: "",
          pages: [{ key: "index" }, { key: "getting-started" }, { key: "operations" }],
        },
      ]),
      config: createConfig({
        navigation: {
          sidebars: {
            operations: {
              include: ["docs/operations/**"],
            },
          },
        },
      }),
    });

    expect(Object.keys(sidebars).sort()).toEqual(["default", "operations"]);
    expect(
      flattenSidebarLinks(sidebars.operations).map((entry) => entry.path)
    ).toEqual(["/docs/operations/setup", "/docs/operations/troubleshooting"]);

    const sidebarId = resolveSidebarForRoute({
      sidebars,
      route: "/docs/operations/setup",
    });
    expect(sidebarId).toBe("operations");

    const breadcrumbs = resolveBreadcrumbsFromSidebar({
      sidebar: sidebars.default,
      route: "/docs/operations/setup",
    });
    expect(breadcrumbs.map((crumb) => crumb.label)).toEqual(["Home", "Operations", "Setup"]);

    const pagination = resolvePaginationFromSidebar({
      sidebar: sidebars.default,
      route: "/docs/operations/setup",
    });
    expect(pagination.prev?.path).toBe("/docs/getting-started");
    expect(pagination.next?.path).toBe("/docs/operations/troubleshooting");
  });
});
