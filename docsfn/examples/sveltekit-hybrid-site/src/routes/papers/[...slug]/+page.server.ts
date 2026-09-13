import { error } from "@sveltejs/kit";
import { flattenSidebarLinks } from "@docsfn/core";
import { resolveDocsPageSurface, resolveDocsRouteDataOrThrow } from "@docsfn/sveltekit";
import type { PageServerLoad } from "./$types";

function isRouteNotFoundError(input: unknown): input is { message: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    String((input as { code: unknown }).code) === "DOCS_ROUTE_NOT_FOUND"
  );
}

export const load: PageServerLoad = async ({ params, parent }) => {
  const { source } = await parent();
  const papersSource = source.papers;

  let routeEntry;
  try {
    routeEntry = resolveDocsRouteDataOrThrow(params.slug, papersSource.manifest, {
      basePath: papersSource.basePath
    });
  } catch (routeError) {
    if (isRouteNotFoundError(routeError)) {
      throw error(404, routeError.message);
    }
    throw routeError;
  }

  if (routeEntry.kind !== "page") {
    throw error(404, `unsupported route kind for paper page: ${routeEntry.kind}`);
  }

  const surface = resolveDocsPageSurface({
    manifest: papersSource.manifest,
    route: routeEntry.route,
    page: routeEntry.page,
    options: {
      basePath: papersSource.basePath,
      homeHref: papersSource.basePath,
      homeLabel: "Papers",
      canonicalUrl: papersSource.canonicalUrl
    }
  });

  const sidebar = papersSource.manifest.sidebars[surface.sidebarId ?? "default"];

  return {
    page: routeEntry.page,
    surface,
    sidebarTitle: surface.sidebarId ?? "paper",
    sidebarLinks: sidebar ? flattenSidebarLinks(sidebar) : [],
    compatPreset: papersSource.compatPreset
  };
};
