import { createDiagnostic, createDocsError } from "./diagnostics";
import {
  getDefaultDocsSearchEngineAdapter,
  type DocsSearchEngineAdapter,
  type DocsSearchEngineName,
} from "./search-adapter";
import { isDocsContentProtected, redactSensitiveText } from "./security";
import type {
  DocsConfig,
  DocsDiagnostic,
  DocsManifest,
  DocsSearchRouteScopeOverride,
  DocsSearchScope,
} from "./types";

export type { DocsSearchScope, DocsSearchRouteScopeOverride } from "./types";

export type DocsSearchBodyIndexing = "full" | "summary" | "disabled";
export type DocsSearchDocumentKind = "page" | "api" | "post";
export type DocsSearchField = "title" | "summary" | "headings" | "tags" | "body";

export interface DocsSearchSnapshot {
  postings: Array<{
    field: string;
    term: string;
    documents: Array<Record<string, unknown>>;
  }>;
  stats: Array<{ docId: string | number; length: number }>;
  documents: Array<{ docId: string | number; payload: Record<string, unknown> }>;
  vocabulary: string[];
}

export interface DocsSearchDocument {
  id: string;
  scope: DocsSearchScope;
  kind: DocsSearchDocumentKind;
  path: string;
  title: string;
  summary: string;
  headings: string[];
  tags: string[];
  body: string;
}

export interface DocsSearchArtifact {
  schemaVersion: 1;
  engine: DocsSearchEngineName;
  fields: DocsSearchField[];
  scopes: DocsSearchScope[];
  bodyIndexing: DocsSearchBodyIndexing;
  documents: DocsSearchDocument[];
  snapshot: DocsSearchSnapshot;
  diagnostics: DocsDiagnostic[];
  bytes: number;
}

export interface BuildSearchIndexOptions {
  search?: DocsConfig["search"];
  auth?: DocsConfig["auth"];
  searchAdapter?: DocsSearchEngineAdapter;
}

const DEFAULT_SCOPES: DocsSearchScope[] = ["docs", "api", "blog"];
const SEARCH_FIELDS: DocsSearchField[] = ["title", "summary", "headings", "tags", "body"];

interface NormalizedRouteScopeOverride {
  pattern: string;
  scope: DocsSearchScope;
  regex: RegExp;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~>-]/g, " ")
  );
}

function summarizeBody(value: string, maxLength = 220): string {
  const normalized = stripMarkdown(value);
  if (normalized.length <= maxLength) {
    return redactSensitiveText(normalized);
  }
  return redactSensitiveText(`${normalized.slice(0, maxLength - 1).trimEnd()}…`);
}

function normalizeScopes(
  searchConfig: DocsConfig["search"],
  manifest?: DocsManifest
): DocsSearchScope[] {
  const explicitScopes = searchConfig?.scopes;
  if (Array.isArray(explicitScopes) && explicitScopes.length === 0) {
    throw createDocsError({
      code: "DOCS_SEARCH_BUILD_FAILED",
      message: "search scopes cannot be empty",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_SEARCH_BUILD_FAILED",
          message: "search scopes cannot be empty",
        }),
      ],
    });
  }
  const manifestCollectionScopes = Object.values(manifest?.collections ?? {}).map(
    (collection) => collection.scope
  );
  const scopes = (explicitScopes ?? [
    ...DEFAULT_SCOPES,
    ...manifestCollectionScopes,
  ]) as DocsSearchScope[];
  return [...new Set(scopes)].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
  );
}

