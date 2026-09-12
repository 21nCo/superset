import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchIndex,
  createDocsSearchRuntime,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import proofRoutes from "../proof-routes.json";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

async function renderFixtureRoute<TModule>(input: {
  fixtureRoot: string;
  load: () => Promise<TModule>;
  render: (module: TModule) => Promise<React.ReactElement>;
}): Promise<string> {
  process.env.DOCSFN_FIXTURE_ROOT = input.fixtureRoot;
  vi.resetModules();
  const module = await input.load();
  const element = await input.render(module);
  return renderToStaticMarkup(element);
}

async function createApiProofSource(): Promise<{
  fixtureRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  searchProbe: {
    query: string;
    resultCount: number;
    firstPath?: string;
    scopes: string[];
  };
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: "fumadocs-v15";
}> {
  const manifest: DocsManifest = {
    site: {
      title: "Proof Docs",
    },
    pages: {},
    posts: {},
    apis: {
      "api:search": {
        kind: "api",
        id: "api:search",
        slug: "api/search",
        path: "/docs/api/search",
        title: "Search API",
        frontmatter: {},
        spec: {
          info: {
            title: "Search API",
            version: "1.0.0",
            description: "Synthetic API surface for proof-route testing",
          },
          operations: [
            {
              id: "get:/search",
              method: "GET",
              methodLower: "get",
              path: "/search",
              routePath: "/docs/api/operations/get-search",
              summary: "Search documents",
              parameters: [],
              responses: [{ statusCode: "200", description: "ok", content: [] }],
            },
          ],
          schemas: [],
          tags: [],
        },
      },
    },
    sidebars: {
      default: {
        id: "default",
        items: [
          {
            type: "link",
            text: "Search API",
            link: "/docs/api/search",
          },
        ],
      },
    },
    routes: {
      "/docs/api/search": "api:search",
    },
  };

  const searchArtifact = await buildSearchIndex(manifest, {
    search: {
      enabled: true,
      scopes: ["api"],
    },
  });
  const runtime = createDocsSearchRuntime({
    artifact: searchArtifact,
  });
  const searchProbeResults = await runtime.query({
    query: "Search API",
    limit: 5,
  });

  return {
    fixtureRoot: "/synthetic/api-proof",
    manifest,
    searchArtifact,
    searchProbe: {
      query: "Search API",
      resultCount: searchProbeResults.length,
      firstPath: searchProbeResults[0]?.path,
      scopes: [...searchArtifact.scopes],
    },
    siteTitle: "Proof Docs",
    canonicalUrl: "https://example.com",
    compatPreset: "fumadocs-v15",
  };
}

afterEach(() => {
  delete process.env.DOCSFN_FIXTURE_ROOT;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("Next proof routes", () => {
  it("keeps the shared Next proof-route inventory stable", () => {
    const nextRoutes = proofRoutes.routes
      .filter((route) => route.framework === "next")
      .map((route) => `${route.id}:${route.surface}:${route.routePattern}`);

    expect(nextRoutes).toEqual([
      "next-api:api:/docs/api/{...slug}",
      "next-blog:blog:/blog/{slug}",
      "next-docs:docs:/docs/{...slug}",
      "next-embedded:embedded:/embedded/{...slug}",
    ]);
  });

  it("renders docs proof routes through DocsContent for the datafn fixture", async () => {
    const html = await renderFixtureRoute({
      fixtureRoot: "../../test-fixtures/repo/datafn-docs",
      load: () => import("./app/docs/[[...slug]]/page.tsx"),
      render: async (module: { default: (props: { params: Promise<{ slug: string[] }> }) => Promise<React.ReactElement> }) =>
        module.default({
          params: Promise.resolve({
            slug: ["documentation", "server", "routes"],
          }),
        }),
    });

    expect(html).toContain('data-docsfn-proof-surface="docs"');
    expect(html).toContain('data-docsfn-search-runtime="true"');
    expect(html).toContain('data-docsfn-tabs="true"');
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain('class="docs-example-content"');
    expect(html).not.toContain("&lt;Tabs");
  });

  it("renders blog proof routes through DocsContent for the searchfn fixture", async () => {
    const html = await renderFixtureRoute({
      fixtureRoot: "../../test-fixtures/repo/searchfn-docs",
      load: () => import("./app/blog/[...slug]/page.tsx"),
      render: async (module: { default: (props: { params: Promise<{ slug: string }> }) => Promise<React.ReactElement> }) =>
        module.default({
          params: Promise.resolve({
            slug: "alpha",
          }),
        }),
    });

    expect(html).toContain('data-docsfn-blog-post="true"');
    expect(html).toContain('data-docsfn-proof-surface="blog"');
    expect(html).toContain('class="docsfn-content"');
    expect(html).not.toContain('class="docs-example-content"');
  });

  it("renders embedded proof routes through EmbeddedPage for the datafn fixture", async () => {
    const html = await renderFixtureRoute({
      fixtureRoot: "../../test-fixtures/repo/datafn-docs",
      load: () => import("./app/embedded/[[...slug]]/page.tsx"),
      render: async (module: { default: (props: { params: Promise<{ slug: string[] }> }) => Promise<React.ReactElement> }) =>
        module.default({
          params: Promise.resolve({
            slug: ["documentation", "server", "routes"],
          }),
        }),
    });

    expect(html).toContain('data-docsfn-proof-surface="embedded"');
    expect(html).toContain('data-docsfn-embedded-page="true"');
    expect(html).toContain('data-docsfn-tabs="true"');
    expect(html).not.toContain('class="docs-example-content"');
  });

  it("renders api proof routes through ApiReferenceRenderer", async () => {
    const source = await createApiProofSource();

    vi.resetModules();
    vi.doMock("@/source.config", () => ({
      loadDocsSiteSource: async () => source,
    }));

    const module = await import("./app/docs/[[...slug]]/page.tsx");
    const html = renderToStaticMarkup(
      await module.default({
        params: Promise.resolve({
          slug: ["api", "search"],
        }),
      })
    );

    expect(html).toContain('data-docsfn-proof-surface="api"');
    expect(html).toContain("docsfn-api-reference");
    expect(html).toContain("/docs/api/operations/get-search");
    expect(html).not.toContain('class="docs-example-content"');
  });
});
