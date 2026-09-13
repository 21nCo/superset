import { describe, expect, it } from "vitest";
import { buildSearchIndex } from "./search";
import { maybeEmitAnalyticsEvent } from "./analytics";
import { createDocsSearchRuntime } from "./search-runtime";
import type { DocsSearchEngineAdapter } from "./search-adapter";
import type { DocsManifest } from "./types";

function createManifest(): DocsManifest {
  return {
    site: {
      title: "Runtime docs",
    },
    pages: {
      "docs:a": {
        kind: "page",
        id: "docs:a",
        slug: "a",
        path: "/docs/a",
        title: "Adapter Intro",
        description: "Adapter intro",
        body: "Adapter docs body with setup details",
        headings: [{ level: 1, text: "Adapter Intro", slug: "adapter-intro" }],
        frontmatter: {},
      },
      "docs:b": {
        kind: "page",
        id: "docs:b",
        slug: "b",
        path: "/docs/b",
        title: "Adapter Basics",
        description: "Adapter basics",
        body: "Adapter basics body",
        headings: [{ level: 1, text: "Adapter Basics", slug: "adapter-basics" }],
        frontmatter: {},
      },
    },
    posts: {
      "blog:adapter": {
        kind: "post",
        id: "blog:adapter",
        slug: "adapter-release",
        path: "/docs/blog/adapter-release",
        title: "Adapter Release",
        date: "2026-03-02",
        tags: ["adapter"],
        body: "Adapter release body",
        frontmatter: {},
      },
    },
    apis: {
      "api:adapter": {
        kind: "api",
        id: "api:adapter",
        slug: "adapter",
        path: "/docs/api/adapter",
        title: "Adapter API",
        spec: {
          info: {
            title: "Adapter API",
            description: "Adapter endpoints",
          },
        },
        frontmatter: {},
      },
    },
    sidebars: {},
    routes: {},
  };
}

