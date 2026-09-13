import { isDocsContentProtected } from "./security";
import type { ApiReference, BlogPost, DocPage, DocsConfig, DocsManifest } from "./types";

export interface BuildLlmsTxtOptions {
  /** When provided, prefixes generated links with this absolute origin (eg. "https://authfn.superfunctions.dev"). */
  canonicalUrl?: string;
  /** Auth policy used to omit private content from public LLM artifacts. */
  auth?: DocsConfig["auth"];
  /** Glob-style include patterns (e.g., ["docs/**"]). When omitted, every page is included. */
  includePages?: string[];
  /** Glob-style exclude patterns (e.g., ["docs/blog/**"]). */
  excludePages?: string[];
  /** Whether to append blog posts. Default true. */
  includeBlog?: boolean;
  /** Whether to append OpenAPI summary lines. Default true. */
  includeOpenApi?: boolean;
}

export interface BuildLlmsFullTxtOptions extends BuildLlmsTxtOptions {
  /** Whether to embed full OpenAPI JSON. Default false (a summary is appended instead). */
  embedOpenApiSpec?: boolean;
}

export interface LlmsTxtArtifacts {
  llmsTxt: string;
  llmsFullTxt: string;
}

interface FilteredManifest {
  pages: DocPage[];
  posts: BlogPost[];
  apis: ApiReference[];
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function pathFor(canonicalUrl: string | undefined, route: string): string {
  if (!canonicalUrl) {
    return route;
  }
  let end = canonicalUrl.length;
  while (end > 0 && canonicalUrl.charCodeAt(end - 1) === 47) end -= 1;
  const trimmed = canonicalUrl.slice(0, end);
  const prefixed = route.startsWith("/") ? route : `/${route}`;
  return `${trimmed}${prefixed}`;
}

function trimTrailingNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 10) end -= 1;
  return value.slice(0, end);
}

function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        expression += "(?:.*/)?";
        index += 1;
      } else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${expression}$`);
}

function matchesAnyGlob(value: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function isProtectedContent(
  options: BuildLlmsTxtOptions,
  frontmatter: Record<string, unknown> | undefined,
  route: string
): boolean {
  return isDocsContentProtected({
    auth: options.auth,
    frontmatter,
    route,
  });
}

function selectPages(manifest: DocsManifest, options: BuildLlmsTxtOptions): DocPage[] {
  const include = options.includePages;
  const exclude = options.excludePages;
  const pages = Object.values(manifest.pages);
  return pages
    .filter((page) => {
      if (isProtectedContent(options, page.frontmatter, page.path)) {
        return false;
      }
      if (include && include.length > 0 && !matchesAnyGlob(page.id.replace(":", "/"), include)) {
        return false;
      }
      if (exclude && matchesAnyGlob(page.id.replace(":", "/"), exclude)) {
        return false;
      }
      return true;
    })
    .sort(compareById);
}

function selectPosts(manifest: DocsManifest, options: BuildLlmsTxtOptions): BlogPost[] {
  if (options.includeBlog === false) return [];
  const posts = Object.values(manifest.posts).filter(
    (post) => !post.draft && !isProtectedContent(options, post.frontmatter, post.path)
  );
  return posts.sort(compareById);
}

function selectApis(manifest: DocsManifest, options: BuildLlmsTxtOptions): ApiReference[] {
  if (options.includeOpenApi === false) return [];
  return Object.values(manifest.apis)
    .filter((api) => !isProtectedContent(options, api.frontmatter, api.path))
    .sort(compareById);
}

function filterManifest(manifest: DocsManifest, options: BuildLlmsTxtOptions): FilteredManifest {
  return {
    pages: selectPages(manifest, options),
    posts: selectPosts(manifest, options),
    apis: selectApis(manifest, options),
  };
}

function describePage(page: DocPage): string {
  const description = page.description ?? page.frontmatter?.description;
  return typeof description === "string" && description.length > 0 ? description : page.title;
}

function describePost(post: BlogPost): string {
  return post.summary ?? post.excerpt ?? post.title;
}

function summarizeOpenApiSpec(api: ApiReference): string[] {
  const lines: string[] = [];
  const spec = api.spec?.spec ?? api.spec;
  const paths = spec?.paths;
  if (!paths || typeof paths !== "object") return lines;

  for (const [pathName, methodsRaw] of Object.entries(paths)) {
    if (!methodsRaw || typeof methodsRaw !== "object") continue;
    for (const [method, operationRaw] of Object.entries(methodsRaw as Record<string, unknown>)) {
      if (!["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(method)) continue;
      const operation = operationRaw as
        | { summary?: string; operationId?: string; description?: string }
        | undefined;
      if (!operation || typeof operation !== "object") continue;

      const summary =
        operation.summary ?? operation.description ?? operation.operationId ?? "(no summary)";
      lines.push(`- ${method.toUpperCase()} ${pathName} — ${summary}`);
    }
  }
  return lines;
}

function buildHeader(manifest: DocsManifest): string {
  const lines = [`# ${manifest.site.title}`];
  if (manifest.site.description) {
    lines.push("", `> ${manifest.site.description}`);
  }
  return lines.join("\n");
}

