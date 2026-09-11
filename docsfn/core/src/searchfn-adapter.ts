import { createDiagnostic, createDocsError } from "./diagnostics";
import type { DocsSearchArtifact, DocsSearchDocument } from "./search";
import type { DocsSearchRuntimeResultItem } from "./search-runtime";
import type {
  DocsSearchEngineAdapter,
  DocsSearchIndexEngine,
  DocsSearchRuntimeBackend,
  DocsSearchRuntimeBackendQueryInput,
} from "./search-adapter";

const SEARCHFN_PIPELINE = {
  enableEdgeNGrams: true,
  edgeNGramMinLength: 2,
  edgeNGramMaxLength: 128,
};

interface SnapshotSearchEngine extends DocsSearchIndexEngine {
  importSnapshot(snapshot: DocsSearchArtifact["snapshot"]): void;
  searchDetailed(
    query: string,
    options: {
      fields?: string[];
      limit?: number;
    }
  ): Array<{ docId: string | number; score: number }>;
}

interface SearchFnClientModule {
  InMemorySearchFn: new (options: {
    fields: string[];
    pipeline?: {
      enableEdgeNGrams?: boolean;
      edgeNGramMinLength?: number;
      edgeNGramMaxLength?: number;
    };
  }) => SnapshotSearchEngine;
}

async function loadSearchFnClient(
  usage: "build" | "runtime"
): Promise<SearchFnClientModule> {
  try {
    return (await import("@searchfn/client")) as unknown as SearchFnClientModule;
  } catch (error) {
    const code =
      usage === "build" ? "DOCS_SEARCH_BUILD_FAILED" : "DOCS_ARTIFACT_INVALID";
    const action = usage === "build" ? "build a docs search index" : "query a docs search artifact";
    throw createDocsError({
      code,
      message: `@searchfn/client is required to ${action}`,
      diagnostics: [
        createDiagnostic({
          code,
          message: `@searchfn/client is required to ${action}`,
          suggestion:
            usage === "build"
              ? "Install @searchfn/client, disable docs search, or provide a prebuilt search artifact."
              : "Install @searchfn/client or avoid creating the docs search runtime on pages that do not use search.",
        }),
      ],
      cause: error,
    });
  }
}

class SearchFnRuntimeBackend implements DocsSearchRuntimeBackend {
  constructor(
    private readonly artifact: DocsSearchArtifact,
    private readonly documents: Map<string, DocsSearchDocument>,
    private readonly engine: SnapshotSearchEngine
  ) {}

  async query(
    input: DocsSearchRuntimeBackendQueryInput
  ): Promise<DocsSearchRuntimeResultItem[]> {
    const engineResults = this.engine.searchDetailed(input.query, {
      fields: this.artifact.fields,
      limit: input.scope === "all" ? input.limit : this.artifact.documents.length || input.limit,
    });

    return engineResults
      .map((hit) => {
        const document = this.documents.get(String(hit.docId));
        if (!document) {
          return null;
        }
        return {
          id: document.id,
          score: hit.score,
          scope: document.scope,
          kind: document.kind,
          path: document.path,
          title: document.title,
          summary: document.summary,
        };
      })
      .filter((item): item is DocsSearchRuntimeResultItem => item !== null)
      .filter((item) => item.path.length > 0 && item.title.length > 0)
      .filter((item) => input.scope === "all" || item.scope === input.scope);
  }
}

export const searchFnSearchAdapter: DocsSearchEngineAdapter = {
  name: "searchfn",
  async createIndexEngine(input) {
    const { InMemorySearchFn } = await loadSearchFnClient("build");
    return new InMemorySearchFn({
      fields: input.fields,
      pipeline: SEARCHFN_PIPELINE,
    });
  },
  async createRuntime(input) {
    const { InMemorySearchFn } = await loadSearchFnClient("runtime");
    const engine = new InMemorySearchFn({
      fields: input.artifact.fields,
      pipeline: SEARCHFN_PIPELINE,
    });
    engine.importSnapshot(input.artifact.snapshot);
    return new SearchFnRuntimeBackend(input.artifact, input.documents, engine);
  },
};
