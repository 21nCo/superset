import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";
import { createSourceEntryId } from "./provider";
import { buildSearchIndex, resolveSearchScopeForRoute } from "./search";
import type { DocsSearchEngineAdapter } from "./search-adapter";
import type {
  DocsCollection,
  DocsContentProvider,
  DocsManifest,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsSourceEntry,
  RawContentEntry,
} from "./types";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-fixtures/repo"
);

function createManifest(): DocsManifest {
  return {
    site: {
      title: "Search Docs",
      description: "Search fixture",
    },
    pages: {
      "docs:index": {
        kind: "page",
        id: "docs:index",
        slug: "",
        path: "/docs",
        title: "Home",
        description: "Welcome to docs",
        body: "# Home\n\nWelcome to docs",
        headings: [{ level: 1, text: "Home", slug: "home" }],
        frontmatter: {},
      },
      "docs:adapter": {
        kind: "page",
        id: "docs:adapter",
        slug: "reference/adapters/indexeddb",
        path: "/docs/reference/adapters/indexeddb",
        title: "IndexedDB Adapter",
        description: "Adapter guide",
        body: "# IndexedDB Adapter\n\nAdapter details and setup.",
        headings: [
          { level: 1, text: "IndexedDB Adapter", slug: "indexeddb-adapter" },
          { level: 2, text: "Setup", slug: "setup" },
        ],
        frontmatter: {},
      },
    },
    posts: {
      "blog:release": {
        kind: "post",
        id: "blog:release",
        slug: "release-1",
        path: "/docs/blog/release-1",
        title: "Release Notes",
        date: "2026-03-01",
        excerpt: "Release highlights",
        tags: ["release", "platform"],
        body: "Big release with platform improvements.",
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
            description: "Search endpoints",
          },
        },
        frontmatter: {},
      },
    },
    sidebars: {},
    routes: {},
  };
}

