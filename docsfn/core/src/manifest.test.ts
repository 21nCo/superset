import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";
import { resolveOpenApiRoute } from "./openapi";
import { createNamedCollection, createSourceEntryId, isNamedCollection } from "./provider";
import { buildSearchIndex } from "./search";
import type {
  DocsCollection,
  DocsConfig,
  DocsContentProvider,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsSourceEntry,
  RawContentEntry,
} from "./types";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-fixtures/repo"
);

function createConfig(overrides: Partial<DocsConfig> = {}): DocsConfig {
  return {
    schemaVersion: 1,
    site: {
      title: "Fixture Docs",
      basePath: "/docs",
      ...(overrides.site ?? {}),
    },
    compat: {
      preset: "fumadocs-v15",
      ...(overrides.compat ?? {}),
    },
    versions: overrides.versions,
    content: {
      root: "/repo/docs",
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
      ...(overrides.content ?? {}),
    },
    navigation: overrides.navigation,
    collections: overrides.collections,
    blog: overrides.blog,
    search: overrides.search,
    auth: overrides.auth,
    analytics: overrides.analytics,
  };
}

class InMemorySourceProvider implements DocsContentProvider {
  readonly providerId = "in-memory";

  constructor(private readonly entries: DocsSourceEntry[]) {}

  async listEntries(input: DocsProviderListEntriesInput): Promise<DocsSourceEntry[]> {
    const collections = new Set<DocsCollection>(input.collections);
    return this.entries.filter((entry) => collections.has(entry.collection));
  }

  async loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry> {
    return input.entry;
  }