function normalizeRoutePattern(pattern: string): string {
  const trimmed = String(pattern).trim();
  if (!trimmed.startsWith("/")) {
    throw createDocsError({
      code: "DOCS_SEARCH_SCOPE_INVALID",
      message: `search.routeScopeOverrides pattern must start with '/': ${pattern}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_SEARCH_SCOPE_INVALID",
          message: `search.routeScopeOverrides pattern must start with '/': ${pattern}`,
        }),
      ],
    });
  }

  let end = trimmed.length;
  while (end > 1 && trimmed.charCodeAt(end - 1) === 47) end -= 1;
  return trimmed.slice(0, end);
}

function normalizeRouteForMatch(route: string): string {
  const trimmed = route.trim();
  if (trimmed.length === 0) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  let end = prefixed.length;
  while (end > 1 && prefixed.charCodeAt(end - 1) === 47) end -= 1;
  return prefixed.slice(0, end);
}

function globToRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (/[\\^$+?.()|[\]{}]/.test(character)) {
      expression += `\\${character}`;
      continue;
    }
    expression += character;
  }
  expression += "$";
  return new RegExp(expression);
}

function normalizeRouteScopeOverrides(
  overrides: DocsSearchRouteScopeOverride[] | undefined
): NormalizedRouteScopeOverride[] {
  if (!Array.isArray(overrides) || overrides.length === 0) {
    return [];
  }

  return [...overrides]
    .map((override) => {
      const pattern = normalizeRoutePattern(override.pattern);
      if (typeof override.scope !== "string" || override.scope.trim().length === 0) {
        throw createDocsError({
          code: "DOCS_SEARCH_SCOPE_INVALID",
          message: `search.routeScopeOverrides scope is required: ${String(override.scope)}`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_SEARCH_SCOPE_INVALID",
              message: `search.routeScopeOverrides scope is required: ${String(override.scope)}`,
              details: {
                pattern,
                scope: override.scope,
              },
            }),
          ],
        });
      }
      const scope = override.scope as DocsSearchScope;
      return {
        pattern,
        scope,
        regex: globToRegExp(pattern),
      };
    })
    .sort((left, right) => left.pattern.localeCompare(right.pattern, "en", { sensitivity: "variant", numeric: true }));
}

function defaultScopeForDocumentKind(kind: DocsSearchDocumentKind): DocsSearchScope {
  if (kind === "api") {
    return "api";
  }
  if (kind === "post") {
    return "blog";
  }
  return "docs";
}

export function resolveSearchScopeForRoute(input: {
  route: string;
  kind: DocsSearchDocumentKind;
  defaultScope?: DocsSearchScope;
  routeScopeOverrides?: DocsSearchRouteScopeOverride[];
}): DocsSearchScope {
  const normalizedRoute = normalizeRouteForMatch(input.route);
  const defaultScope = input.defaultScope ?? defaultScopeForDocumentKind(input.kind);
  const overrides = normalizeRouteScopeOverrides(input.routeScopeOverrides);
  const matches = overrides.filter((override) => override.regex.test(normalizedRoute));

  if (matches.length === 0) {
    return defaultScope;
  }

  const distinctScopes = new Set(matches.map((match) => match.scope));
  if (distinctScopes.size > 1) {
    throw createDocsError({
      code: "DOCS_SEARCH_SCOPE_INVALID",
      message: `search.routeScopeOverrides are ambiguous for route ${normalizedRoute}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_SEARCH_SCOPE_INVALID",
          message: `search.routeScopeOverrides are ambiguous for route ${normalizedRoute}`,
          details: {
            route: normalizedRoute,
            matches: matches.map((match) => ({
              pattern: match.pattern,
              scope: match.scope,
            })),
          },
        }),
      ],
    });
  }

  return matches[0]?.scope ?? defaultScope;
}

function resolveBodyIndexing(searchConfig: DocsConfig["search"]): DocsSearchBodyIndexing {
  return searchConfig?.bodyIndexing ?? "summary";
}

function createEmptySnapshot(): DocsSearchSnapshot {
  return {
    postings: [],
    stats: [],
    documents: [],
    vocabulary: [],
  };
}

function resolveBodyField(input: {
  bodyIndexing: DocsSearchBodyIndexing;
  body: string;
  summary: string;
}): string {
  if (input.bodyIndexing === "disabled") {
    return "";
  }
  if (input.bodyIndexing === "summary") {
    return input.summary;
  }
  return stripMarkdown(redactSensitiveText(input.body));
}

