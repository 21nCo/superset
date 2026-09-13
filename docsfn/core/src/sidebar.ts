import { buildSidebarFromPages } from "./navigation";
import type { NormalizedPageRecord } from "./normalize";
import type { DocPage, Sidebar } from "./types";

function pageToNormalized(page: DocPage): NormalizedPageRecord {
  const sourcePath = page.slug.length > 0 ? page.slug : "index";
  const segments = sourcePath.split("/").filter(Boolean);
  const sourceName = segments[segments.length - 1] ?? "index";
  const sourceDirectory = segments.slice(0, -1).join("/");

  return {
    id: page.id,
    collection: "docs",
    sourcePath,
    sourceDirectory,
    sourceName,
    slug: page.slug,
    path: page.path,
    version: page.version,
    title: page.title,
    description: page.description,
    body: page.body,
    headings: page.headings,
    frontmatter: page.frontmatter,
  };
}

export function buildAutoSidebar(pages: DocPage[]): Sidebar {
  const slugs = new Set(pages.map((page) => page.slug));
  const normalized = pages
    .map((page) => {
      const hasChildren = [...slugs].some(
        (candidate) => candidate !== page.slug && candidate.startsWith(`${page.slug}/`)
      );
      if (page.slug.length > 0 && hasChildren) {
        return pageToNormalized({
          ...page,
          slug: `${page.slug}/index`,
        });
      }
      return pageToNormalized(page);
    })
    .sort((left, right) =>
    left.path.localeCompare(right.path, "en", { sensitivity: "variant", numeric: true })
    );
  return buildSidebarFromPages({
    pages: normalized,
    metaByDirectory: new Map(),
    id: "default",
  });
}
