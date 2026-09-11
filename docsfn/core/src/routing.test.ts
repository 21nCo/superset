import { describe, expect, it } from "vitest";
import {
  assertRouteAvailability,
  buildDocsStaticParams,
  buildRoute,
} from "./routing";
import type { DocsConfig } from "./types";

function createConfig(overrides: Partial<DocsConfig> = {}): DocsConfig {
  return {
    schemaVersion: 1,
    site: {
      title: "Test Docs",
      basePath: "/docs",
      ...(overrides.site ?? {}),
    },
    compat: {
      preset: "none",
      ...(overrides.compat ?? {}),
    },
    content: {
      root: "/repo/site",
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

describe("routing", () => {
  it("maps root and nested index pages to canonical routes (TV-ROUTE-001)", () => {
    const config = createConfig();

    const root = buildRoute({
      collection: "docs",
      sourcePath: "index",
      config,
    });
    const nestedIndex = buildRoute({
      collection: "docs",
      sourcePath: "reference/index",
      config,
    });
    const leaf = buildRoute({
      collection: "docs",
      sourcePath: "reference/client",
      config,
    });

    expect(root.path).toBe("/docs");
    expect(nestedIndex.path).toBe("/docs/reference");
    expect(leaf.path).toBe("/docs/reference/client");

    const params = buildDocsStaticParams({
      routes: [root.path, nestedIndex.path, leaf.path],
      basePath: "/docs",
      versions: config.versions,
    });

    expect(params).toEqual([
      {},
      { slug: ["reference"] },
      { slug: ["reference", "client"] },
    ]);
  });

  it("throws DOCS_ROUTE_CONFLICT when multiple entries claim the same route", () => {
    const routes = new Map<string, string>();
    assertRouteAvailability({
      routes,
      path: "/docs/reference",
      sourceId: "docs:reference/index.mdx",
    });
    routes.set("/docs/reference", "docs:reference/index.mdx");

    expect(() =>
      assertRouteAvailability({
        routes,
        path: "/docs/reference",
        sourceId: "docs:reference.mdx",
      })
    ).toThrowError(/DOCS_ROUTE_CONFLICT|claimed by multiple source entries/);
  });

  it("derives deterministic versioned routes and static params (TV-ROUTE-002)", () => {
    const config = createConfig({
      versions: {
        mode: "path-prefix",
        versions: [
          { slug: "v1", label: "Version 1", default: true },
          { slug: "v2", label: "Version 2" },
        ],
      },
    });

    const v1 = buildRoute({
      collection: "docs",
      sourcePath: "v1/getting-started",
      config,
    });
    const v2 = buildRoute({
      collection: "docs",
      sourcePath: "v2/getting-started",
      config,
    });

    expect(v1.path).toBe("/docs/v1/getting-started");
    expect(v2.path).toBe("/docs/v2/getting-started");

    const params = buildDocsStaticParams({
      routes: [v1.path, v2.path],
      basePath: "/docs",
      versions: config.versions,
    });

    expect(params).toEqual([
      { version: "v1", slug: ["getting-started"] },
      { version: "v2", slug: ["getting-started"] },
    ]);
  });

  it("places the version at the end in path-segment mode", () => {
    const config = createConfig({
      versions: {
        mode: "path-segment",
        versions: [
          { slug: "v1", label: "Version 1", default: true },
          { slug: "v2", label: "Version 2" },
        ],
      },
    });

    const defaulted = buildRoute({
      collection: "docs",
      sourcePath: "getting-started",
      config,
    });
    const explicit = buildRoute({
      collection: "docs",
      sourcePath: "getting-started/v2",
      config,
    });

    expect(defaulted.path).toBe("/docs/getting-started/v1");
    expect(explicit.path).toBe("/docs/getting-started/v2");

    const params = buildDocsStaticParams({
      routes: [defaulted.path, explicit.path],
      basePath: "/docs",
      versions: config.versions,
    });

    expect(params).toEqual([
      { version: "v1", slug: ["getting-started"] },
      { version: "v2", slug: ["getting-started"] },
    ]);
  });

  it("keeps a leading version-like slug in path-segment mode when version comes from frontmatter", () => {
    const config = createConfig({
      versions: {
        mode: "path-segment",
        versions: [
          { slug: "v1", label: "Version 1", default: true },
          { slug: "v2", label: "Version 2" },
        ],
      },
    });

    const routed = buildRoute({
      collection: "docs",
      sourcePath: "v2/intro",
      frontmatter: { version: "v2" },
      config,
    });

    expect(routed.path).toBe("/docs/v2/intro/v2");
  });

  it("fails with DOCS_VERSION_INVALID when version mode has no default", () => {
    const config = createConfig({
      versions: {
        mode: "path-prefix",
        versions: [{ slug: "v1", label: "Version 1" }],
      },
    });

    expect(() =>
      buildRoute({
        collection: "docs",
        sourcePath: "v1/getting-started",
        config,
      })
    ).toThrowError(/DOCS_VERSION_INVALID|default version/);
  });

  it("fails on duplicated version segment during normalization", () => {
    const config = createConfig({
      versions: {
        mode: "path-prefix",
        versions: [
          { slug: "v1", label: "Version 1", default: true },
          { slug: "v2", label: "Version 2" },
        ],
      },
    });

    expect(() =>
      buildRoute({
        collection: "docs",
        sourcePath: "v2/v2/getting-started",
        config,
      })
    ).toThrowError(/DOCS_VERSION_INVALID|duplicated/);
  });
});

it.each(['path-prefix', 'path-segment'] as const)('rejects conflicting frontmatter in %s', (mode) => {
  const config = createConfig({ versions: { mode, versions: [{ slug: 'v1', label: 'V1', default: true }, { slug: 'v2', label: 'V2' }] } });
  expect(() => buildRoute({ collection: 'docs', sourcePath: mode === 'path-prefix' ? 'v1/page' : 'page/v1', frontmatter: { version: 'v2' }, config })).toThrow(/version/i);
});