function collectSearchDocuments(input: {
  manifest: DocsManifest;
  scopes: DocsSearchScope[];
  auth: DocsConfig["auth"] | undefined;
  bodyIndexing: DocsSearchBodyIndexing;
  routeScopeOverrides?: DocsSearchRouteScopeOverride[];
}): DocsSearchDocument[] {
  const documents: DocsSearchDocument[] = [];

  function isProtected(frontmatter: Record<string, unknown> | undefined, route: string): boolean {
    return isDocsContentProtected({
      auth: input.auth,
      frontmatter,
      route,
    });
  }

  for (const page of Object.values(input.manifest.pages)) {
    if (isProtected(page.frontmatter, page.path)) {
      continue;
    }
    const scope = resolveSearchScopeForRoute({
      route: page.path,
      kind: "page",
      routeScopeOverrides: input.routeScopeOverrides,
    });
    if (!input.scopes.includes(scope)) {
      continue;
    }
    documents.push({
      id: page.id,
      scope,
      kind: "page",
      path: page.path,
      title: redactSensitiveText(page.title),
      summary: redactSensitiveText(
        normalizeWhitespace(page.description ?? summarizeBody(page.body))
      ),
      headings: page.headings.map((heading) => redactSensitiveText(heading.text)),
      tags: [],
      body: resolveBodyField({
        bodyIndexing: input.bodyIndexing,
        body: page.body,
        summary: redactSensitiveText(
          normalizeWhitespace(page.description ?? summarizeBody(page.body))
        ),
      }),
    });
  }

  for (const api of Object.values(input.manifest.apis)) {
    if (isProtected(api.frontmatter, api.path)) {
      continue;
    }
    const scope = resolveSearchScopeForRoute({
      route: api.path,
      kind: "api",
      routeScopeOverrides: input.routeScopeOverrides,
    });
    if (!input.scopes.includes(scope)) {
      continue;
    }
    const summary =
      (typeof api.frontmatter.description === "string" &&
        normalizeWhitespace(api.frontmatter.description)) ||
      (api.spec &&
        typeof api.spec === "object" &&
        "info" in api.spec &&
        api.spec.info &&
        typeof (api.spec.info as { description?: unknown }).description === "string"
        ? normalizeWhitespace(
            (api.spec.info as { description: string }).description
          )
        : "");
    documents.push({
      id: api.id,
      scope,
      kind: "api",
      path: api.path,
      title: redactSensitiveText(api.title),
      summary: redactSensitiveText(summary),
      headings: [],
      tags: [],
      body: resolveBodyField({
        bodyIndexing: input.bodyIndexing,
        body: JSON.stringify(api.spec ?? {}),
        summary: redactSensitiveText(summary),
      }),
    });
  }

  for (const post of Object.values(input.manifest.posts)) {
    if (isProtected(post.frontmatter, post.path)) {
      continue;
    }
    const scope = resolveSearchScopeForRoute({
      route: post.path,
      kind: "post",
      defaultScope: post.searchScope ?? post.collectionId ?? "blog",
      routeScopeOverrides: input.routeScopeOverrides,
    });
    if (!input.scopes.includes(scope)) {
      continue;
    }
    documents.push({
      id: post.id,
      scope,
      kind: "post",
      path: post.path,
      title: redactSensitiveText(post.title),
      summary: redactSensitiveText(
        normalizeWhitespace(post.excerpt ?? post.summary ?? summarizeBody(post.body))
      ),
      headings: [],
      tags: post.tags.map((tag) => redactSensitiveText(tag)),
      body: resolveBodyField({
        bodyIndexing: input.bodyIndexing,
        body: post.body,
        summary: redactSensitiveText(
          normalizeWhitespace(post.excerpt ?? post.summary ?? summarizeBody(post.body))
        ),
      }),
    });
  }

  return documents.sort((left, right) => {
    const leftKey = `${left.id}:${left.scope}:${left.path}`;
    const rightKey = `${right.id}:${right.scope}:${right.path}`;
    return leftKey.localeCompare(rightKey, "en", {
      sensitivity: "variant",
      numeric: true,
    });
  });
}

