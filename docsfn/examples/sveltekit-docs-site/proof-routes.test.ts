import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  buildSearchIndex,
  createDocsSearchRuntime,
  type DocsCompatPreset,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import DocsPage from "./src/routes/docs/[...slug]/+page.svelte";
import { load as loadDocsPage } from "./src/routes/docs/[...slug]/+page.server";
import BlogPage from "./src/routes/blog/[...slug]/+page.svelte";
import { load as loadBlogPage } from "./src/routes/blog/[...slug]/+page.server";
import EmbeddedDocsPage from "./src/routes/embedded/[...slug]/+page.svelte";
import { load as loadEmbeddedPage } from "./src/routes/embedded/[...slug]/+page.server";
import proofRoutes from "../proof-routes.json";

interface DocsSiteSource {
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
  compatPreset: DocsCompatPreset;
}

async function buildSearchProbe(
  searchArtifact: DocsSearchArtifact
): Promise<DocsSiteSource["searchProbe"]> {
  const probeQuery =
    searchArtifact.documents.find((document) => document.title.trim().length > 0)?.title ??
    searchArtifact.documents[0]?.summary ??
    "docs";
  const runtime = createDocsSearchRuntime({
    artifact: searchArtifact,
  });
  const results = await runtime.query({
    query: probeQuery,
    limit: 5,
  });

  return {
    query: probeQuery,
    resultCount: results.length,
    firstPath: results[0]?.path,
    scopes: [...searchArtifact.scopes],
  };
}

async function loadFixtureSource(fixtureRoot: string): Promise<DocsSiteSource> {
  const provider = new FsContentProvider({
    root: fixtureRoot,
  });
  const { loadDocsConfig } = await import("@docsfn/core");
  const config = await loadDocsConfig({
    cwd: fixtureRoot,
  });
  const manifest = await buildManifest(provider, config);
  const searchArtifact = await buildSearchIndex(manifest, {
    search: config.search,
  });
  const searchProbe = await buildSearchProbe(searchArtifact);

  return {
    fixtureRoot,
    manifest,
    searchArtifact,
    searchProbe,
    siteTitle: config.site.title,
    canonicalUrl: config.site.canonicalUrl,
    compatPreset: config.compat?.preset ?? "none",
  };
}

async function createApiProofSource(): Promise<DocsSiteSource> {
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
  const searchProbe = await buildSearchProbe(searchArtifact);

  return {
    fixtureRoot: "/synthetic/api-proof",
    manifest,
    searchArtifact,
    searchProbe,
    siteTitle: "Proof Docs",
    canonicalUrl: "https://example.com",
    compatPreset: "fumadocs-v15",
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SvelteKit proof routes", () => {
  it("keeps the shared SvelteKit proof-route inventory stable", () => {
    const svelteRoutes = proofRoutes.routes
      .filter((route) => route.framework === "sveltekit")
      .map((route) => `${route.id}:${route.surface}:${route.routePattern}`);

    expect(svelteRoutes).toEqual([
      "sveltekit-api:api:/docs/api/{...slug}",
      "sveltekit-blog:blog:/blog/{slug}",
      "sveltekit-docs:docs:/docs/{...slug}",
      "sveltekit-embedded:embedded:/embedded/{...slug}",
    ]);
  });

  it("renders docs proof routes through DocsContent for the datafn fixture", async () => {
    const source = await loadFixtureSource("../../test-fixtures/repo/datafn-docs");
    const data = await loadDocsPage({
      params: {
        slug: ["documentation", "server", "routes"],
      },
      parent: async () => ({ source }),
    } as never);

    render(DocsPage, { data });

    expect(document.querySelector("[data-docsfn-proof-surface='docs']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-search-runtime='true']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-tabs='true']")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
    expect(document.querySelector(".docs-example-content")).toBeNull();
    expect(document.body.textContent).not.toContain("<Tabs");
  });

  it("renders blog proof routes through DocsContent for the searchfn fixture", async () => {
    const source = await loadFixtureSource("../../test-fixtures/repo/searchfn-docs");
    const data = await loadBlogPage({
      params: {
        slug: "alpha",
      },
      parent: async () => ({ source }),
    } as never);

    render(BlogPage, { data: { ...data, source } });

    expect(document.querySelector("[data-docsfn-blog-post='true']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-proof-surface='blog']")).toBeTruthy();
    expect(document.querySelector(".docsfn-content")).toBeTruthy();
    expect(document.querySelector(".docs-example-content")).toBeNull();
  });

  it("renders embedded proof routes through EmbeddedPage for the datafn fixture", async () => {
    const source = await loadFixtureSource("../../test-fixtures/repo/datafn-docs");
    const data = await loadEmbeddedPage({
      params: {
        slug: "documentation/server/routes",
      },
      parent: async () => ({ source }),
    } as never);

    render(EmbeddedDocsPage, { data: { ...data, source } });

    expect(document.querySelector("[data-docsfn-proof-surface='embedded']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-embedded-page='true']")).toBeTruthy();
    expect(document.querySelector("[data-docsfn-tabs='true']")).toBeTruthy();
    expect(document.querySelector(".docs-example-content")).toBeNull();
  });

  it("renders api proof routes through ApiReferenceRenderer", async () => {
    const source = await createApiProofSource();
    const data = await loadDocsPage({
      params: {
        slug: ["api", "search"],
      },
      parent: async () => ({ source }),
    } as never);

    render(DocsPage, { data });

    expect(document.querySelector("[data-docsfn-proof-surface='api']")).toBeTruthy();
    expect(document.querySelector(".docsfn-api-reference")).toBeTruthy();
    expect(screen.getByText("/docs/api/operations/get-search")).toBeTruthy();
    expect(document.querySelector(".docs-example-content")).toBeNull();
  });
});
