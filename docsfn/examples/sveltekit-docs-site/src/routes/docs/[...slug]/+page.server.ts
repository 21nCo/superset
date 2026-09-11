import { error } from "@sveltejs/kit";
import { compileSvelteContent, resolveMarkdownRelativeLinks, getTopNavigation, type SidebarItem } from "@docsfn/core";
import {
  resolveDocsPageSurface,
  resolveDocsRouteDataOrThrow,
  type SvelteDocsPageSurface,
} from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";
import {
  loadDocsSiteSource,
  type DocsSiteSource,
} from "../../../lib/server/docs-site-source";

interface FlattenedSidebarLink {
  label: string;
  path: string;
  depth: number;
}

function flattenSidebarLinks(
  items: SidebarItem[],
  depth = 0,
  links: FlattenedSidebarLink[] = []
): FlattenedSidebarLink[] {
  for (const item of items) {
    if (item.type === "link" && item.link) {
      links.push({
        label: item.text,
        path: item.link,
        depth,
      });
      continue;
    }
    if (item.type === "group" && Array.isArray(item.items)) {
      flattenSidebarLinks(item.items, depth + 1, links);
    }
  }

  return links;
}

function isRouteNotFoundError(input: unknown): input is { message: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    String((input as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND"
  );
}

export const load: PageServerLoad = async ({ params, parent }) => {
  const parentData = await parent();
  const source =
    "source" in parentData
      ? (parentData.source as DocsSiteSource)
      : await loadDocsSiteSource();

  let routeEntry;
  try {
    routeEntry = resolveDocsRouteDataOrThrow(params.slug, source.manifest, {
      basePath: "/docs",
    });
  } catch (routeError) {
    if (isRouteNotFoundError(routeError)) {
      throw error(404, routeError.message);
    }
    throw routeError;
  }

  if (routeEntry.kind === "post") {
    throw error(404, `unsupported docs route kind: ${routeEntry.kind}`);
  }

  const surface: SvelteDocsPageSurface = routeEntry.kind === "api"
    ? {
        route: routeEntry.route,
        title: routeEntry.api.title,
        description:
          typeof routeEntry.api.frontmatter.description === "string"
            ? routeEntry.api.frontmatter.description
            : undefined,
        canonicalPath: routeEntry.route,
        canonicalUrl: source.canonicalUrl
          ? `${source.canonicalUrl.replace(/\/+$/, "")}${routeEntry.route}`
          : routeEntry.route,
        sidebarId: source.manifest.sidebars.api ? "api" : "default",
        headings: [],
        breadcrumbs: [
          { label: "Docs", href: "/docs" },
          { label: "API Reference", href: "/docs/api" },
          { label: routeEntry.api.title, href: routeEntry.route },
        ],
        pagination: {},
        topNav: getTopNavigation(source.manifest),
        versions: source.manifest.versions,
      }
    : resolveDocsPageSurface({
        manifest: source.manifest,
        route: routeEntry.route,
        page: routeEntry.page,
        options: {
          basePath: "/docs",
          homeHref: "/docs",
          canonicalUrl: source.canonicalUrl,
          versionMode: "path-prefix",
        },
      });

  const sidebar = surface.sidebarId ? source.manifest.sidebars[surface.sidebarId] : undefined;
  const sidebarLinks = sidebar ? flattenSidebarLinks(sidebar.items) : [];
  const searchDocumentCount = Array.isArray(source.searchArtifact.documents)
    ? source.searchArtifact.documents.length
    : 0;
  const searchScopes = Array.isArray(source.searchArtifact.scopes)
    ? source.searchArtifact.scopes.join(", ")
    : "none";

  return {
    routeEntry,
    compiled: routeEntry.kind === "page" ? resolveMarkdownRelativeLinks({
      compiled: compileSvelteContent({ source: routeEntry.page.body, sourcePath: routeEntry.page.id, compatPreset: source.compatPreset }),
      route: routeEntry.route, sourcePath: routeEntry.page.id,
    }) : undefined,
    surface,
    sidebarLinks,
    searchDocumentCount,
    searchScopes,
    searchProbe: source.searchProbe,
    siteTitle: source.siteTitle,
    compatPreset: source.compatPreset,
  };
};