function assertUniqueSearchDocumentIds(documents: DocsSearchDocument[]): void {
  const seen = new Map<string, DocsSearchDocument>();
  for (const document of documents) {
    const existing = seen.get(document.id);
    if (existing) {
      throw createDocsError({
        code: "DOCS_SEARCH_BUILD_FAILED",
        message: `search document id ${document.id} is duplicated across scopes`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_SEARCH_BUILD_FAILED",
            message: `search document id ${document.id} is duplicated across scopes`,
            details: {
              duplicateId: document.id,
              firstScope: existing.scope,
              secondScope: document.scope,
            },
          }),
        ],
      });
    }
    seen.set(document.id, document);
  }
}

function withStableDiagnosticOrder(diagnostics: DocsDiagnostic[]): DocsDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`, "en", {
      sensitivity: "variant",
      numeric: true,
    })
  );
}

export async function buildSearchIndex(
  manifest: DocsManifest,
  options: BuildSearchIndexOptions = {}
): Promise<DocsSearchArtifact> {
  const searchConfig = options.search;
  const enabled = searchConfig?.enabled ?? true;
  const scopes = normalizeScopes(searchConfig, manifest);
  const bodyIndexing = resolveBodyIndexing(searchConfig);
  const searchAdapter = options.searchAdapter ?? getDefaultDocsSearchEngineAdapter();
  normalizeRouteScopeOverrides(searchConfig?.routeScopeOverrides);
  const diagnostics: DocsDiagnostic[] = [];

  if (!enabled) {
    const emptyArtifact: DocsSearchArtifact = {
      schemaVersion: 1,
      engine: searchAdapter.name,
      fields: SEARCH_FIELDS,
      scopes,
      bodyIndexing,
      documents: [],
      snapshot: createEmptySnapshot(),
      diagnostics: [],
      bytes: 0,
    };
    const serialized = JSON.stringify(emptyArtifact);
    return {
      ...emptyArtifact,
      bytes: Buffer.byteLength(serialized, "utf8"),
    };
  }

  const documents = collectSearchDocuments({
    manifest,
    scopes,
    auth: options.auth,
    bodyIndexing,
    routeScopeOverrides: searchConfig?.routeScopeOverrides,
  });
  assertUniqueSearchDocumentIds(documents);

  const engine = await searchAdapter.createIndexEngine({ fields: SEARCH_FIELDS });
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
      store: {
        id: document.id,
        scope: document.scope,
        kind: document.kind,
        path: document.path,
        title: document.title,
        summary: document.summary,
      },
    });
  }

  const snapshot = engine.exportSnapshot();
  const artifactBase: Omit<DocsSearchArtifact, "bytes"> = {
    schemaVersion: 1,
    engine: searchAdapter.name,
    fields: SEARCH_FIELDS,
    scopes,
    bodyIndexing,
    documents,
    snapshot,
    diagnostics: [],
  };

  let bytes = Buffer.byteLength(JSON.stringify(artifactBase), "utf8");
  if (
    typeof searchConfig?.maxArtifactBytes === "number" &&
    bytes > searchConfig.maxArtifactBytes
  ) {
    diagnostics.push(
      createDiagnostic({
        code: "DOCS_ARTIFACT_INVALID",
        severity: "warning",
        message: `search artifact size ${bytes} exceeds configured maxArtifactBytes ${searchConfig.maxArtifactBytes}`,
        details: {
          bytes,
          maxArtifactBytes: searchConfig.maxArtifactBytes,
        },
      })
    );
  }

  const artifact: DocsSearchArtifact = {
    ...artifactBase,
    diagnostics: withStableDiagnosticOrder(diagnostics),
    bytes: 0,
  };
  bytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
  artifact.bytes = bytes;

  return artifact;
}
