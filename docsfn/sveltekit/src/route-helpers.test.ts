import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest, buildOpenApiReference, loadDocsConfig, type DocsManifest } from "../../core/src/index";
import { FsContentProvider } from "../../provider-fs/src/index";
import {
  generateApiParams as generateNextApiParams,
  generateCollectionParams as generateNextCollectionParams,
  generateStaticParams as generateNextStaticParams,
  getCollectionPostData as getNextCollectionPostData,
  getCollectionPosts as getNextCollectionPosts,
  resolveDocsPageSurface as resolveNextDocsPageSurface,
  resolveDocsRouteDataOrThrow as resolveNextDocsRouteDataOrThrow,
  resolveEmbedMode as resolveNextEmbedMode,
  resolveEmbedSidebarMode as resolveNextEmbedSidebarMode,
} from "../../next/src/route-helpers";
import {
  createPageLoad,
  generateCollectionParams,
  generateStaticParams,
  getCollectionPostData,
  getCollectionPosts,
  getPostData,
  resolveDocsPageSurface,
  resolveDocsRouteDataOrThrow,
  resolveEmbedMode,
  resolveEmbedSidebarMode,
} from "./route-helpers";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const canonicalFixtureRoot = path.resolve(
  thisDirectory,
  "../../test-fixtures/repo/searchfn-docs"
);

let manifestPromise: Promise<DocsManifest> | null = null;

async function loadCanonicalManifest(): Promise<DocsManifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const config = await loadDocsConfig({
        cwd: canonicalFixtureRoot,
      });

      const provider = new FsContentProvider({
        root: canonicalFixtureRoot,
      });

      return buildManifest(provider, config);
    })();
  }

  return manifestPromise;
}

function createDatedCollectionManifest(): DocsManifest {
  const blogPost = {
    kind: "post" as const,
    id: "blog:introducing-docsfn.md",
    collectionId: "blog",
    collectionLabel: "Blog",
    searchScope: "blog",
    slug: "introducing-docsfn",
    path: "/blog/introducing-docsfn",
    title: "Introducing docsfn",
    date: "2026-03-22",
    publishedAt: "2026-03-22T00:00:00.000Z",
    excerpt: "Launch notes",
    summary: "Launch notes",
    tags: [],
    body: "Blog body",
    frontmatter: {},
  };
  const draftBlogPost = {
    ...blogPost,
    id: "blog:draft.md",
    slug: "draft",
    path: "/blog/draft",
    title: "Draft",
    draft: true,
  };
  const changelogPost = {
    kind: "post" as const,
    id: "collection:changelog:docsfn-v0-1-0.md",
    collectionId: "changelog",
    collectionLabel: "Changelog",
    searchScope: "changelog",
    slug: "docsfn-v0-1-0",
    path: "/changelog/docsfn-v0-1-0",
    title: "Docsfn v0.1.0",
    date: "2026-07-10",
    publishedAt: "2026-07-10T00:00:00.000Z",
    excerpt: "Changelog foundation",
    summary: "Changelog foundation",
    tags: [],
    body: "Changelog body",
    frontmatter: {},
  };

  return {
    site: {
      title: "docsfn",
    },
    topNav: [],
    pages: {},
    posts: {
      [blogPost.id]: blogPost,
      [draftBlogPost.id]: draftBlogPost,
      [changelogPost.id]: changelogPost,
    },
    apis: {},
    sidebars: {},
    routes: {
      [blogPost.path]: blogPost.id,
      [changelogPost.path]: changelogPost.id,
    },
    blog: {
      listRoute: "/blog",
      feedPath: "/blog/rss.xml",
      postOrder: [draftBlogPost.id, blogPost.id],
      tags: {},
      archives: [],
    },
    collections: {
      blog: {
        id: "blog",
        label: "Blog",
        scope: "blog",
        listRoute: "/blog",
        feedPath: "/blog/rss.xml",
        postOrder: [draftBlogPost.id, blogPost.id],
        tags: {},
        archives: [],
      },
      changelog: {
        id: "changelog",
        label: "Changelog",
        scope: "changelog",
        listRoute: "/changelog",
        feedPath: "/changelog/rss.xml",
        postOrder: [changelogPost.id],
        tags: {},
        archives: [],
      },
    },
  };
}

