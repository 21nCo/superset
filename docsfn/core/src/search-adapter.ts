import { createDiagnostic, createDocsError } from "./diagnostics";
import { searchFnSearchAdapter } from "./searchfn-adapter";
import type {
  DocsSearchArtifact,
  DocsSearchDocument,
  DocsSearchField,
  DocsSearchSnapshot,
} from "./search";
import type {
  DocsSearchRuntimeQueryInput,
  DocsSearchRuntimeResultItem,
} from "./search-runtime";

export type DocsSearchEngineName = "searchfn" | (string & {});

export interface DocsSearchIndexEngine {
  add(input: {
    id: string | number;
    fields: Record<string, string>;
    store?: Record<string, unknown>;
  }): void;
  exportSnapshot(): DocsSearchSnapshot;
}

export interface DocsSearchRuntimeBackendQueryInput {
  query: string;
  scope: NonNullable<DocsSearchRuntimeQueryInput["scope"]>;
  limit: number;
}

export interface DocsSearchRuntimeBackend {
  query(input: DocsSearchRuntimeBackendQueryInput): Promise<DocsSearchRuntimeResultItem[]>;
}

export interface DocsSearchEngineAdapter {
  name: DocsSearchEngineName;
  createIndexEngine(input: { fields: DocsSearchField[] }): Promise<DocsSearchIndexEngine>;
  createRuntime(input: {
    artifact: DocsSearchArtifact;
    documents: Map<string, DocsSearchDocument>;
  }): Promise<DocsSearchRuntimeBackend>;
}

export function getDefaultDocsSearchEngineAdapter(): DocsSearchEngineAdapter {
  return searchFnSearchAdapter;
}

export function resolveDocsSearchEngineAdapter(
  engine: string,
  adapters: DocsSearchEngineAdapter[] = []
): DocsSearchEngineAdapter {
  const adapter = [...adapters, searchFnSearchAdapter].find(
    (candidate) => candidate.name === engine
  );

  if (adapter) {
    return adapter;
  }

  throw createDocsError({
    code: "DOCS_ARTIFACT_INVALID",
    message: `unsupported search artifact engine ${engine}`,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_ARTIFACT_INVALID",
        message: `unsupported search artifact engine ${engine}`,
        suggestion:
          "Register a docsfn search adapter for this artifact engine or rebuild the artifact with the default searchfn engine.",
      }),
    ],
  });
}