describe("search runtime", () => {
  it("loads artifacts lazily and queries deterministically", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });
    let loadCount = 0;
    const runtime = createDocsSearchRuntime({
      loadArtifact: async () => {
        loadCount += 1;
        return artifact;
      },
    });

    const first = await runtime.query({
      query: "adapter",
      scope: "all",
      limit: 10,
    });
    const second = await runtime.query({
      query: "adapter",
      scope: "all",
      limit: 10,
    });

    expect(loadCount).toBe(1);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("supports scope filtering and rejects unknown scopes (TV-SEARCH-002 negative)", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });
    const runtime = createDocsSearchRuntime({ artifact });

    const apiOnly = await runtime.query({
      query: "adapter",
      scope: "api",
      limit: 10,
    });
    expect(apiOnly.every((item) => item.scope === "api")).toBe(true);

    await expect(
      runtime.query({
        query: "adapter",
        scope: "foo" as "docs",
      })
    ).rejects.toThrowError(/DOCS_CONFIG_INVALID|unknown search scope foo/);
  });

  it("resolves custom search adapters by artifact engine", async () => {
    const adapter: DocsSearchEngineAdapter = {
      name: "test-static",
      async createIndexEngine() {
        return {
          add() {},
          exportSnapshot() {
            return {
              postings: [],
              stats: [],
              documents: [],
              vocabulary: [],
            };
          },
        };
      },
      async createRuntime({ documents }) {
        return {
          async query(input) {
            const normalizedQuery = input.query.toLowerCase();
            return [...documents.values()]
              .filter((document) => input.scope === "all" || document.scope === input.scope)
              .filter((document) =>
                `${document.title} ${document.summary} ${document.body}`
                  .toLowerCase()
                  .includes(normalizedQuery)
              )
              .map((document) => ({
                id: document.id,
                scope: document.scope,
                kind: document.kind,
                path: document.path,
                title: document.title,
                summary: document.summary,
                score: 1,
              }));
          },
        };
      },
    };
    const artifact = await buildSearchIndex(createManifest(), {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
      searchAdapter: adapter,
    });
    const runtime = createDocsSearchRuntime({
      artifact,
      searchAdapters: [adapter],
    });

    const results = await runtime.query({
      query: "adapter",
      scope: "api",
      limit: 10,
    });

    expect(artifact.engine).toBe("test-static");
    expect(results.map((result) => result.path)).toEqual(["/docs/api/adapter"]);
  });

  it("throws DOCS_ARTIFACT_INVALID for unsupported artifact engines", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: { enabled: true, scopes: ["docs", "api", "blog"] },
    });
    const runtime = createDocsSearchRuntime({
      artifact: {
        ...artifact,
        engine: "unknown-engine",
      },
    });

    await expect(
      runtime.query({
        query: "adapter",
      })
    ).rejects.toThrowError(/DOCS_ARTIFACT_INVALID|unsupported search artifact engine unknown-engine/);
  });

  it("uses deterministic tie-break ordering for equal-score results", async () => {
    const manifest = createManifest();
    manifest.pages = {
      "docs:a": {
        kind: "page",
        id: "docs:a",
        slug: "a",
        path: "/docs/a",
        title: "Adapter",
        description: "Adapter reference",
        body: "Adapter reference content",
        headings: [{ level: 1, text: "Adapter", slug: "adapter" }],
        frontmatter: {},
      },
      "docs:b": {
        kind: "page",
        id: "docs:b",
        slug: "b",
        path: "/docs/b",
        title: "Adapter",
        description: "Adapter reference",
        body: "Adapter reference content",
        headings: [{ level: 1, text: "Adapter", slug: "adapter" }],
        frontmatter: {},
      },
    };
    manifest.apis = {};
    manifest.posts = {};

    const artifact = await buildSearchIndex(manifest, {
      search: { enabled: true, scopes: ["docs"] },
    });
    const runtime = createDocsSearchRuntime({ artifact });

    const results = await runtime.query({
      query: "adapter",
      scope: "docs",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.score).toBe(results[1]?.score);
    expect(results[0]?.path).toBe("/docs/a");
    expect(results[1]?.path).toBe("/docs/b");
  });

  it("throws DOCS_ARTIFACT_INVALID for malformed artifacts", async () => {
    const runtime = createDocsSearchRuntime({
      artifact: {
        schemaVersion: 1,
        engine: "searchfn",
        fields: ["title", "summary", "headings", "tags", "body"],
        scopes: ["docs"],
        bodyIndexing: "summary",
        documents: [],
        snapshot: null as unknown as never,
        diagnostics: [],
        bytes: 0,
      },
    });

    await expect(
      runtime.query({
        query: "adapter",
      })
    ).rejects.toThrowError(/DOCS_ARTIFACT_INVALID|malformed/);
  });

  it("uses snapshot-backed search for schema v1 artifacts that lack stored body text", async () => {
    const artifact = await buildSearchIndex(createManifest(), {
      search: { enabled: true, scopes: ["docs", "api", "blog"], bodyIndexing: "full" },
    });
    const legacyCompatibleArtifact = {
      ...artifact,
      documents: artifact.documents.map((document) =>
        document.kind === "page"
          ? {
              ...document,
              body: "",
            }
          : document
      ),
    };
    const runtime = createDocsSearchRuntime({ artifact: legacyCompatibleArtifact });

    const results = await runtime.query({
      query: "details",
      scope: "docs",
      limit: 10,
    });

    expect(results.map((result) => result.id)).toContain("docs:a");
  });

  it("suppresses analytics emission when DNT is enabled (TV-OBS-001)", () => {
    const events: Array<{ name: string }> = [];
    const emitted = maybeEmitAnalyticsEvent({
      enabled: true,
      respectDnt: true,
      doNotTrackValue: "1",
      event: {
        name: "docs.search",
        timestamp: "2026-03-20T00:00:00Z",
        route: "/docs",
        resultCount: 1,
      },
      emit: (event) => events.push({ name: event.name }),
    });
    expect(emitted).toBe(false);
    expect(events).toEqual([]);
  });
});