describe("sveltekit route helper parity", () => {
  it("matches Next docs route resolution for root and nested slugs (TV-ROUTE-001)", async () => {
    const manifest = await loadCanonicalManifest();
    const cases: Array<string | string[] | undefined> = [
      undefined,
      "reference/client",
      ["reference", "client"],
    ];

    for (const slug of cases) {
      const nextEntry = resolveNextDocsRouteDataOrThrow(slug, manifest, {
        basePath: "/docs",
      });
      const svelteEntry = resolveDocsRouteDataOrThrow(slug, manifest, {
        basePath: "/docs",
      });

      expect(svelteEntry.kind).toBe(nextEntry.kind);
      expect(svelteEntry.route).toBe(nextEntry.route);
      if (svelteEntry.kind === "page" && nextEntry.kind === "page") {
        expect(svelteEntry.page.title).toBe(nextEntry.page.title);
      }
    }
  });

  it("matches Next static-param semantics for canonical fixture routes (TV-SVELTE-001)", async () => {
    const manifest = await loadCanonicalManifest();

    const nextParams = generateNextStaticParams(manifest, {
      basePath: "/docs",
      includeApiRoutes: true,
    });
    const svelteParams = generateStaticParams(manifest, {
      basePath: "/docs",
      includeApiRoutes: true,
    });

    const normalizedNext = nextParams.map((param) =>
      param.slug && param.slug.length > 0 ? { slug: param.slug.join("/") } : {}
    );

    expect(svelteParams).toEqual(normalizedNext);
    expect(svelteParams[0]).toEqual({});
  });

  it("keeps dated collection helpers scoped across SvelteKit and Next adapters", () => {
    const manifest = createDatedCollectionManifest();

    expect(getCollectionPosts("blog", manifest).map((post) => post.slug)).toEqual([
      "introducing-docsfn",
    ]);
    expect(getCollectionPosts("changelog", manifest).map((post) => post.slug)).toEqual([
      "docsfn-v0-1-0",
    ]);
    expect(getCollectionPosts("blog", manifest, { includeDrafts: true }).map((post) => post.slug))
      .toEqual(["draft", "introducing-docsfn"]);

    expect(getPostData("docsfn-v0-1-0", manifest)).toBeNull();
    expect(getCollectionPostData("changelog", "docsfn-v0-1-0", manifest)?.path).toBe(
      "/changelog/docsfn-v0-1-0"
    );
    expect(generateCollectionParams("changelog", manifest)).toEqual([
      { slug: "docsfn-v0-1-0" },
    ]);

    expect(getNextCollectionPosts("blog", manifest).map((post) => post.slug)).toEqual([
      "introducing-docsfn",
    ]);
    expect(getNextCollectionPostData("changelog", "/docsfn-v0-1-0", manifest)?.path).toBe(
      "/changelog/docsfn-v0-1-0"
    );
    expect(generateNextCollectionParams("changelog", manifest)).toEqual([
      { slug: "docsfn-v0-1-0" },
    ]);
  });

  it("resolves embed mode query params across SvelteKit and Next request shapes", () => {
    expect(resolveEmbedMode(null)).toBe(false);
    expect(resolveEmbedMode(undefined)).toBe(false);
    expect(resolveEmbedMode(new URL("https://example.com/docs?embed=1"))).toBe(true);
    expect(resolveEmbedMode(new URL("https://example.com/docs?embed=true"))).toBe(true);
    expect(resolveEmbedMode(new URL("https://example.com/docs?embed"))).toBe(true);
    expect(resolveEmbedMode(new URL("https://example.com/docs?embed=0"))).toBe(false);
    expect(resolveEmbedMode(new URL("https://example.com/docs"))).toBe(false);

    expect(resolveNextEmbedMode(null)).toBe(false);
    expect(resolveNextEmbedMode(undefined)).toBe(false);
    expect(resolveNextEmbedMode({ embed: "yes" })).toBe(true);
    expect(resolveNextEmbedMode({ searchParams: { embed: ["0", "1"] } })).toBe(true);
    expect(resolveNextEmbedMode({ searchParams: { embed: "false" } })).toBe(false);
    expect(resolveNextEmbedMode({ searchParams: { docsEmbed: "on" } }, { param: "docsEmbed" }))
      .toBe(true);
  });

  it("resolves optional embedded sidebar query params across SvelteKit and Next request shapes", () => {
    expect(resolveEmbedSidebarMode(new URL("https://example.com/docs?embed=1&showSidebar=1")))
      .toBe(true);
    expect(resolveEmbedSidebarMode(new URL("https://example.com/docs?embed=1&showSidebar=false")))
      .toBe(false);
    expect(resolveEmbedSidebarMode(new URL("https://example.com/docs?embed=1&showsidebar=true")))
      .toBe(true);
    expect(resolveEmbedSidebarMode(new URL("https://example.com/docs?embed=1&sidebar=on")))
      .toBe(true);
    expect(resolveEmbedSidebarMode(new URL("https://example.com/docs?embed=1"))).toBe(false);

    expect(resolveNextEmbedSidebarMode({ searchParams: { showSidebar: ["0", "1"] } })).toBe(true);
    expect(resolveNextEmbedSidebarMode({ searchParams: { showSidebar: "false" } })).toBe(false);
    expect(
      resolveNextEmbedSidebarMode(
        { searchParams: { docsSidebar: "yes" } },
        { param: "docsSidebar" }
      )
    ).toBe(true);
  });

  it("derives page surface metadata with parity to Next helper output (TV-PAGE-001 + TV-NAV-001)", async () => {
    const manifest = await loadCanonicalManifest();
    const route = "/docs/reference/client";
    const entry = resolveDocsRouteDataOrThrow("reference/client", manifest, {
      basePath: "/docs",
    });

    if (entry.kind !== "page") {
      throw new Error(`expected page route entry for ${route}`);
    }

    const nextSurface = resolveNextDocsPageSurface({
      manifest,
      route,
      page: entry.page,
      options: {
        basePath: "/docs",
        homeHref: "/docs",
        versionMode: "path-prefix",
      },
    });

    const svelteSurface = resolveDocsPageSurface({
      manifest,
      route,
      page: entry.page,
      options: {
        basePath: "/docs",
        homeHref: "/docs",
        versionMode: "path-prefix",
      },
    });

    expect(svelteSurface.breadcrumbs).toEqual(nextSurface.breadcrumbs);
    expect(svelteSurface.pagination).toEqual(nextSurface.pagination);
    expect(svelteSurface.topNav).toEqual(nextSurface.topNav);
    expect(svelteSurface.canonicalPath).toBe(nextSurface.canonicalPath);
  });

  it("createPageLoad resolves root route when params.slug is undefined", async () => {
    const manifest = await loadCanonicalManifest();
    const load = createPageLoad(manifest, {
      basePath: "/docs",
      homeHref: "/docs",
    });

    const data = load({
      params: {},
    } as never);

    expect(data.route).toBe("/docs");
    expect(data.page.path).toBe("/docs");
    expect(data.surface.route).toBe("/docs");
  });
});

