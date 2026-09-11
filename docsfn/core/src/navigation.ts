import { createDiagnostic, createDocsError } from "./diagnostics";
import { normalizeSlug } from "./routing";
import type { DocsConfig, Sidebar, SidebarItem } from "./types";
import type { MetaDocument, MetaPageRule, NormalizedPageRecord } from "./normalize";

interface DirectoryNode {
  directory: string;
  indexPage?: NormalizedPageRecord;
  files: Map<string, NormalizedPageRecord>;
  children: Map<string, DirectoryNode>;
}

export interface NavigationBreadcrumbItem {
  label: string;
  href: string;
}

export interface NavigationPaginationLinks {
  prev?: {
    title: string;
    path: string;
  };
  next?: {
    title: string;
    path: string;
  };
}

function titleFromKey(key: string): string {
  return key
    .split(/[-_]/g)
    .map((segment) =>
      segment.length > 0
        ? `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`
        : segment
    )
    .join(" ");
}

function mergeRuleLabel(rule: MetaPageRule | undefined, fallback: string): string {
  return rule?.label ?? fallback;
}

function rulePresentation(
  rule: MetaPageRule | undefined,
  fallbackDescription?: string
): Pick<SidebarItem, "icon" | "badge" | "description"> {
  return {
    icon: rule?.icon,
    badge: rule?.badge,
    description: rule?.description ?? fallbackDescription,
  };
}

function ensureDirectory(root: DirectoryNode, segments: string[]): DirectoryNode {
  let node = root;
  let currentDirectory = root.directory;
  for (const segment of segments) {
    currentDirectory = currentDirectory ? `${currentDirectory}/${segment}` : segment;
    const existing = node.children.get(segment);
    if (existing) {
      node = existing;
      continue;
    }
    const created: DirectoryNode = {
      directory: currentDirectory,
      files: new Map(),
      children: new Map(),
    };
    node.children.set(segment, created);
    node = created;
  }
  return node;
}

function buildDirectoryGraph(pages: NormalizedPageRecord[]): DirectoryNode {
  const root: DirectoryNode = {
    directory: "",
    files: new Map(),
    children: new Map(),
  };

  for (const page of pages) {
    const sourcePath = normalizeSlug(page.sourcePath);
    const segments = sourcePath.length > 0 ? sourcePath.split("/") : [];
    if (segments.length === 0 || (segments.length === 1 && segments[0] === "index")) {
      root.indexPage = page;
      continue;
    }

    if (segments[segments.length - 1] === "index") {
      const node = ensureDirectory(root, segments.slice(0, -1));
      node.indexPage = page;
      continue;
    }

    const node = ensureDirectory(root, segments.slice(0, -1));
    node.files.set(segments[segments.length - 1], page);
  }

  return root;
}

function regexFromGlob(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");

  return new RegExp(`^${escaped}$`);
}

function ruleMap(meta: MetaDocument | undefined): Map<string, MetaPageRule> {
  const mapped = new Map<string, MetaPageRule>();
  for (const pageRule of meta?.pages ?? []) {
    mapped.set(normalizeSlug(pageRule.key), pageRule);
  }
  return mapped;
}

function orderedKeys(input: {
  node: DirectoryNode;
  meta?: MetaDocument;
  strictMetaReferences?: boolean;
}): string[] {
  const existing = new Set<string>();
  if (input.node.indexPage) {
    existing.add("index");
  }
  for (const key of input.node.files.keys()) {
    existing.add(key);
  }
  for (const key of input.node.children.keys()) {
    existing.add(key);
  }

  const order: string[] = [];
  const seen = new Set<string>();
  for (const rule of input.meta?.pages ?? []) {
    const key = normalizeSlug(rule.key);
    if (!existing.has(key)) {
      if (input.strictMetaReferences ?? true) {
        throw createDocsError({
          code: "DOCS_META_INVALID",
          message: `meta.json references unknown page id ${key}`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_META_INVALID",
              message: `meta.json references unknown page id ${key}`,
              details: {
                directory: input.node.directory,
                key,
              },
            }),
          ],
        });
      }
      continue;
    }
    if (!seen.has(key)) {
      order.push(key);
      seen.add(key);
    }
  }

  const remaining = Array.from(existing).filter((key) => !seen.has(key));
  remaining.sort((left, right) => {
    if (left === "index" && right !== "index") {
      return -1;
    }
    if (right === "index" && left !== "index") {
      return 1;
    }
    return left.localeCompare(right, "en", { sensitivity: "variant", numeric: true });
  });

  return [...order, ...remaining];
}