function createConfig() {
  return {
    schemaVersion: 1 as const,
    site: {
      title: "Fixture Docs",
      basePath: "/docs",
    },
    compat: {
      preset: "fumadocs-v15" as const,
    },
    content: {
      root: "/repo/docs",
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
    },
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
        kind: entry.collection === "blog" ? "post" : entry.collection === "api" ? "api" : "page",
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

  return { frontmatter, body };
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

async function loadFixtureDocsEntries(fixtureName: "datafn-docs" | "searchfn-docs"): Promise<DocsSourceEntry[]> {
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

describe("buildSearchIndex", () => {
  it("indexes docs/api/blog scopes with deterministic output (TV-SEARCH-001)", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
        bodyIndexing: "summary",
      },
    });

    expect(artifact.engine).toBe("searchfn");
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.scopes).toEqual(["api", "blog", "docs"]);
    expect(artifact.documents.map((doc) => doc.id)).toEqual([
      "api:search",
      "blog:release",
      "docs:adapter",
      "docs:index",
    ]);
    expect(artifact.documents.find((doc) => doc.id === "docs:adapter")?.headings).toEqual([
      "IndexedDB Adapter",
      "Setup",
    ]);
  });

  it("can build through a custom search adapter boundary", async () => {
    const indexedIds: Array<string | number> = [];
    const adapter: DocsSearchEngineAdapter = {
      name: "test-static",
      async createIndexEngine() {
        return {
          add(input) {
            indexedIds.push(input.id);
          },
          exportSnapshot() {
            return {
              postings: [],
              stats: [],
              documents: indexedIds.map((docId) => ({ docId, payload: {} })),
              vocabulary: [],
            };
          },
        };
      },
      async createRuntime() {
        return {
          async query() {
            return [];
          },
        };
      },
    };

    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
      },
      searchAdapter: adapter,
    });

    expect(artifact.engine).toBe("test-static");
    expect(indexedIds).toEqual([
      "api:search",
      "blog:release",
      "docs:adapter",
      "docs:index",
    ]);
  });

  it("is deterministic even when manifest object insertion order changes (DET-001)", async () => {
    const manifestA = createManifest();
    const manifestB = createManifest();
    manifestB.pages = Object.fromEntries(Object.entries(manifestB.pages).reverse());
    manifestB.posts = Object.fromEntries(Object.entries(manifestB.posts).reverse());
    manifestB.apis = Object.fromEntries(Object.entries(manifestB.apis).reverse());

    const artifactA = await buildSearchIndex(manifestA, {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });
    const artifactB = await buildSearchIndex(manifestB, {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });

    expect(JSON.stringify(artifactA)).toBe(JSON.stringify(artifactB));
  });

  it("throws DOCS_SEARCH_BUILD_FAILED for empty search scopes", async () => {
    await expect(
      buildSearchIndex(createManifest(), {
        search: {
          enabled: true,
          scopes: [],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_BUILD_FAILED|scopes cannot be empty/);
  });

  it("throws DOCS_SEARCH_BUILD_FAILED for duplicate source ids across scopes", async () => {
    const manifest = createManifest();
    manifest.posts = {
      "docs:adapter": {
        kind: "post",
        id: "docs:adapter",
        slug: "duplicate",
        path: "/docs/blog/duplicate",
        title: "Duplicate",
        date: "2026-03-01",
        tags: [],
        body: "duplicate id",
        frontmatter: {},
      },
    };

    await expect(
      buildSearchIndex(manifest, {
        search: {
          enabled: true,
          scopes: ["docs", "blog"],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_BUILD_FAILED|duplicated/);
  });

  it("emits warning diagnostics when artifact exceeds configured max bytes", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs", "api", "blog"],
        maxArtifactBytes: 100,
      },
    });

    expect(artifact.diagnostics.some((diagnostic) => diagnostic.severity === "warning")).toBe(
      true
    );
    expect(artifact.bytes).toBeGreaterThan(100);
  });

  it("supports disabled body indexing", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: {
        enabled: true,
        scopes: ["docs"],
        bodyIndexing: "disabled",
      },
    });

    expect(artifact.bodyIndexing).toBe("disabled");
    expect(artifact.documents.length).toBe(2);
  });

  it("redacts sensitive tokens from fully indexed body content", async () => {
    const manifest = createManifest();
    manifest.pages["docs:secret"] = {
      kind: "page",
      id: "docs:secret",
      slug: "secret",
      path: "/docs/secret",
      title: "Secret Guide",
      description: "Secret handling",
      body: "# Secret\n\nUse sk_test_12345 and ghp_abcdefghijklmnopqrstuvwxyz123456 to test redaction.",
      headings: [{ level: 1, text: "Secret", slug: "secret" }],
      frontmatter: {},
    };

    const artifact = await buildSearchIndex(manifest, {
      search: {
        enabled: true,
        scopes: ["docs"],
        bodyIndexing: "full",
      },
    });

    const body = artifact.documents.find((document) => document.id === "docs:secret")?.body ?? "";
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("sk_test_12345");
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("reclassifies configured docs routes into api scope without changing paths", async () => {
    const manifest = createManifest();
    manifest.pages["docs:client"] = {
      kind: "page",
      id: "docs:client",
      slug: "api/client",
      path: "/docs/api/client",
      title: "Client API Guide",
      description: "Hand-written API guide",
      body: "# Client API Guide\n\nGuide body",
      headings: [{ level: 1, text: "Client API Guide", slug: "client-api-guide" }],
      frontmatter: {},
    };

    const artifact = await buildSearchIndex(manifest, {
      search: {
        enabled: true,
        scopes: ["api"],
        routeScopeOverrides: [{ pattern: "/docs/api/**", scope: "api" }],
      },
    });

    expect(artifact.documents.map((document) => [document.id, document.scope, document.path])).toEqual([
      ["api:search", "api", "/docs/api/search"],
      ["docs:client", "api", "/docs/api/client"],
    ]);
  });

  it("resolves route scopes deterministically from matching override sets", () => {
    expect(
      resolveSearchScopeForRoute({
        route: "/docs/api/client/",
        kind: "page",
        routeScopeOverrides: [
          { pattern: "/docs/**", scope: "api" },
          { pattern: "/docs/api/**", scope: "api" },
        ],
      })
    ).toBe("api");
  });

  it("throws DOCS_SEARCH_SCOPE_INVALID for ambiguous effective route matches", async () => {
    await expect(
      buildSearchIndex(createManifest(), {
        search: {
          enabled: true,
          scopes: ["docs", "api"],
          routeScopeOverrides: [
            { pattern: "/docs/**", scope: "docs" },
            { pattern: "/docs/api/**", scope: "api" },
          ],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_SCOPE_INVALID|ambiguous/);
  });

  it("throws DOCS_SEARCH_SCOPE_INVALID for invalid override scope values", async () => {
    await expect(
      buildSearchIndex(createManifest(), {
        search: {
          enabled: true,
          scopes: ["docs", "api", "blog"],
          routeScopeOverrides: [
            { pattern: "/docs/api/**", scope: "" as unknown as "docs" },
          ],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_SCOPE_INVALID|scope is required/);
  });

  it("throws DOCS_SEARCH_SCOPE_INVALID for invalid override patterns even when search is disabled", async () => {
    await expect(
      buildSearchIndex(createManifest(), {
        search: {
          enabled: false,
          scopes: ["docs"],
          routeScopeOverrides: [{ pattern: "docs/api/**", scope: "api" }],
        },
      })
    ).rejects.toThrowError(/DOCS_SEARCH_SCOPE_INVALID|must start with '\/'/);
  });

  it.each([
    { fixtureName: "searchfn-docs" as const, expectedRoute: "/docs/reference/client" },
    { fixtureName: "datafn-docs" as const, expectedRoute: "/docs/documentation/server/routes" },
  ])(
    "keeps canonical fixture search routes stable when api overrides do not match ($fixtureName)",
    async ({ fixtureName, expectedRoute }) => {
      const entries = await loadFixtureDocsEntries(fixtureName);
      const manifest = await buildManifest(new InMemorySourceProvider(entries), createConfig());

      const artifactWithoutOverrides = await buildSearchIndex(manifest, {
        search: {
          enabled: true,
          scopes: ["docs", "api", "blog"],
          bodyIndexing: "summary",
        },
      });
      const artifactWithOverrides = await buildSearchIndex(manifest, {
        search: {
          enabled: true,
          scopes: ["docs", "api", "blog"],
          bodyIndexing: "summary",
          routeScopeOverrides: [{ pattern: "/docs/api/**", scope: "api" }],
        },
      });

      expect(artifactWithoutOverrides.documents.some((document) => document.path === "/docs")).toBe(true);
      expect(
        artifactWithoutOverrides.documents.some((document) => document.path === expectedRoute)
      ).toBe(true);
      expect(artifactWithOverrides.documents.map((document) => document.path)).toEqual(
        artifactWithoutOverrides.documents.map((document) => document.path)
      );
      expect(artifactWithOverrides.documents.map((document) => document.scope)).toEqual(
        artifactWithoutOverrides.documents.map((document) => document.scope)
      );
      expect(new Set(artifactWithOverrides.documents.map((document) => document.scope))).toEqual(
        new Set(["docs"])
      );
    }
  );
});
