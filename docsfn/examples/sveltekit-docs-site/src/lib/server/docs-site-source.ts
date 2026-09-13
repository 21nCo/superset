import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  buildManifest,
  buildSearchIndex,
  createDocsSearchRuntime,
  loadDocsConfig,
  type DocsCompatPreset,
  type DocsManifest,
  type DocsSearchArtifact,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";

export interface DocsSiteSource {
  fixtureRoot: string;
  manifest: DocsManifest;
  searchArtifact: DocsSearchArtifact;
  searchProbe: {
    query: string;
    resultCount: number;
    firstPath?: string;
    scopes: string[];
  };
  siteTitle: string;
  canonicalUrl?: string;
  compatPreset: DocsCompatPreset;
}

const defaultFixtureRoot = path.resolve(
  process.cwd(),
  "../../test-fixtures/repo/searchfn-docs"
);

let sourcePromise: Promise<DocsSiteSource> | null = null;
let sourceSignature = "";

async function contentSignature(root: string): Promise<string> {
  const parts: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      try {
        const info = await stat(fullPath);
        parts.push(`${path.relative(root, fullPath)}\0${info.mtimeMs}\0${info.size}`);
      } catch {
        continue;
      }
    }
  }
  parts.sort();
  return parts.join("\n");
}

function resolveFixtureRoot(): string {
  const override = process.env.DOCSFN_FIXTURE_ROOT;
  return override?.trim() ? path.resolve(process.cwd(), override) : defaultFixtureRoot;
}

async function buildSearchProbe(
  searchArtifact: DocsSearchArtifact
): Promise<DocsSiteSource["searchProbe"]> {
  const probeQuery =
    searchArtifact.documents.find((document) => document.title.trim().length > 0)?.title ??
    searchArtifact.documents[0]?.summary ??
    "docs";
  const results = await createDocsSearchRuntime({ artifact: searchArtifact }).query({
    query: probeQuery,
    limit: 5,
  });
  return {
    query: probeQuery,
    resultCount: results.length,
    firstPath: results[0]?.path,
    scopes: [...searchArtifact.scopes],
  };
}

async function createDocsSiteSource(): Promise<DocsSiteSource> {
  const fixtureRoot = resolveFixtureRoot();
  const config = await loadDocsConfig({ cwd: fixtureRoot });
  config.blog = { routeBase: "/blog", feedPath: "/blog/rss.xml" };
  const manifest = await buildManifest(new FsContentProvider({ root: fixtureRoot }), config);
  const searchArtifact = await buildSearchIndex(manifest, {
    search: config.search,
    auth: config.auth,
  });
  return {
    fixtureRoot,
    manifest,
    searchArtifact,
    searchProbe: await buildSearchProbe(searchArtifact),
    siteTitle: config.site.title,
    canonicalUrl: config.site.canonicalUrl,
    compatPreset: config.compat?.preset ?? "none",
  };
}

export async function loadDocsSiteSource(): Promise<DocsSiteSource> {
  if (process.env.NODE_ENV === "development") {
    const signature = await contentSignature(resolveFixtureRoot());
    if (!sourcePromise || signature !== sourceSignature) {
      sourceSignature = signature;
      sourcePromise = createDocsSiteSource().catch((error) => {
        sourcePromise = null;
        sourceSignature = "";
        throw error;
      });
    }
    return sourcePromise;
  }
  sourcePromise ??= createDocsSiteSource();
  return sourcePromise;
}
