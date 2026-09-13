import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { digestJson, sha256 } from "./canonical.js";
import type { ContextAdapter, ContextManifest, ContextRequest, ContextSource, PreflightResult } from "./types.js";

async function collectMarkdown(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const next = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await collectMarkdown(root, next));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(next);
  }
  return result;
}

function safeRelative(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) throw new Error(`Context path escapes repository: ${input}`);
  return normalized;
}

async function expandPaths(root: string, patterns: readonly string[]): Promise<string[]> {
  const allMarkdown = patterns.some((value) => value.includes("*")) ? await collectMarkdown(root) : [];
  const selected = new Set<string>();
  for (const raw of patterns) {
    const pattern = safeRelative(raw);
    if (pattern === "**/*.md" || pattern.endsWith("/**/*.md")) {
      const prefix = pattern === "**/*.md" ? "" : pattern.slice(0, -"**/*.md".length);
      for (const candidate of allMarkdown) if (candidate.startsWith(prefix)) selected.add(candidate);
    } else if (!pattern.includes("*")) selected.add(pattern);
    else throw new Error(`Unsupported context glob ${raw}; use an exact path or **/*.md.`);
  }
  return [...selected].sort();
}

export class RepositoryMarkdownContextAdapter implements ContextAdapter {
  public readonly id = "repository-markdown";

  public async preflight(request: ContextRequest): Promise<PreflightResult> {
    const diagnostics = [];
    if (!request.paths?.length) diagnostics.push({ code: "REVIEWFN_MARKDOWN_PATHS_REQUIRED", level: "error" as const, message: "Repository Markdown context requires at least one path." });
    try { await realpath(request.root); } catch { diagnostics.push({ code: "REVIEWFN_ROOT_MISSING", level: "error" as const, message: "Repository root is unavailable." }); }
    return { ok: diagnostics.every((item) => item.level !== "error"), diagnostics };
  }

  public async fetch(request: ContextRequest): Promise<Omit<ContextManifest, "digest">> {
    const root = await realpath(request.root);
    const sources: ContextSource[] = [];
    const incompleteReasons: string[] = [];
    let consumed = 0;
    const paths = await expandPaths(root, request.paths ?? []);
    for (const relative of paths) {
      if (sources.length >= request.limits.maxSources) { incompleteReasons.push(`Repository Markdown source limit ${request.limits.maxSources} reached.`); break; }
      const absolute = path.join(root, relative);
      try {
        const stat = await lstat(absolute);
        const resolved = await realpath(absolute);
        if (stat.isSymbolicLink() || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) throw new Error("symlink or path escape refused");
        const content = await readFile(resolved, "utf8");
        const remaining = request.limits.maxBytes - consumed;
        if (remaining <= 0) { incompleteReasons.push(`Repository Markdown byte limit ${request.limits.maxBytes} reached.`); break; }
        const bytes = Buffer.byteLength(content);
        const available = bytes <= remaining ? content : Buffer.from(content).subarray(0, remaining).toString("utf8");
        const status = bytes <= remaining ? "available" as const : "truncated" as const;
        sources.push({ id: `repo:${relative}`, type: "repository_markdown", canonicalUrl: `repo://${relative}`, retrievedAt: new Date().toISOString(), updatedAt: stat.mtime.toISOString(), digest: sha256(available), status, content: available });
        consumed += Buffer.byteLength(available);
        if (status === "truncated") { incompleteReasons.push(`${relative} was truncated by the context byte limit.`); break; }
      } catch (error) {
        sources.push({ id: `repo:${relative}`, type: "repository_markdown", canonicalUrl: `repo://${relative}`, retrievedAt: new Date().toISOString(), digest: sha256(""), status: "failed", error: error instanceof Error ? error.message : String(error) });
        incompleteReasons.push(`Unable to read ${relative}.`);
      }
    }
    return { version: 1, sources, selection: { candidates: paths, selected: sources.filter((source) => source.status === "available").map((source) => source.id), rule: "configured repository Markdown paths" }, limits: request.limits, incompleteReasons };
  }
}

export function finalizeContextManifest(input: Omit<ContextManifest, "digest">): ContextManifest {
  return { ...input, digest: digestJson(input) };
}

export function combineContextManifests(manifests: readonly Omit<ContextManifest, "digest">[], limits: ContextManifest["limits"]): ContextManifest {
  const sources = manifests.flatMap((manifest) => manifest.sources);
  const duplicateIds = sources.map((source) => source.id).filter((id, index, values) => values.indexOf(id) !== index);
  const incompleteReasons = [...new Set([...manifests.flatMap((manifest) => manifest.incompleteReasons), ...duplicateIds.map((id) => `Duplicate context source ${id}.`)])];
  const combined = {
    version: 1 as const,
    sources,
    selection: {
      candidates: [...new Set(manifests.flatMap((manifest) => manifest.selection.candidates))],
      selected: [...new Set(manifests.flatMap((manifest) => manifest.selection.selected))],
      rule: manifests.map((manifest) => manifest.selection.rule).join("; "),
    },
    limits,
    incompleteReasons,
  };
  return finalizeContextManifest(combined);
}
