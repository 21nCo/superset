import path from "node:path";
import {
  buildManifest,
  buildSearchIndex,
  compileSvelteContent,
  createDiagnostic,
  createDocsError,
  createDocsSearchRuntime,
  loadDocsConfig,
  resolveMarkdownRelativeLinks,
  type CompiledContentArtifact,
  type DocsCompatPreset,
  type DocsConfig,
  type DocsManifest,
  type DocsSearchArtifact,
  type DocsSearchRuntime,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

export interface DocsSiteSource {
  siteRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
  config: DocsConfig;
}

export interface DocsSiteCompiledCacheSummary {
  framework: "svelte";
  compatPreset: DocsCompatPreset;
  pageKeys: string[];
  postKeys: string[];
}

interface DocsSiteCompiledContentCache {
  framework: "svelte";
  compatPreset: DocsCompatPreset;
  pages: Map<string, CompiledContentArtifact>;
  posts: Map<string, CompiledContentArtifact>;
  pageKeysById: Record<string, string>;
  postKeysById: Record<string, string>;
}

interface DocsSiteServerState {
  source: DocsSiteSource;
  compiledCache: DocsSiteCompiledContentCache;
}

let serverStatePromise: Promise<DocsSiteServerState> | null = null;

function shouldCacheServerState(): boolean {
  return process.env.NODE_ENV !== "development";
}

function createCompiledCacheKey(input: {
  kind: "page" | "post";
  id: string;
  framework: "svelte";
  compatPreset: DocsCompatPreset;
}): string {
  return [input.kind, input.id, input.framework, input.compatPreset].join("|");
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.id.localeCompare(right.id, "en", {
      sensitivity: "variant",
      numeric: true,
    })
  );
}

function createCompiledCache(input: {
  manifest: DocsManifest;
  compatPreset: DocsCompatPreset;
}): DocsSiteCompiledContentCache {
  const framework = "svelte" as const;
  const pages = new Map<string, CompiledContentArtifact>();
  const posts = new Map<string, CompiledContentArtifact>();
  const pageKeysById: Record<string, string> = {};
  const postKeysById: Record<string, string> = {};

  for (const page of sortById(Object.values(input.manifest.pages))) {
    const key = createCompiledCacheKey({
      kind: "page",
      id: page.id,
      framework,
      compatPreset: input.compatPreset,
    });
    pageKeysById[page.id] = key;
    pages.set(
      key,
      resolveMarkdownRelativeLinks({
        compiled: compileSvelteContent({
          source: page.body,
          sourcePath: page.id,
          compatPreset: input.compatPreset,
        }),
        route: page.path,
        sourcePath: page.id,
      })
    );
  }

  for (const post of sortById(Object.values(input.manifest.posts))) {
    const key = createCompiledCacheKey({
      kind: "post",
      id: post.id,
      framework,
      compatPreset: input.compatPreset,
    });
    postKeysById[post.id] = key;
    posts.set(
      key,
      resolveMarkdownRelativeLinks({
        compiled: compileSvelteContent({
          source: post.body,
          sourcePath: post.id,
          compatPreset: input.compatPreset,
        }),
        route: post.path,
        sourcePath: post.id,
      })
    );
  }

  return {
    framework,
    compatPreset: input.compatPreset,
    pages,
    posts,
    pageKeysById,
    postKeysById,
  };
}

function getCompiledArtifactOrThrow(input: {
  kind: "page" | "post";
  id: string;
  cache: DocsSiteCompiledContentCache;
}): CompiledContentArtifact {
  const keysById =
    input.kind === "page" ? input.cache.pageKeysById : input.cache.postKeysById;
  const entries = input.kind === "page" ? input.cache.pages : input.cache.posts;
  const key = keysById[input.id];

  if (!key) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: `compiled ${input.kind} cache key is missing for ${input.id}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: `compiled ${input.kind} cache key is missing for ${input.id}`,
          details: {
            kind: input.kind,
            id: input.id,
          },
        }),
      ],
    });
  }

  const compiled = entries.get(key);
  if (!compiled) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: `compiled ${input.kind} artifact is missing for ${input.id}`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: `compiled ${input.kind} artifact is missing for ${input.id}`,
          details: {
            kind: input.kind,
            id: input.id,
            key,
          },
        }),
      ],
    });
  }

  return compiled;
}

async function createDocsSiteServerState(): Promise<DocsSiteServerState> {
  const siteRoot = path.resolve(process.cwd());
  const config = await loadDocsConfig({ cwd: siteRoot });
  const changelog = config.collections?.changelog;
  if (changelog && ((changelog.routeBase ?? "/changelog") !== "/changelog" || (changelog.feedPath ?? "/changelog/rss.xml") !== "/changelog/rss.xml")) {
    throw new Error("This site's changelog routes are mounted at /changelog and /changelog/rss.xml. Update the SvelteKit route files before changing those collection paths.");
  }
  const provider = new FsContentProvider({
    root: siteRoot,
    docsDir: config.content.docsDir,
    pagesDir: config.content.pagesDir,
    blogDir: config.content.blogDir,
    apiDir: config.content.apiDir,
    assetsDir: config.content.assetsDir,
  });
  const manifest = await buildManifest(provider, config);
  const searchArtifact = await buildSearchIndex(manifest, {
    search: config.search,
    auth: config.auth,
  });
  const compatPreset = config.compat?.preset ?? "none";
  const compiledCache = createCompiledCache({
    manifest,
    compatPreset,
  });

  return {
    source: {
      siteRoot,
      manifest,
      searchArtifact,
      siteTitle: config.site.title,
      canonicalUrl: config.site.canonicalUrl,
      compatPreset,
      config,
    },
    compiledCache,
  };
}

async function loadDocsSiteServerState(): Promise<DocsSiteServerState> {
  if (!shouldCacheServerState()) {
    return createDocsSiteServerState();
  }

  if (!serverStatePromise) {
    serverStatePromise = createDocsSiteServerState();
  }

  return serverStatePromise;
}

export async function loadDocsSiteSource(): Promise<DocsSiteSource> {
  const state = await loadDocsSiteServerState();
  return state.source;
}

export async function getCompiledDocsPage(pageId: string): Promise<CompiledContentArtifact> {
  const state = await loadDocsSiteServerState();
  return getCompiledArtifactOrThrow({
    kind: "page",
    id: pageId,
    cache: state.compiledCache,
  });
}

export async function getCompiledDocsPost(postId: string): Promise<CompiledContentArtifact> {
  const state = await loadDocsSiteServerState();
  return getCompiledArtifactOrThrow({
    kind: "post",
    id: postId,
    cache: state.compiledCache,
  });
}

export async function getDocsSiteCompiledCacheSummary(): Promise<DocsSiteCompiledCacheSummary> {
  const state = await loadDocsSiteServerState();
  return {
    framework: state.compiledCache.framework,
    compatPreset: state.compiledCache.compatPreset,
    pageKeys: [...state.compiledCache.pages.keys()].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
    ),
    postKeys: [...state.compiledCache.posts.keys()].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
    ),
  };
}

export async function createDocsSiteSearchRuntime(): Promise<DocsSearchRuntime> {
  const state = await loadDocsSiteServerState();
  return createDocsSearchRuntime({
    artifact: state.source.searchArtifact,
  });
}
