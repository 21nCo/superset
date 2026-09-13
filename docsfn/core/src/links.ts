import type { CompiledContentArtifact, CompiledContentBlock } from "./types";

export interface ResolveMarkdownRelativeLinksInput {
  compiled: CompiledContentArtifact;
  route: string;
  sourcePath?: string;
  isIndexRoute?: boolean;
}

const EXTERNAL_OR_SPECIAL_HREF_REGEX = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/|\{)/i;

export function resolveMarkdownRelativeLinks({
  compiled,
  route,
  sourcePath,
  isIndexRoute = false,
}: ResolveMarkdownRelativeLinksInput): CompiledContentArtifact {
  const baseRoute = resolveBaseRoute(route, sourcePath, isIndexRoute);

  return {
    ...compiled,
    blocks: resolveBlocks(compiled.blocks, baseRoute, route),
  };
}

function resolveBlocks(
  blocks: CompiledContentBlock[],
  baseRoute: string,
  route: string,
): CompiledContentBlock[] {
  return blocks.map((block) => {
    if ("html" in block) {
      return {
        ...block,
        html: resolveHtmlLinks(block.html, baseRoute, route),
      };
    }

    if (block.type === "tabs") {
      return {
        ...block,
        tabs: block.tabs.map((tab) => ({
          ...tab,
          nodes: resolveBlocks(tab.nodes, baseRoute, route),
        })),
      };
    }

    if (block.type === "component") {
      return {
        ...block,
        children: resolveBlocks(block.children, baseRoute, route),
      };
    }

    return block;
  });
}

function resolveHtmlLinks(html: string, baseRoute: string, route: string): string {
  const normalizedRoute = normalizeAbsolutePath(route);
  let result = "";
  let cursor = 0;
  for (const tag of findAnchorTags(html)) {
    result += html.slice(cursor, tag.start);
    result += rewriteAnchorHref(tag.value, baseRoute, normalizedRoute);
    cursor = tag.end;
  }
  result += html.slice(cursor);
  return result;
}

function findAnchorTags(html: string): Array<{ start: number; end: number; value: string }> {
  const tags: Array<{ start: number; end: number; value: string }> = [];
  const opener = /<a\b/gi;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html))) {
    const end = findQuotedTagEnd(html, match.index + match[0].length);
    if (end === -1) {
      break;
    }
    tags.push({ start: match.index, end, value: html.slice(match.index, end) });
    opener.lastIndex = end;
  }
  return tags;
}

function findQuotedTagEnd(html: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return index + 1;
    }
  }
  return -1;
}

function rewriteAnchorHref(tag: string, baseRoute: string, route: string): string {
  const parsed = /^(<a\b)([\s\S]*)(>)$/i.exec(tag);
  if (!parsed) {
    return tag;
  }
  const href = matchHrefAttribute(parsed[2]);
  if (!href || href.value.length === 0) {
    return tag;
  }
  if (EXTERNAL_OR_SPECIAL_HREF_REGEX.test(href.value)) {
    return tag;
  }
  const queryOnly = href.value.startsWith("?");
  const resolvedHref = resolveHref(href.value, queryOnly ? route : baseRoute, queryOnly);
  return `${parsed[1]}${parsed[2].slice(0, href.start)}${href.nameAndEquals}${resolvedHref}${href.quote}${parsed[2].slice(href.end)}${parsed[3]}`;
}

function matchHrefAttribute(attrs: string): {
  start: number;
  end: number;
  nameAndEquals: string;
  quote: string;
  value: string;
} | null {
  let index = 0;
  while (index < attrs.length) {
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (index >= attrs.length) {
      break;
    }
    const nameStart = index;
    while (index < attrs.length && /[^\s=]/.test(attrs[index])) {
      index += 1;
    }
    const name = attrs.slice(nameStart, index);
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    if (attrs[index] !== "=") {
      continue;
    }
    index += 1;
    while (index < attrs.length && /\s/.test(attrs[index])) {
      index += 1;
    }
    const quote = attrs[index];
    if (quote !== '"' && quote !== "'") {
      while (index < attrs.length && !/\s/.test(attrs[index])) {
        index += 1;
      }
      continue;
    }
    index += 1;
    const valueStart = index;
    while (index < attrs.length && attrs[index] !== quote) {
      index += 1;
    }
    const value = attrs.slice(valueStart, index);
    const end = Math.min(index + 1, attrs.length);
    if (name.toLowerCase() === "href") {
      return {
        start: nameStart,
        end,
        nameAndEquals: attrs.slice(nameStart, valueStart),
        quote,
        value,
      };
    }
    index = end;
  }
  return null;
}

function resolveHref(href: string, baseRoute: string, preserveBasePath = false): string {
  try {
    const basePath = preserveBasePath || baseRoute === "/" ? baseRoute : `${baseRoute}/`;
    const resolved = new URL(href, `https://docs.local${basePath}`);
    const pathname = resolved.pathname.replace(/\/index\.mdx?$/i, "/").replace(/\.mdx?$/i, "");
    return `${pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return href;
  }
}

function resolveBaseRoute(
  route: string,
  sourcePath: string | undefined,
  isIndexRoute: boolean,
): string {
  const normalizedRoute = normalizeAbsolutePath(route);

  if (isIndexRoute || (sourcePath && /(?:^|[/:])index\.mdx?$/i.test(sourcePath))) {
    return normalizedRoute;
  }

  const separatorIndex = normalizedRoute.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return "/";
  }

  return normalizedRoute.slice(0, separatorIndex);
}

function normalizeAbsolutePath(path: string): string {
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  let end = prefixed.length;
  while (end > 1 && prefixed.charCodeAt(end - 1) === 47) end -= 1;
  return prefixed.slice(0, end);
}
