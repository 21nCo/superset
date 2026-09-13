import { createDiagnostic, createDocsError } from "./diagnostics";
import type { DocsSearchArtifact, DocsSearchDocument, DocsSearchScope } from "./search";
import {
  resolveDocsSearchEngineAdapter,
  type DocsSearchEngineAdapter,
  type DocsSearchRuntimeBackend,
} from "./search-adapter";

export type DocsSearchScopeFilter = DocsSearchScope | "all";

export interface DocsSearchRuntimeResultItem {
  id: string;
  scope: DocsSearchScope;
  kind: "page" | "api" | "post";
  path: string;
  title: string;
  summary: string;
  score: number;
}

export interface DocsSearchRuntimeQueryInput {
  query: string;
  scope?: DocsSearchScopeFilter;
  limit?: number;
}

export interface DocsSearchRuntime {
  ensureReady(): Promise<void>;
  query(input: DocsSearchRuntimeQueryInput): Promise<DocsSearchRuntimeResultItem[]>;
  getScopes(): Promise<DocsSearchScope[]>;
}

export interface CreateDocsSearchRuntimeInput {
  artifact?: DocsSearchArtifact;
  loadArtifact?: () => Promise<DocsSearchArtifact>;
  searchAdapters?: DocsSearchEngineAdapter[];
}

interface ValidatedArtifact {
  artifact: DocsSearchArtifact;
  backend: DocsSearchRuntimeBackend;
}

function assertValidArtifact(artifact: DocsSearchArtifact): void {
  if (
    artifact.schemaVersion !== 1 ||
    typeof artifact.engine !== "string" ||
    artifact.engine.trim().length === 0
  ) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: "search artifact schema is invalid",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search artifact schema is invalid",
        }),
      ],
    });
  }

  if (!Array.isArray(artifact.documents) || !artifact.snapshot) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: "search artifact is malformed",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search artifact is malformed",
        }),
      ],
    });
  }
}

function sortResults(
  results: DocsSearchRuntimeResultItem[],
  limit: number
): DocsSearchRuntimeResultItem[] {
  return [...results]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const titleCompare = left.title.localeCompare(right.title, "en", {
        sensitivity: "variant",
        numeric: true,
      });
      if (titleCompare !== 0) {
        return titleCompare;
      }
      const pathCompare = left.path.localeCompare(right.path, "en", {
        sensitivity: "variant",
        numeric: true,
      });
      if (pathCompare !== 0) {
        return pathCompare;
      }
      return left.id.localeCompare(right.id, "en", {
        sensitivity: "variant",
        numeric: true,
      });
    })
    .slice(0, Math.max(1, limit));
}

export function createDocsSearchRuntime(
  input: CreateDocsSearchRuntimeInput
): DocsSearchRuntime {
  let validated: ValidatedArtifact | null = null;
  let loadingPromise: Promise<ValidatedArtifact> | null = null;

  async function loadValidated(): Promise<ValidatedArtifact> {
    if (validated) {
      return validated;
    }
    if (loadingPromise) {
      return loadingPromise;
    }

    loadingPromise = (async () => {
      const artifact = input.artifact ?? (input.loadArtifact ? await input.loadArtifact() : null);
      if (!artifact) {
        throw createDocsError({
          code: "DOCS_ARTIFACT_INVALID",
          message: "search runtime was created without an artifact or loader",
          diagnostics: [
            createDiagnostic({
              code: "DOCS_ARTIFACT_INVALID",
              message: "search runtime was created without an artifact or loader",
            }),
          ],
        });
      }

      assertValidArtifact(artifact);
      const documents = new Map<string, DocsSearchDocument>();

      for (const document of artifact.documents) {
        documents.set(document.id, document);
      }

      const adapter = resolveDocsSearchEngineAdapter(
        artifact.engine,
        input.searchAdapters
      );
      validated = {
        artifact,
        backend: await adapter.createRuntime({ artifact, documents }),
      };
      return validated;
    })();

    try {
      return await loadingPromise;
    } finally {
      loadingPromise = null;
    }
  }

  return {
    async ensureReady(): Promise<void> {
      await loadValidated();
    },
    async getScopes(): Promise<DocsSearchScope[]> {
      const loaded = await loadValidated();
      return [...loaded.artifact.scopes];
    },
    async query(queryInput: DocsSearchRuntimeQueryInput): Promise<DocsSearchRuntimeResultItem[]> {
      const loaded = await loadValidated();
      const normalizedQuery = queryInput.query.trim();
      if (!normalizedQuery) {
        return [];
      }

      const scope = queryInput.scope ?? "all";
      if (scope !== "all" && !loaded.artifact.scopes.includes(scope)) {
        throw createDocsError({
          code: "DOCS_CONFIG_INVALID",
          message: `unknown search scope ${scope}`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_CONFIG_INVALID",
              message: `unknown search scope ${scope}`,
            }),
          ],
        });
      }

      const results = await loaded.backend.query({
        query: normalizedQuery,
        scope,
        limit: Math.max(queryInput.limit ?? 20, 20),
      });

      return sortResults(results, queryInput.limit ?? 20);
    },
  };
}