  async list(): Promise<RawContentEntry[]> {
    return this.entries
      .filter((entry) => entry.entryType !== "control")
      .map((entry) => ({
        id: entry.relativePath,
        kind:
          entry.collection === "blog" || isNamedCollection(entry.collection)
            ? "post"
            : entry.collection === "api"
              ? "api"
              : "page",
        body: entry.body ?? "",
        frontmatter: entry.frontmatter,
      }));
  }
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const block = content.slice(4, end);
  const body = content.slice(end + 5);
  const frontmatter: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    if (value === "true") {
      frontmatter[key] = true;
      continue;
    }
    if (value === "false") {
      frontmatter[key] = false;
      continue;
    }
    frontmatter[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return {
    frontmatter,
    body,
  };
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(fullPath)));
      continue;
    }
    result.push(fullPath);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function loadFixtureDocsEntries(
  fixtureName: string
): Promise<DocsSourceEntry[]> {
  const docsRoot = resolve(FIXTURE_ROOT, fixtureName, "content/docs");
  const files = await walkFiles(docsRoot);
  const entries: DocsSourceEntry[] = [];

  for (const filePath of files) {
    const relativePath = filePath.slice(docsRoot.length + 1).replaceAll("\\", "/");
    const content = await readFile(filePath, "utf8");

    if (relativePath.endsWith("meta.json")) {
      entries.push({
        id: createSourceEntryId("docs", relativePath),
        collection: "docs",
        relativePath,
        absolutePath: filePath,
        entryType: "control",
        frontmatter: {},
        body: content,
      });
      continue;
    }

    if (!relativePath.endsWith(".md") && !relativePath.endsWith(".mdx")) {
      continue;
    }

    const parsed = parseFrontmatter(content);
    entries.push({
      id: createSourceEntryId("docs", relativePath),
      collection: "docs",
      relativePath,
      absolutePath: filePath,
      entryType: "content",
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }

  return entries;
}

function routesFromManifest(manifest: Awaited<ReturnType<typeof buildManifest>>): string[] {
  return Object.keys(manifest.routes).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );
}

describe("buildManifest", () => {
  it("builds canonical routes for root and nested index pages (TV-ROUTE-001)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home" },
        body: "# Home",
      },
      {
        id: createSourceEntryId("docs", "reference/index.mdx"),
        collection: "docs",
        relativePath: "reference/index.mdx",
        entryType: "content",
        frontmatter: { title: "Reference" },
        body: "# Reference",
      },
      {
        id: createSourceEntryId("docs", "reference/client.mdx"),
        collection: "docs",
        relativePath: "reference/client.mdx",
        entryType: "content",
        frontmatter: { title: "Client" },
        body: "# Client",
      },
    ]);

    const manifest = await buildManifest(provider, createConfig());

    expect(manifest.routes["/docs"]).toBe("docs:index.mdx");
    expect(manifest.routes["/docs/reference"]).toBe("docs:reference/index.mdx");
    expect(manifest.routes["/docs/reference/client"]).toBe("docs:reference/client.mdx");
  });

  it("is deterministic regardless of provider entry order (DET-001)", async () => {
    const entries: DocsSourceEntry[] = [
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home" },
        body: "# Home",
      },
      {
        id: createSourceEntryId("docs", "getting-started.mdx"),
        collection: "docs",
        relativePath: "getting-started.mdx",
        entryType: "content",
        frontmatter: { title: "Getting Started" },
        body: "# Getting Started",
      },
      {
        id: createSourceEntryId("docs", "meta.json"),
        collection: "docs",
        relativePath: "meta.json",
        entryType: "control",
        frontmatter: {},
        body: JSON.stringify({ pages: ["index", "getting-started"] }),
      },
    ];
    const providerA = new InMemorySourceProvider(entries);
    const providerB = new InMemorySourceProvider([...entries].reverse());

    const manifestA = await buildManifest(providerA, createConfig());
    const manifestB = await buildManifest(providerB, createConfig());

    expect(JSON.stringify(manifestA)).toBe(JSON.stringify(manifestB));
  });

  it("passes top navigation through to the manifest (NAV-002)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home" },
        body: "# Home",
      },
    ]);

    const manifest = await buildManifest(
      provider,
      createConfig({
        navigation: {
          topNav: [
            { label: "Docs", href: "/docs" },
            { label: "GitHub", href: "https://github.com/21nCo/super-functions", external: true },
          ],
        },
      })
    );

    expect(manifest.topNav).toEqual([
      { label: "Docs", href: "/docs" },
      { label: "GitHub", href: "https://github.com/21nCo/super-functions", external: true },
    ]);
  });

  it("uses a configured metadata filename when normalizing navigation", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home" },
        body: "# Home",
      },
      {
        id: createSourceEntryId("docs", "_nav.json"),
        collection: "docs",
        relativePath: "_nav.json",
        entryType: "control",
        frontmatter: {},
        body: JSON.stringify({ pages: ["index"] }),
      },
    ]);

    const manifest = await buildManifest(
      provider,
      createConfig({ content: { root: "/repo/docs", metaFileName: "_nav.json" } })
    );
    expect(manifest.sidebars.default.items.map((item) => item.text)).toEqual(["Home"]);
  });

  it("throws DOCS_ROUTE_CONFLICT for duplicate route claims", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "reference/index.mdx"),
        collection: "docs",
        relativePath: "reference/index.mdx",
        entryType: "content",
        frontmatter: { title: "Reference" },
        body: "# Reference",
      },
      {
        id: createSourceEntryId("docs", "reference.mdx"),
        collection: "docs",
        relativePath: "reference.mdx",
        entryType: "content",
        frontmatter: { title: "Reference File" },
        body: "# Reference File",
      },
    ]);

    await expect(buildManifest(provider, createConfig())).rejects.toThrowError(
      /DOCS_ROUTE_CONFLICT|claimed by multiple source entries/
    );
  });

  it("throws DOCS_VERSION_INVALID when version config has no default", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "v1/getting-started.mdx"),
        collection: "docs",
        relativePath: "v1/getting-started.mdx",
        entryType: "content",
        frontmatter: { title: "Getting Started" },
        body: "# Getting Started",
      },
    ]);

    await expect(
      buildManifest(
        provider,
        createConfig({
          versions: {
            mode: "path-prefix",
            versions: [{ slug: "v1", label: "Version 1" }],
          },
        })
      )
    ).rejects.toThrowError(/DOCS_VERSION_INVALID|default version/);
  });

  it("throws DOCS_META_INVALID for orphaned meta references", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home" },
        body: "# Home",
      },
      {
        id: createSourceEntryId("docs", "meta.json"),
        collection: "docs",
        relativePath: "meta.json",
        entryType: "control",
        frontmatter: {},
        body: JSON.stringify({ pages: ["index", "missing-page"] }),
      },
    ]);

    await expect(buildManifest(provider, createConfig())).rejects.toThrowError(
      /DOCS_META_INVALID|missing-page/
    );
  });

  it("builds fixture-compatible navigation for searchfn-docs (TV-MIG-001 + TV-NAV-001)", async () => {
    const entries = await loadFixtureDocsEntries("searchfn-docs");
    const manifest = await buildManifest(new InMemorySourceProvider(entries), createConfig());

    const routes = routesFromManifest(manifest);
    expect(routes).toContain("/docs");
    expect(routes).toContain("/docs/reference/adapters");
    expect(routes).toContain("/docs/operations/setup");
    expect(
      manifest.sidebars.default.items.map((item) => item.text)
    ).toEqual([
      "SearchFn",
      "Getting Started",
      "Architecture",
      "Reference",
      "Integrations",
      "Operations",
    ]);
  });

  it("builds fixture-compatible navigation for datafn-docs (TV-MIG-001)", async () => {
    const entries = await loadFixtureDocsEntries("datafn-docs");
    const manifest = await buildManifest(new InMemorySourceProvider(entries), createConfig());
    const routes = routesFromManifest(manifest);
    const labels = manifest.sidebars.default.items.map((item) => item.text);

    expect(routes).toContain("/docs");
    expect(routes).toContain("/docs/documentation/server/routes");
    expect(routes).toContain("/docs/reference/server/routes");
    expect(labels[0]).toBe("DataFn");
    expect(labels).toContain("Documentation");
    expect(labels).toContain("DFQL");
    expect(labels).toContain("CLI");
    expect(labels).toContain("Reference");
    expect(labels).toContain("Concepts");
    expect(labels).toContain("@datafn/core");
    expect(labels.indexOf("Documentation")).toBeLessThan(labels.indexOf("DFQL"));
    expect(labels.indexOf("DFQL")).toBeLessThan(labels.indexOf("CLI"));
    expect(labels.indexOf("CLI")).toBeLessThan(labels.indexOf("Reference"));
  });

  it("normalizes API specs and derives routeable API pages (TV-API-001 + TV-API-002)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("api", "index.json"),
        collection: "api",
        relativePath: "index.json",
        entryType: "content",
        frontmatter: { title: "Search API" },
        body: JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "Search API",
            version: "1.0.0",
            description: "Search endpoints",
          },
          paths: {
            "/index": {
              post: {
                tags: ["indexing"],
                summary: "Index a document",
                responses: {
                  "202": { description: "accepted" },
                },
              },
            },
          },
          components: {
            schemas: {
              IndexRequest: {
                type: "object",
                description: "Index payload",
              },
            },
          },
        }),
      },
    ]);

    const manifest = await buildManifest(provider, createConfig());
    const apiReference = manifest.apis["api:index.json"];

    expect(apiReference.path).toBe("/docs/api");
    expect(manifest.routes["/docs/api"]).toBe("api:index.json");
    expect(manifest.routes["/docs/api/tags/indexing"]).toBe("api:index.json");
    expect(manifest.routes["/docs/api/operations/post-index"]).toBe("api:index.json");
    expect(apiReference.spec.operations.map((operation: { method: string; path: string }) => `${operation.method} ${operation.path}`)).toEqual(["POST /index"]);
    expect(apiReference.spec.spec.paths["/index"]).toBeDefined();

    expect(
      resolveOpenApiRoute(
        apiReference.spec,
        "/docs/api/operations/post-index"
      )
    ).toMatchObject({
      kind: "operation",
    });
  });

  it("fails with DOCS_ROUTE_NOT_FOUND for missing derived API routes (TV-API-002 negative)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("api", "index.json"),
        collection: "api",
        relativePath: "index.json",
        entryType: "content",
        frontmatter: { title: "Search API" },
        body: JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "Search API",
            version: "1.0.0",
          },
          paths: {
            "/index": {
              post: {
                responses: {
                  "202": { description: "accepted" },
                },
              },
            },
          },
        }),
      },
    ]);

    const manifest = await buildManifest(provider, createConfig());
    const apiReference = manifest.apis["api:index.json"];

    expect(() =>
      resolveOpenApiRoute(apiReference.spec, "/docs/api/operations/get-missing")
    ).toThrowError(/DOCS_ROUTE_NOT_FOUND|was not generated/);
  });

  it("normalizes blog routes/tags and excludes drafts while deriving embedded surfaces (TV-BLOG-001 + TV-EMBED-001)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "reference/client.mdx"),
        collection: "docs",
        relativePath: "reference/client.mdx",
        entryType: "content",
        frontmatter: { title: "Client API" },
        body: "# Client API\n\n## Install\n\n## Use",
      },
      {
        id: createSourceEntryId("blog", "alpha.mdx"),
        collection: "blog",
        relativePath: "alpha.mdx",
        entryType: "content",
        frontmatter: {
          title: "Alpha",
          date: "2026-03-01",
          tags: ["release"],
        },
        body: "# Alpha\n\nAlpha release notes",
      },
      {
        id: createSourceEntryId("blog", "beta.mdx"),
        collection: "blog",
        relativePath: "beta.mdx",
        entryType: "content",
        frontmatter: {
          title: "Beta",
          date: "2026-03-02",
          tags: ["release", "platform"],
        },
        body: "# Beta\n\nBeta release notes",
      },
      {
        id: createSourceEntryId("blog", "draft.mdx"),
        collection: "blog",
        relativePath: "draft.mdx",
        entryType: "content",
        frontmatter: {
          title: "Draft",
          date: "2026-03-03",
          draft: true,
          tags: ["internal"],
        },
        body: "# Draft\n\nDraft notes",
      },
    ]);

    const manifest = await buildManifest(provider, createConfig());

    expect(Object.values(manifest.posts).map((post) => post.slug)).toEqual(["beta", "alpha"]);
    expect(manifest.routes["/docs/blog/beta"]).toBe("blog:beta.mdx");
    expect(manifest.routes["/docs/blog/alpha"]).toBe("blog:alpha.mdx");
    expect(manifest.routes["/docs/blog/draft"]).toBeUndefined();
    expect(manifest.blog?.listRoute).toBe("/docs/blog");
    expect(manifest.blog?.feedPath).toBe("/docs/blog/rss.xml");
    expect(manifest.blog?.postOrder).toEqual(["blog:beta.mdx", "blog:alpha.mdx"]);
    expect(manifest.blog?.tags.release.path).toBe("/docs/blog/tags/release");
    expect(manifest.blog?.tags.platform.path).toBe("/docs/blog/tags/platform");

    expect(manifest.embedded?.pages["docs:reference/client.mdx"]).toEqual({
      pageId: "docs:reference/client.mdx",
      sourcePath: "/docs/reference/client",
      pageRoute: "/docs/embedded/page/reference/client",
      surfaceRoute: "/docs/embedded/surface/reference/client",
      title: "Client API",
      tocCount: 2,
    });
    expect(manifest.embedded?.hasSidebar).toBe(true);
    expect(manifest.embedded?.hasSearchTrigger).toBe(true);
    expect(manifest.embedded?.hasTopNavSlot).toBe(true);
  });

  it("supports changelog routes as a first-class dated collection", async () => {
    const changelogCollection = createNamedCollection("changelog");
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId(changelogCollection, "release.mdx"),
        collection: changelogCollection,
        relativePath: "release.mdx",
        entryType: "content",
        frontmatter: {
          title: "Release",
          date: "2026-03-01",
          tags: ["release"],
        },
        body: "# Release\n\nRelease notes",
      },
    ]);

    const manifest = await buildManifest(
      provider,
      createConfig({
        collections: {
          ChangeLog: {
            dir: "content/changelog",
            routeBase: "/changelog",
            label: "Changelog",
            scope: "changelog",
          },
        },
      })
    );
    const artifact = await buildSearchIndex(manifest, {
      search: {
        enabled: true,
        scopes: ["changelog"],
        bodyIndexing: "summary",
      },
    });

    expect(manifest.routes["/changelog/release"]).toBe("collection:changelog:release.mdx");
    expect(manifest.collections?.changelog?.label).toBe("Changelog");
    expect(manifest.collections?.changelog?.scope).toBe("changelog");
    expect(manifest.collections?.changelog?.listRoute).toBe("/changelog");
    expect(manifest.collections?.changelog?.feedPath).toBe("/changelog/rss.xml");
    expect(manifest.collections?.changelog?.tags.release.path).toBe(
      "/changelog/tags/release"
    );
    expect(manifest.blog?.listRoute).toBe("/docs/blog");
    expect(manifest.posts["collection:changelog:release.mdx"]).toMatchObject({
      collectionId: "changelog",
      collectionLabel: "Changelog",
      searchScope: "changelog",
      path: "/changelog/release",
    });
    expect(artifact.documents.map((doc) => doc.path)).toEqual(["/changelog/release"]);
    expect(artifact.documents.map((doc) => doc.scope)).toEqual(["changelog"]);
  });

  it("requests each normalized dated collection only once", async () => {
    let requestedCollections: DocsCollection[] = [];
    const provider: DocsContentProvider = {
      providerId: "capture-collections",
      async listEntries(input) {
        requestedCollections = input.collections;
        return [];
      },
      async loadEntry(input) {
        return input.entry;
      },
      async list() {
        return [];
      },
    };

    await buildManifest(
      provider,
      createConfig({
        collections: {
          ChangeLog: { dir: "content/changelog-one" },
          changelog: { dir: "content/changelog-two" },
        },
      })
    );

    expect(
      requestedCollections.filter((collection) => collection === "collection:changelog")
    ).toEqual(["collection:changelog"]);
  });

  it("builds mixed docs/api/blog search scope from manifest-derived routes (TV-SEARCH-001)", async () => {
    const provider = new InMemorySourceProvider([
      {
        id: createSourceEntryId("docs", "index.mdx"),
        collection: "docs",
        relativePath: "index.mdx",
        entryType: "content",
        frontmatter: { title: "Home", description: "Docs home" },
        body: "# Home",
      },
      {
        id: createSourceEntryId("blog", "release.mdx"),
        collection: "blog",
        relativePath: "release.mdx",
        entryType: "content",
        frontmatter: {
          title: "Release",
          date: "2026-03-01",
          tags: ["release"],
        },
        body: "# Release\n\nLatest updates",
      },
      {
        id: createSourceEntryId("api", "index.json"),
        collection: "api",
        relativePath: "index.json",
        entryType: "content",
        frontmatter: { title: "Search API" },
        body: JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "Search API",
            version: "1.0.0",
            description: "Search endpoints",
          },
          paths: {},
        }),
      },
    ]);

    const manifest = await buildManifest(provider, createConfig());
    const artifact = await buildSearchIndex(manifest, {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
        bodyIndexing: "summary",
      },
    });

    expect(artifact.engine).toBe("searchfn");
    expect(artifact.scopes).toEqual(["api", "blog", "docs"]);
    expect(artifact.documents.map((doc) => doc.scope)).toEqual(["api", "blog", "docs"]);
    expect(artifact.documents.map((doc) => doc.path)).toEqual([
      "/docs/api",
      "/docs/blog/release",
      "/docs",
    ]);
  });
});

