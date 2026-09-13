import {
  resolveBreadcrumbsFromSidebar,
  resolvePaginationFromSidebar,
  resolveSidebarForRoute,
} from "./navigation";
import type { CanonicalOpenApiReference } from "./openapi";
import type { ApiReference, DocPage, DocsManifest, DocsTopNavItem, Sidebar } from "./types";

export interface BreadcrumbItem {
  label: string;
  href: string;
}

export interface PaginationLinks {
  prev?: {
    title: string;
    path: string;
  };
  next?: {
    title: string;
    path: string;
  };
}

type ManifestNavigationInput = Pick<DocsManifest, "pages" | "sidebars">;

function isManifestNavigationInput(
  value: Record<string, DocPage> | ManifestNavigationInput
): value is ManifestNavigationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "sidebars" in value &&
    typeof (value as ManifestNavigationInput).sidebars === "object" &&
    (value as ManifestNavigationInput).sidebars !== null
  );
}

interface PaginationOverride {
  path: string;
  title?: string;
}

function normalizePaginationOverride(
  input: unknown
): PaginationOverride | undefined {
  if (typeof input === "string" && input.length > 0) {
    return { path: input };
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  const pathCandidate =
    (typeof candidate.path === "string" && candidate.path) ||
    (typeof candidate.href === "string" && candidate.href);

  if (!pathCandidate) {
    return undefined;
  }

  return {
    path: pathCandidate,
    title: typeof candidate.title === "string" ? candidate.title : undefined,
  };
}

function resolveTitleForPath(
  path: string,
  pages: Record<string, DocPage>,
  fallback: string
): string {
  const page = Object.values(pages).find((candidate) => candidate.path === path);
  return page?.title ?? fallback;
}

export function generateBreadcrumbs(
  path: string,
  pagesOrManifest: Record<string, DocPage> | ManifestNavigationInput,
  options: {
    homeLabel?: string;
    homeHref?: string;
    sidebarId?: string;
  } = {}
): BreadcrumbItem[] {
  const { homeLabel, homeHref } = options;
  if (
    isManifestNavigationInput(pagesOrManifest) &&
    Object.keys(pagesOrManifest.sidebars).length > 0
  ) {
    const selectedSidebarId =
      options.sidebarId ??
      resolveSidebarForRoute({
        sidebars: pagesOrManifest.sidebars,
        route: path,
      }) ??
      "default";
    const selectedSidebar = pagesOrManifest.sidebars[selectedSidebarId];
    if (selectedSidebar) {
      return resolveBreadcrumbsFromSidebar({
        sidebar: selectedSidebar,
        route: path,
        rootLabel: homeLabel,
        rootHref: homeHref,
      });
    }
  }

  const pages = isManifestNavigationInput(pagesOrManifest)
    ? pagesOrManifest.pages
    : pagesOrManifest;
  const fallbackHomeLabel = homeLabel ?? "Home";
  const fallbackHomeHref = homeHref ?? "/";
  const crumbs: BreadcrumbItem[] = [{ label: fallbackHomeLabel, href: fallbackHomeHref }];
  const segments = path.split("/").filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath += `/${segment}`;
    const page = Object.values(pages).find((candidate) => candidate.path === currentPath);
    if (page) {
      crumbs.push({ label: page.title, href: currentPath });
      continue;
    }
    crumbs.push({
      label: segment
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
      href: currentPath,
    });
  }

  return crumbs;
}

export function getPaginationFromSidebar(
  currentPath: string,
  sidebar: Sidebar
): PaginationLinks {
  try {
    return resolvePaginationFromSidebar({
      sidebar,
      route: currentPath,
    });
  } catch {
    return {};
  }
}

export function getPaginationFromSidebarWithTitles(
  currentPath: string,
  sidebar: Sidebar,
  pages: Record<string, DocPage>
): PaginationLinks {
  const currentPage = Object.values(pages).find((page) => page.path === currentPath);
  const previousOverride = normalizePaginationOverride(currentPage?.frontmatter?.prev);
  const nextOverride = normalizePaginationOverride(currentPage?.frontmatter?.next);

  const pagination = getPaginationFromSidebar(currentPath, sidebar);
  if (pagination.prev) {
    pagination.prev.title = resolveTitleForPath(
      pagination.prev.path,
      pages,
      pagination.prev.title
    );
  }
  if (pagination.next) {
    pagination.next.title = resolveTitleForPath(
      pagination.next.path,
      pages,
      pagination.next.title
    );
  }

  for (const [direction, override] of [["prev", previousOverride], ["next", nextOverride]] as const) {
    if (currentPage?.frontmatter?.[direction] === false) pagination[direction] = undefined;
    else if (override) pagination[direction] = {
      path: override.path,
      title: override.title?.trim() || resolveTitleForPath(override.path, pages, override.path),
    };
  }
  return pagination;
}

export function getTopNavigation(
  manifest: Pick<DocsManifest, "topNav">
): DocsTopNavItem[] {
  return manifest.topNav ?? [];
}

export function selectApiReferenceRoute(
  api: ApiReference,
  route: string
): ApiReference {
  if (route === api.path || !api.spec || typeof api.spec !== "object")
    return api;
  const spec = api.spec as Partial<CanonicalOpenApiReference>;
  const operations = Array.isArray(spec.operations) ? spec.operations : [];
  const schemas = Array.isArray(spec.schemas) ? spec.schemas : [];
  const tags = Array.isArray(spec.tags) ? spec.tags : [];
  const operation = operations.find((item) => item.routePath === route);
  const schema = schemas.find((item) => item.routePath === route);
  const tag = tags.find((item) => item.routePath === route);
  if (!operation && !schema && !tag) return api;
  const title = `${api.title} — ${(operation?.summary?.trim() || operation?.id) ?? schema?.name ?? tag?.name}`;
  return {
    ...api,
    path: route,
    title,
    spec: {
      ...spec,
      title,
      info: { ...spec.info, title },
      operations: operation
        ? [operation]
        : tag
          ? operations.filter((item) => item.tags?.includes(tag.name))
          : [],
      schemas: schema ? [schema] : [],
      tags: tag ? [tag] : [],
    },
  };
}