function renderDirectory(input: {
  node: DirectoryNode;
  metaByDirectory: Map<string, MetaDocument>;
  suppressIndexForFlattening?: boolean;
  strictMetaReferences?: boolean;
}): SidebarItem[] {
  const meta = input.metaByDirectory.get(input.node.directory);
  const rules = ruleMap(meta);
  const keys = orderedKeys({
    node: input.node,
    meta,
    strictMetaReferences: input.strictMetaReferences,
  });
  const items: SidebarItem[] = [];

  for (const key of keys) {
    const rule = rules.get(key);
    if (rule?.hidden) {
      continue;
    }

    if (key === "index" && input.node.indexPage) {
      if (input.suppressIndexForFlattening) {
        continue;
      }
      items.push({
        type: "link",
        text: mergeRuleLabel(rule, input.node.indexPage.title),
        link: input.node.indexPage.path,
        ...rulePresentation(rule, input.node.indexPage.description),
      });
      continue;
    }

    const filePage = input.node.files.get(key);
    if (filePage) {
      items.push({
        type: "link",
        text: mergeRuleLabel(rule, filePage.title),
        link: filePage.path,
        ...rulePresentation(rule, filePage.description),
      });
      continue;
    }

    const childDirectory = input.node.children.get(key);
    if (!childDirectory) {
      continue;
    }

    const childMeta = input.metaByDirectory.get(childDirectory.directory);
    const childItems = renderDirectory({
      node: childDirectory,
      metaByDirectory: input.metaByDirectory,
      suppressIndexForFlattening: Boolean(childMeta?.root),
      strictMetaReferences: input.strictMetaReferences,
    });
    const childLabel = mergeRuleLabel(
      rule,
      childMeta?.title ?? titleFromKey(key)
    );

    if (childMeta?.root) {
      if (childDirectory.indexPage) {
        items.push({
          type: "link",
          text: childLabel,
          link: childDirectory.indexPage.path,
          ...rulePresentation(
            rule,
            rule?.description ?? childMeta?.description ?? childDirectory.indexPage.description
          ),
        });
      }
      items.push(...childItems);
      continue;
    }

    items.push({
      type: "group",
      text: childLabel,
      items: childItems,
      expanded: rule?.expanded ?? false,
      ...rulePresentation(rule, childMeta?.description),
    });
  }

  return items;
}

export function buildSidebarFromPages(input: {
  pages: NormalizedPageRecord[];
  metaByDirectory: Map<string, MetaDocument>;
  id: string;
  strictMetaReferences?: boolean;
}): Sidebar {
  const graph = buildDirectoryGraph(input.pages);
  const items = renderDirectory({
    node: graph,
    metaByDirectory: input.metaByDirectory,
    strictMetaReferences: input.strictMetaReferences,
  });

  return {
    id: input.id,
    items,
  };
}

function matchesPattern(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => regexFromGlob(pattern).test(value));
}

export function buildSidebars(input: {
  pages: NormalizedPageRecord[];
  metaByDirectory: Map<string, MetaDocument>;
  config: DocsConfig;
}): Record<string, Sidebar> {
  const docsPages = input.pages.filter((page) => page.collection === "docs");
  const sidebars: Record<string, Sidebar> = {};

  sidebars.default = buildSidebarFromPages({
    pages: docsPages,
    metaByDirectory: input.metaByDirectory,
    id: "default",
    strictMetaReferences: true,
  });

  const configuredSidebars = input.config.navigation?.sidebars ?? {};
  for (const [sidebarId, definition] of Object.entries(configuredSidebars)) {
    const includePatterns = definition.include ?? [];
    const filtered = docsPages.filter((page) =>
      matchesPattern(`docs/${page.sourcePath}`, includePatterns)
    );
    sidebars[sidebarId] = buildSidebarFromPages({
      pages: filtered,
      metaByDirectory: input.metaByDirectory,
      id: sidebarId,
      strictMetaReferences: false,
    });
    sidebars[sidebarId].title = definition.title;
    sidebars[sidebarId].root = definition.root;
  }

  return sidebars;
}

