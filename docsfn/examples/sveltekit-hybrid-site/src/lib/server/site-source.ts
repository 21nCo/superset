import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  buildManifest,
  type DocPage,
  type DocsCompatPreset,
  type DocsConfig,
  type DocsManifest,
} from "@docsfn/core";
import { FsContentProvider } from "@docsfn/provider-fs";
import docsConfig, { papersConfig } from "../../../docsfn.config";

export interface HybridManifestSource {
  manifest: DocsManifest;
  compatPreset: DocsCompatPreset;
  basePath: string;
  canonicalUrl?: string;
}

export interface HybridSiteSource {
  appRoot: string;
  siteTitle: string;
  canonicalUrl?: string;
  docs: HybridManifestSource;
  papers: HybridManifestSource;
}

const appRoot = process.cwd();

let sourcePromise: Promise<HybridSiteSource> | null = null;
let sourceSignature = "";

async function contentSignature(roots: string[]): Promise<string> {
  const parts: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let info;
    try {
      info = await stat(current);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
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
        stack.push(path.join(current, entry.name));
      }
      continue;
    }
    parts.push(`${current}\0${info.mtimeMs}\0${info.size}`);
  }
  parts.sort();
  return parts.join("\n");
}

async function buildManifestSource(config: DocsConfig): Promise<HybridManifestSource> {
  const provider = new FsContentProvider({ root: appRoot });
  const manifest = await buildManifest(provider, config);

  return {
    manifest,
    compatPreset: config.compat?.preset ?? "none",
    basePath: config.site.basePath ?? "/docs",
    canonicalUrl: config.site.canonicalUrl
  };
}

export async function loadHybridSiteSource(): Promise<HybridSiteSource> {
  const createSource = async () => {
    const [docs, papers] = await Promise.all([
      buildManifestSource(docsConfig),
      buildManifestSource(papersConfig)
    ]);

    return {
      appRoot,
      siteTitle: docsConfig.site.title,
      canonicalUrl: docsConfig.site.canonicalUrl,
      docs,
      papers
    };
  };

  if (process.env.NODE_ENV === "development") {
    const signature = await contentSignature([
      path.join(appRoot, "content"),
      path.join(appRoot, "docsfn.config.ts"),
      path.join(appRoot, "docsfn.config.js"),
      path.join(appRoot, "docsfn.config.mjs"),
    ]);
    if (!sourcePromise || signature !== sourceSignature) {
      sourceSignature = signature;
      sourcePromise = createSource().catch((error) => {
        sourcePromise = null;
        sourceSignature = "";
        throw error;
      });
    }
    return sourcePromise;
  }

  sourcePromise ??= createSource();
  return sourcePromise;
}

export function getStandalonePageByPath(
  manifest: DocsManifest,
  routePath: string
): DocPage | null {
  const pageId = manifest.routes[routePath];
  if (!pageId) {
    return null;
  }

  return manifest.pages[pageId] ?? null;
}

export function getPaperLandingPages(manifest: DocsManifest): DocPage[] {
  return Object.values(manifest.pages)
    .filter((page) => page.slug.length > 0 && !page.slug.includes("/"))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}