it("retains root-base docs routes in both static parameter adapters", async () => {
  const manifest = structuredClone(await loadCanonicalManifest());
  manifest.routes = Object.fromEntries(Object.entries(manifest.routes).map(([route, id]) => [route.replace(/^\/docs(?=\/|$)/, "") || "/", id]));
  for (const generate of [generateStaticParams, generateNextStaticParams]) {
    const params = generate(manifest, { basePath: "/" });
    expect(params).toContainEqual({});
  }
});
it("does not assign hidden docs to the default sidebar", async () => {
  const manifest = structuredClone(await loadCanonicalManifest());
  manifest.sidebars = { default: { id: "default", items: [] } };
  const page = Object.values(manifest.pages)[0];
  for (const resolve of [resolveDocsPageSurface, resolveNextDocsPageSurface]) {
    expect(resolve({ manifest, route: page.path, page }).sidebarId).toBeUndefined();
  }
});
it("supports catch-all Next collection parameters and lookup", async () => {
  const manifest = structuredClone(await loadCanonicalManifest());
  const post = Object.values(manifest.posts)[0];
  post.slug = "releases/v1";
  expect(generateNextCollectionParams("blog", manifest, { catchAll: true })).toContainEqual({ slug: ["releases", "v1"] });
  expect(getNextCollectionPostData("blog", ["releases", "v1"], manifest)?.id).toBe(post.id);
});

it('emits every OpenAPI child route as a Next catch-all parameter', async () => {
  const manifest = structuredClone(await loadCanonicalManifest());
  const spec = buildOpenApiReference({ sourceId: 'api:x.json', sourcePath: 'x.json', fallbackTitle: 'X', body: JSON.stringify({ openapi: '3.0.3', info: { title: 'X', version: '1' }, paths: { '/items': { get: { responses: {} } } } }) });
  manifest.apis = { x: { kind: 'api', id: 'x', slug: 'x', path: spec.routes.overview, title: spec.title, frontmatter: {}, spec } };
  const params = generateNextApiParams(manifest, { catchAll: true });
  expect(params).toEqual([{ slug: ['x'] }, { slug: ['x', 'operations', 'get-items'] }, { slug: ['x', 'tags', 'default'] }]);
  manifest.apis.x.slug = '';
  expect(generateNextApiParams(manifest, { catchAll: true })).toEqual([{}, { slug: ['operations', 'get-items'] }, { slug: ['tags', 'default'] }]);

});