export function buildLlmsTxt(manifest: DocsManifest, options: BuildLlmsTxtOptions = {}): string {
  const filtered = filterManifest(manifest, options);
  const lines: string[] = [];

  lines.push(buildHeader(manifest));
  lines.push("");

  if (filtered.pages.length > 0) {
    lines.push("## Documentation");
    lines.push("");
    for (const page of filtered.pages) {
      const url = pathFor(options.canonicalUrl, page.path);
      lines.push(`- [${page.title}](${url}) — ${describePage(page)}`);
    }
    lines.push("");
  }

  if (filtered.posts.length > 0) {
    lines.push("## Blog");
    lines.push("");
    for (const post of filtered.posts) {
      const url = pathFor(options.canonicalUrl, post.path);
      lines.push(`- [${post.title}](${url}) — ${describePost(post)}`);
    }
    lines.push("");
  }

  if (filtered.apis.length > 0) {
    lines.push("## API Reference");
    lines.push("");
    for (const api of filtered.apis) {
      const url = pathFor(options.canonicalUrl, api.path);
      lines.push(`- [${api.title}](${url})`);
      const summaries = summarizeOpenApiSpec(api);
      for (const summary of summaries) {
        lines.push(`  ${summary}`);
      }
    }
    lines.push("");
  }

  return `${trimTrailingNewlines(lines.join("\n"))}\n`;
}

export function buildLlmsFullTxt(
  manifest: DocsManifest,
  options: BuildLlmsFullTxtOptions = {}
): string {
  const filtered = filterManifest(manifest, options);
  const lines: string[] = [];

  lines.push(buildHeader(manifest));
  lines.push("");
  lines.push(
    "This file concatenates the full text of every documentation page so it can be loaded into",
    "an LLM-based assistant in a single shot. For programmatic access, prefer the MCP server",
    "or the structured manifest emitted alongside this file.",
    ""
  );

  if (filtered.pages.length > 0) {
    lines.push("# Documentation");
    lines.push("");
    for (const page of filtered.pages) {
      lines.push(`<!-- page:${page.id} path:${page.path} -->`);
      lines.push(`# ${page.title}`);
      if (typeof page.description === "string" && page.description.length > 0) {
        lines.push("");
        lines.push(`> ${page.description}`);
      }
      lines.push("");
      lines.push(page.body.trimEnd());
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (filtered.posts.length > 0) {
    lines.push("# Blog");
    lines.push("");
    for (const post of filtered.posts) {
      lines.push(`<!-- post:${post.id} path:${post.path} date:${post.date} -->`);
      lines.push(`# ${post.title}`);
      lines.push("");
      lines.push(post.body.trimEnd());
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (filtered.apis.length > 0) {
    lines.push("# API Reference");
    lines.push("");
    for (const api of filtered.apis) {
      lines.push(`<!-- api:${api.id} path:${api.path} -->`);
      lines.push(`## ${api.title}`);
      lines.push("");
      const summaries = summarizeOpenApiSpec(api);
      if (summaries.length > 0) {
        for (const summary of summaries) {
          lines.push(summary);
        }
        lines.push("");
      }
      if (options.embedOpenApiSpec) {
        const spec = api.spec?.spec ?? api.spec;
        if (spec) {
          lines.push("```json");
          lines.push(JSON.stringify(spec, null, 2));
          lines.push("```");
          lines.push("");
        }
      }
    }
  }

  return `${trimTrailingNewlines(lines.join("\n"))}\n`;
}

export function buildLlmsTxtArtifacts(
  manifest: DocsManifest,
  options: BuildLlmsFullTxtOptions = {}
): LlmsTxtArtifacts {
  return {
    llmsTxt: buildLlmsTxt(manifest, options),
    llmsFullTxt: buildLlmsFullTxt(manifest, options),
  };
}