export function flattenSidebarLinks(sidebar: Sidebar): Array<{ label: string; path: string }> {
  const links: Array<{ label: string; path: string }> = [];

  function walk(items: SidebarItem[]): void {
    for (const item of items) {
      if (item.type === "link" && item.link) {
        links.push({ label: item.text, path: item.link });
      } else if (item.type === "group" && item.items) {
        walk(item.items);
      }
    }
  }

  walk(sidebar.items);
  return links;
}

function findTrail(items: SidebarItem[], route: string): SidebarItem[] | null {
  for (const item of items) {
    if (item.type === "link" && item.link === route) {
      return [item];
    }

    if (item.type === "group" && item.items) {
      const child = findTrail(item.items, route);
      if (child) {
        return [item, ...child];
      }
    }
  }

  return null;
}

export function resolveBreadcrumbsFromSidebar(input: {
  sidebar: Sidebar;
  route: string;
  rootLabel?: string;
  rootHref?: string;
}): NavigationBreadcrumbItem[] {
  const links = flattenSidebarLinks(input.sidebar);
  const rootLink = links.find((link) => link.path === (input.rootHref ?? "/docs")) ?? links[0];
  const trail = findTrail(input.sidebar.items, input.route);
  if (!trail) {
    throw createDocsError({
      code: "DOCS_ROUTE_NOT_FOUND",
      message: `route ${input.route} is not present in the requested sidebar`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ROUTE_NOT_FOUND",
          message: `route ${input.route} is not present in the requested sidebar`,
          details: {
            route: input.route,
            sidebarId: input.sidebar.id,
          },
        }),
      ],
    });
  }

  const breadcrumbs: NavigationBreadcrumbItem[] = [];
  if (rootLink) {
    breadcrumbs.push({
      label: input.rootLabel ?? rootLink.label,
      href: input.rootHref ?? rootLink.path,
    });
  }

  for (const item of trail) {
    if (item.type === "group") {
      const groupFirstLink = flattenSidebarLinks({
        id: input.sidebar.id,
        items: item.items ?? [],
      })[0];
      if (groupFirstLink) {
        breadcrumbs.push({
          label: item.text,
          href: groupFirstLink.path,
        });
      }
      continue;
    }
    if (item.link) {
      const last = breadcrumbs[breadcrumbs.length - 1];
      if (last && last.href === item.link && last.label === item.text) {
        continue;
      }
      breadcrumbs.push({
        label: item.text,
        href: item.link,
      });
    }
  }

  return breadcrumbs;
}

export function resolvePaginationFromSidebar(input: {
  sidebar: Sidebar;
  route: string;
}): NavigationPaginationLinks {
  const links = flattenSidebarLinks(input.sidebar);
  const index = links.findIndex((link) => link.path === input.route);
  if (index === -1) {
    throw createDocsError({
      code: "DOCS_ROUTE_NOT_FOUND",
      message: `route ${input.route} is not present in the requested sidebar`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ROUTE_NOT_FOUND",
          message: `route ${input.route} is not present in the requested sidebar`,
          details: {
            route: input.route,
            sidebarId: input.sidebar.id,
          },
        }),
      ],
    });
  }

  return {
    prev:
      index > 0
        ? {
            title: links[index - 1].label,
            path: links[index - 1].path,
          }
        : undefined,
    next:
      index < links.length - 1
        ? {
            title: links[index + 1].label,
            path: links[index + 1].path,
          }
        : undefined,
  };
}

export function resolveSidebarForRoute(input: {
  sidebars: Record<string, Sidebar>;
  route: string;
}): string | null {
  const sidebarIds = Object.keys(input.sidebars).sort((left, right) => {
    if (left === "default" && right !== "default") {
      return 1;
    }
    if (right === "default" && left !== "default") {
      return -1;
    }
    return left.localeCompare(right, "en", { sensitivity: "variant", numeric: true });
  });

  for (const sidebarId of sidebarIds) {
    const links = flattenSidebarLinks(input.sidebars[sidebarId]);
    if (links.some((link) => link.path === input.route)) {
      return sidebarId;
    }
  }

  return null;
}
