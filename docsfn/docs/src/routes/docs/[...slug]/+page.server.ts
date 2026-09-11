import { error } from "@sveltejs/kit";
import { getTopNavigation } from "@docsfn/core";
import type { Sidebar } from "@docsfn/core";
import {
  resolveDocsPageSurface,
  resolveDocsRouteDataOrThrow,
  resolveEmbedMode,
  type SvelteDocsPageSurface,
} from "@docsfn/sveltekit";
import { getCompiledDocsPage } from "$lib/server/docs-site-source";
import type { PageServerLoad } from "./$types";

function buildCanonicalUrl(canonicalBase: string | undefined, path: string): string {
  if (!canonicalBase) {
    return path;
  }
  const origin = canonicalBase.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

function isRouteNotFoundError(input: unknown): input is { message: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    String((input as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND"
  );
}

export const load: PageServerLoad = async ({ params, parent, url }) => {
  const { source } = await parent();
  const embed = resolveEmbedMode(url);

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

  let surface: SvelteDocsPageSurface;
  if (routeEntry.kind === "api") {
    const api = routeEntry.api;
    const route = routeEntry.route;
    surface = {
      route,
      title: api.title,
      description:
        typeof api.frontmatter.description === "string" ? api.frontmatter.description : undefined,
      canonicalPath: route,
      canonicalUrl: buildCanonicalUrl(source.canonicalUrl, route),
      sidebarId: "api",
      headings: [],
      breadcrumbs: [
        { label: "Docs", href: "/docs" },
        { label: "API Reference", href: "/docs/api" },
        { label: api.title, href: route },
      ],
      pagination: {},
      topNav: getTopNavigation(source.manifest),
      versions: source.manifest.versions,
    };
  } else {
    surface = resolveDocsPageSurface({
      manifest: source.manifest,
      route: routeEntry.route,
      page: routeEntry.page,
      options: {
        basePath: "/docs",
        homeHref: "/docs",
        canonicalUrl: source.canonicalUrl,
        versionMode: "path-prefix",
        editLink: typeof source.config.site.editLink?.pattern === "string"
          ? source.config.site.editLink.pattern.replace("{path}", `content/docs/${routeEntry.page.id.replace(/^docs:/, "")}`)
          : undefined,
      },
    });
  }

  const sidebarId = surface.sidebarId;
  const sidebar: Sidebar | undefined = sidebarId ? source.manifest.sidebars[sidebarId] : undefined;

  const searchDocumentCount = Array.isArray(source.searchArtifact.documents)
    ? source.searchArtifact.documents.length
    : 0;
  const searchScopes = Array.isArray(source.searchArtifact.scopes)
    ? source.searchArtifact.scopes.join(", ")
    : "none";

  const compiled =
    routeEntry.kind === "page"
      ? await getCompiledDocsPage(routeEntry.page.id)
      : undefined;

  return {
    embed,
    routeEntry,
    surface,
    sidebar,
    compiled,
    searchDocumentCount,
    searchScopes,
    siteTitle: source.siteTitle,
    compatPreset: source.compatPreset,
  };
};