describe("global dated-collection surface conflicts", () => {
  it.each(['blog/index.mdx', 'blog/rss.xml.mdx', 'blog/tags/news.mdx'])("rejects a page claiming %s", async (relativePath) => {
    const provider = new InMemorySourceProvider([
      { id: createSourceEntryId("docs", relativePath), collection: "docs", relativePath, entryType: "content", frontmatter: { title: "Collision" }, body: "# Collision" },
      { id: createSourceEntryId("blog", "release.mdx"), collection: "blog", relativePath: "release.mdx", entryType: "content", frontmatter: { title: "Release", date: "2026-01-01", tags: ["news"] }, body: "Release" },
    ]);
    await expect(buildManifest(provider, createConfig())).rejects.toMatchObject({ code: "DOCS_ROUTE_CONFLICT" });
  });
  it("rejects collection surfaces that claim the same route", async () => {
    await expect(buildManifest(new InMemorySourceProvider([]), createConfig({ collections: { changelog: { routeBase: "/docs/blog" } } }))).rejects.toMatchObject({ code: "DOCS_ROUTE_CONFLICT" });
  });
});

it('keeps collision reservations out of the public content route map', async () => {
  const provider = new InMemorySourceProvider([{ id: createSourceEntryId('blog', 'release.mdx'), collection: 'blog', relativePath: 'release.mdx', entryType: 'content', frontmatter: { title: 'Release', date: '2026-01-01', tags: ['news'] }, body: 'Release' }]);
  const manifest = await buildManifest(provider, createConfig());
  expect(manifest.routes[manifest.blog!.listRoute]).toBeUndefined();
  expect(manifest.routes[manifest.blog!.feedPath]).toBeUndefined();
  for (const id of Object.values(manifest.routes)) expect(manifest.pages[id] ?? manifest.posts[id] ?? manifest.apis[id]).toBeDefined();
});

it.each(['page', 'surface'])('rejects embedded %s URLs claimed by content', async kind => {
  const provider = new InMemorySourceProvider(['guide.mdx', `embedded/${kind}/guide.mdx`].map(relativePath => ({
    id: createSourceEntryId('docs', relativePath), collection: 'docs' as const, relativePath, entryType: 'content' as const, frontmatter: { title: 'Guide' }, body: '# Guide',
  })));
  await expect(buildManifest(provider, createConfig())).rejects.toMatchObject({ code: 'DOCS_ROUTE_CONFLICT' });
});
