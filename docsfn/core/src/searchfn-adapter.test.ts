import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DocsSearchArtifact,
  DocsSearchDocument,
  DocsSearchField,
} from "./search";

const fields: DocsSearchField[] = [
  "title",
  "summary",
  "headings",
  "tags",
  "body",
];

function createDocument(
  id: string,
  scope: "docs" | "api",
  path: string,
  title: string,
): DocsSearchDocument {
  return {
    id,
    scope,
    kind: scope === "api" ? "api" : "page",
    path,
    title,
    summary: `${title} summary`,
    headings: [title],
    tags: ["adapter"],
    body: `${title} body`,
  };
}

function createArtifact(
  documents: DocsSearchDocument[],
  snapshot: DocsSearchArtifact["snapshot"],
): DocsSearchArtifact {
  return {
    schemaVersion: 1,
    engine: "searchfn",
    fields,
    scopes: ["api", "docs"],
    bodyIndexing: "summary",
    documents,
    snapshot,
    diagnostics: [],
    bytes: 0,
  };
}

afterEach(() => {
  vi.doUnmock("@searchfn/client");
  vi.resetModules();
});

describe("searchFnSearchAdapter", () => {
  it("builds, restores, maps, and filters a SearchFn snapshot directly", async () => {
    const { searchFnSearchAdapter } = await import("./searchfn-adapter");
    const documents = [
      createDocument("docs:adapter", "docs", "/docs/adapter", "Adapter guide"),
      createDocument("api:adapter", "api", "/api/adapter", "Adapter API"),
    ];
    const engine = await searchFnSearchAdapter.createIndexEngine({ fields });
    for (const document of documents) {
      engine.add({
        id: document.id,
        fields: {
          title: document.title,
          summary: document.summary,
          headings: document.headings.join(" "),
          tags: document.tags.join(" "),
          body: document.body,
        },
      });
    }
    const artifact = createArtifact(documents, engine.exportSnapshot());
    const runtime = await searchFnSearchAdapter.createRuntime({
      artifact,
      documents: new Map(documents.map((document) => [document.id, document])),
    });

    const results = await runtime.query({
      query: "adapter",
      scope: "api",
      limit: 10,
    });

    expect(searchFnSearchAdapter.name).toBe("searchfn");
    expect(results).toEqual([
      expect.objectContaining({
        id: "api:adapter",
        scope: "api",
        path: "/api/adapter",
        title: "Adapter API",
      }),
    ]);
  });

  it("preserves complete search terms longer than the default n-gram ceiling", async () => {
    const { searchFnSearchAdapter } = await import("./searchfn-adapter");
    const title = "supercalifragilisticexpialidocious";
    const document = createDocument("docs:long", "docs", "/docs/long", title);
    const engine = await searchFnSearchAdapter.createIndexEngine({ fields });
    engine.add({
      id: document.id,
      fields: {
        title: document.title,
        summary: document.summary,
        headings: document.headings.join(" "),
        tags: document.tags.join(" "),
        body: document.body,
      },
    });
    const runtime = await searchFnSearchAdapter.createRuntime({
      artifact: createArtifact([document], engine.exportSnapshot()),
      documents: new Map([[document.id, document]]),
    });
    await expect(runtime.query({ query: title, scope: "all", limit: 5 })).resolves.toEqual([
      expect.objectContaining({ id: document.id }),
    ]);
  });

  it("translates missing client failures for build and runtime usage", async () => {
    vi.resetModules();
    vi.doMock("@searchfn/client", () => {
      throw new Error("searchfn client unavailable");
    });
    const { searchFnSearchAdapter } = await import("./searchfn-adapter");
    const emptyArtifact = createArtifact([], {
      postings: [],
      stats: [],
      documents: [],
      vocabulary: [],
    });

    await expect(
      searchFnSearchAdapter.createIndexEngine({ fields }),
    ).rejects.toMatchObject({
      code: "DOCS_SEARCH_BUILD_FAILED",
    });
    await expect(
      searchFnSearchAdapter.createRuntime({
        artifact: emptyArtifact,
        documents: new Map(),
      }),
    ).rejects.toMatchObject({
      code: "DOCS_ARTIFACT_INVALID",
    });
  });
});
