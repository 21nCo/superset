import {
  buildDatedCollectionJsonFeed,
  buildDocsStaticParams,
  createDiagnostic,
  createDocsError,
  generateBreadcrumbs,
  getPaginationFromSidebarWithTitles,
  getTopNavigation,
  resolveSidebarForRoute,
  selectApiReferenceRoute,
  type ApiReference,
  type BlogPost,
  type BuildDatedCollectionJsonFeedOptions,
  type DocPage,
  type DocsManifest,
  type DocsSearchArtifact,
  type DocsTopNavItem,
  type Version,
} from "@docsfn/core";

type SlugParam = string | string[] | readonly string[] | undefined;

type VersionMode = "path-prefix" | "path-segment";

export type DocsRouteEntry =
  | { kind: "page"; id: string; route: string; page: DocPage }
  | { kind: "api"; id: string; route: string; api: ApiReference }
  | { kind: "post"; id: string; route: string; post: BlogPost };

export interface NextDocsPageLink {
  title: string;
  path: string;
}

export interface NextDocsPageBreadcrumbItem {
  label: string;
  href: string;
}

export interface NextDocsPagePagination {
  prev?: NextDocsPageLink;
  next?: NextDocsPageLink;
}

export interface NextDocsPageSurface {
  route: string;
  title?: string;
  description?: string;
  canonicalPath: string;
  canonicalUrl: string;
  sidebarId?: string;
  headings?: DocPage["headings"];
  breadcrumbs?: NextDocsPageBreadcrumbItem[];
  pagination?: NextDocsPagePagination;
  topNav?: DocsTopNavItem[];
  versions?: Version[];
  currentVersion?: string;
  versionLinks?: Record<string, string>;
  editLink?: string;
  pageActions?: Array<Record<string, unknown>>;
}

export interface GenerateStaticParamsOptions {
  basePath?: string;
  includeApiRoutes?: boolean;
}

export interface GenerateVersionedStaticParamsOptions {
  basePath?: string;
  mode?: VersionMode;
}

export interface ResolvePageOptions {
  basePath?: string;
}

export interface ResolveVersionedPageOptions {
  basePath?: string;
  mode?: VersionMode;
}

export interface GenerateMetadataOptions {
  siteTitle?: string;
  canonicalUrl?: string;
}

export interface ResolvePageSurfaceOptions {
  basePath?: string;
  sidebarId?: string;
  homeLabel?: string;
  homeHref?: string;
  canonicalUrl?: string;
  pageActions?: Array<Record<string, unknown>>;
  editLink?: string;
  versionMode?: VersionMode;
}

export interface SearchArtifactResponseInput {
  artifact?: DocsSearchArtifact;
  loadArtifact?: () => Promise<DocsSearchArtifact>;
  cacheControl?: string;
}

export interface DatedCollectionJsonFeedResponseInput
  extends BuildDatedCollectionJsonFeedOptions {
  manifest?: DocsManifest;
  loadManifest?: () => Promise<DocsManifest>;
  cacheControl?: string;
}

export interface CollectionPostOptions {
  /** Use segment arrays with a Next [...slug] route. */
  catchAll?: boolean;
  includeDrafts?: boolean;
}

export interface EmbedModeOptions {
  param?: string;
}

export interface EmbedSidebarModeOptions {
  param?: string;
  aliases?: string[];
}

type EmbedSearchParamsRecord = Record<
  string,
  string | string[] | readonly string[] | null | undefined
>;

type EmbedModeInput =
  | URL
  | URLSearchParams
  | EmbedSearchParamsRecord
  | { searchParams: URLSearchParams | EmbedSearchParamsRecord }
  | null
  | undefined;

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function normalizeBasePath(basePath?: string): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlashes(prefixed);
}

function normalizeSlugSegments(slug: SlugParam): string[] {
  if (Array.isArray(slug)) {
    return slug.map((segment) => String(segment)).filter((segment) => segment.length > 0);
  }
  if (typeof slug === "string") {
    return slug.split("/").filter((segment) => segment.length > 0);
  }
  return [];
}

function normalizeCollectionId(collectionId: string): string {
  const trimmed = collectionId.trim();
  const withoutPrefix = trimmed.startsWith("collection:")
    ? trimmed.slice("collection:".length)
    : trimmed;
  return withoutPrefix
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/")
    .replaceAll("/", "-")
    .trim()
    .toLowerCase();
}

function normalizePostSlug(slug: SlugParam): string {
  return normalizeSlugSegments(slug).join("/");
}

function normalizeEmbedParamName(param: string | undefined): string {
  const normalized = typeof param === "string" ? param.trim() : "";
  return normalized.length > 0 ? normalized : "embed";
}

function normalizeEmbedSidebarParamNames(options: EmbedSidebarModeOptions): string[] {
  const params = [
    typeof options.param === "string" && options.param.trim().length > 0
      ? options.param.trim()
      : "showSidebar",
    ...(options.aliases ?? ["showsidebar", "sidebar"]),
  ];
  return [...new Set(params.map((param) => param.trim()).filter(Boolean))];
}

function isEmbedSearchParamsRecord(input: unknown): input is EmbedSearchParamsRecord {
  return typeof input === "object" && input !== null && !(input instanceof URLSearchParams);
}

function getEmbedSearchParamValue(
  input: EmbedModeInput,
  param: string
): string | string[] | readonly string[] | null | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof URL) {
    return input.searchParams.get(param);
  }
  if (input instanceof URLSearchParams) {
    return input.get(param);
  }
  if ("searchParams" in input) {
    const searchParams = input.searchParams;
    if (searchParams instanceof URLSearchParams) {
      return searchParams.get(param);
    }
    if (isEmbedSearchParamsRecord(searchParams)) {
      return searchParams[param];
    }
    return undefined;
  }
  if (isEmbedSearchParamsRecord(input)) {
    return input[param];
  }
  return undefined;
}

export function isEmbedModeValue(
  value: string | string[] | readonly string[] | null | undefined
): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "string") {
    return value.some((entry) => isEmbedModeValue(entry));
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function resolveEmbedMode(
  input: EmbedModeInput,
  options: EmbedModeOptions = {}
): boolean {
  const param = normalizeEmbedParamName(options.param);
  return isEmbedModeValue(getEmbedSearchParamValue(input, param));
}

export function resolveEmbedSidebarMode(
  input: EmbedModeInput,
  options: EmbedSidebarModeOptions = {}
): boolean {
  for (const param of normalizeEmbedSidebarParamNames(options)) {
    const value = getEmbedSearchParamValue(input, param);
    if (value !== null && value !== undefined) {
      return isEmbedModeValue(value);
    }
  }
  return false;
}

function buildDocsPath(slug: SlugParam, basePath?: string): string {
  const resolvedBasePath = normalizeBasePath(basePath);
  const segments = normalizeSlugSegments(slug);
  if (segments.length === 0) {
    return resolvedBasePath;
  }
  return `${resolvedBasePath}/${segments.join("/")}`.replace(/\/{2,}/g, "/");
}

type DatedCollectionSurface = NonNullable<DocsManifest["collections"]>[string];

function getPostCollectionId(post: BlogPost): string {
  return normalizeCollectionId(post.collectionId ?? "blog") || "blog";
}

function getDatedCollectionSurface(
  collectionId: string,
  manifest: DocsManifest
): DatedCollectionSurface | null {
  const normalizedCollectionId = normalizeCollectionId(collectionId);
  if (!normalizedCollectionId) {
    return null;
  }

  const collection = manifest.collections?.[normalizedCollectionId];
  if (collection) {
    return collection;
  }

  if (normalizedCollectionId === "blog" && manifest.blog) {
    return {
      id: "blog",
      label: "Blog",
      scope: "blog",
      listRoute: manifest.blog.listRoute,
      feedPath: manifest.blog.feedPath,
      postOrder: manifest.blog.postOrder,
      tags: manifest.blog.tags,
      archives: manifest.blog.archives,
    };
  }

  return null;
}

function resolveCollectionPostRoute(
  collectionId: string,
  slug: SlugParam,
  manifest: DocsManifest
): string {
  const normalizedCollectionId = normalizeCollectionId(collectionId) || collectionId;
  const collection = getDatedCollectionSurface(normalizedCollectionId, manifest);
  const listRoute =
    collection?.listRoute ?? (normalizedCollectionId === "blog" ? "/blog" : `/${normalizedCollectionId}`);
  return `${listRoute}/${normalizePostSlug(slug)}`.replace(/\/{2,}/g, "/");
}

function resolveRouteEntry(routePath: string, manifest: DocsManifest): DocsRouteEntry | null {
  const id = manifest.routes[routePath];
  if (!id) {
    return null;
  }

  const page = manifest.pages[id];
  if (page) {
    return {
      kind: "page",
      id,
      route: routePath,
      page,
    };
  }

  const api = manifest.apis[id];
  if (api) {
    return {
      kind: "api",
      id,
      route: routePath,
      api: selectApiReferenceRoute(api, routePath),
    };
  }

  const post = manifest.posts[id];
  if (post) {
    return {
      kind: "post",
      id,
      route: routePath,
      post,
    };
  }

  return null;
}

function createRouteNotFoundError(message: string, route: string) {
  return createDocsError({
    code: "DOCS_ROUTE_NOT_FOUND",
    message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_ROUTE_NOT_FOUND",
        message,
        details: {
          route,
        },
      }),
    ],
  });
}

function toVersionedPath(input: {
  version: string;
  slug: SlugParam;
  basePath?: string;
  mode?: VersionMode;
}): string {
  const resolvedBasePath = normalizeBasePath(input.basePath);
  const mode = input.mode ?? "path-prefix";
  const slugSegments = normalizeSlugSegments(input.slug);
  const routeSegments =
    mode === "path-segment"
      ? [...slugSegments, input.version]
      : [input.version, ...slugSegments];

  if (routeSegments.length === 0) {
    return resolvedBasePath;
  }

  return `${resolvedBasePath}/${routeSegments.join("/")}`.replace(/\/{2,}/g, "/");
}

function collectDocsRoutes(input: {
  manifest: DocsManifest;
  basePath: string;
  includeApiRoutes: boolean;
}): string[] {
  const { manifest, basePath, includeApiRoutes } = input;
  const baseWithSlash = basePath === "/" ? "/" : `${basePath}/`;

  return Object.entries(manifest.routes)
    .filter(([routePath]) => routePath === basePath || routePath.startsWith(baseWithSlash))
    .filter(([, id]) => {
      if (manifest.pages[id]) {
        return true;
      }
      if (includeApiRoutes && manifest.apis[id]) {
        return true;
      }
      return false;
    })
    .map(([routePath]) => routePath)
    .sort(compareStrings);
}

function removeBasePathPrefix(routePath: string, basePath: string): string[] {
  const withoutBase = routePath === basePath
    ? ""
    : routePath.startsWith(`${basePath}/`)
      ? routePath.slice(basePath.length + 1)
      : trimLeadingSlashes(routePath);
  return withoutBase.split("/").filter((segment) => segment.length > 0);
}

function resolveCanonicalUrl(canonicalUrl: string | undefined, path: string): string {
  if (!canonicalUrl) {
    return path;
  }

  const normalizedOrigin = trimTrailingSlashes(canonicalUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedOrigin}${normalizedPath}`;
}

function resolveVersionLinks(input: {
  route: string;
  currentVersion?: string;
  versions?: Version[];
  manifest: DocsManifest;
  basePath: string;
  mode: VersionMode;
}): Record<string, string> | undefined {
  const versions = input.versions ?? [];
  if (!input.currentVersion || versions.length <= 1) {
    return undefined;
  }

  const routeSegments = removeBasePathPrefix(input.route, input.basePath);
  let logicalSegments = [...routeSegments];

  if (input.mode === "path-segment") {
    if (logicalSegments[logicalSegments.length - 1] === input.currentVersion) {
      logicalSegments = logicalSegments.slice(0, -1);
    }
  } else if (logicalSegments[0] === input.currentVersion) {
    logicalSegments = logicalSegments.slice(1);
  }

  const links: Record<string, string> = {};
  for (const version of versions) {
    const candidateRoute = toVersionedPath({
      version: version.slug,
      slug: logicalSegments,
      basePath: input.basePath,
      mode: input.mode,
    });
    if (input.manifest.routes[candidateRoute]) {
      links[version.slug] = candidateRoute;
    }
  }

  return Object.keys(links).length > 0 ? links : undefined;
}

export function generateStaticParams(
  manifest: DocsManifest,
  options: GenerateStaticParamsOptions = {}
): Array<{ slug?: string[] }> {
  const basePath = normalizeBasePath(options.basePath);
  const routes = collectDocsRoutes({
    manifest,
    basePath,
    includeApiRoutes: options.includeApiRoutes ?? true,
  });

  return buildDocsStaticParams({ routes, basePath }).map((param) =>
    param.slug && param.slug.length > 0 ? { slug: param.slug } : {}
  );
}

export function generateVersionedStaticParams(
  manifest: DocsManifest,
  options: GenerateVersionedStaticParamsOptions = {}
): Array<{ version: string; slug?: string[] }> {
  const basePath = normalizeBasePath(options.basePath);
  const mode = options.mode ?? "path-prefix";

  const params = Object.values(manifest.pages)
    .filter((page) => typeof page.version === "string" && page.version.length > 0)
    .map((page) => {
      const routeSegments = removeBasePathPrefix(page.path, basePath);
      let slug = [...routeSegments];
      if (mode === "path-segment") {
        slug = slug[slug.length - 1] === page.version ? slug.slice(0, -1) : slug;
      } else {
        slug = slug[0] === page.version ? slug.slice(1) : slug;
      }

      return {
        version: page.version as string,
        slug,
      };
    })
    .sort((left, right) => {
      const versionCompare = compareStrings(left.version, right.version);
      if (versionCompare !== 0) {
        return versionCompare;
      }
      return compareStrings(left.slug.join("/"), right.slug.join("/"));
    });

  return params.map((param) =>
    param.slug.length > 0
      ? { version: param.version, slug: param.slug }
      : { version: param.version }
  );
}

export function resolveDocsRouteData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocsRouteEntry | null {
  const routePath = buildDocsPath(slug, options.basePath);
  return resolveRouteEntry(routePath, manifest);
}

export function resolveDocsRouteDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocsRouteEntry {
  const routePath = buildDocsPath(slug, options.basePath);
  const entry = resolveRouteEntry(routePath, manifest);
  if (entry) {
    return entry;
  }

  const segments = normalizeSlugSegments(slug);
  if (segments.length === 0) {
    throw createRouteNotFoundError(
      "root docs page must resolve when params.slug is undefined",
      routePath
    );
  }

  throw createRouteNotFoundError(`docs route ${routePath} was not generated`, routePath);
}

export function getPageData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocPage | null {
  const route = resolveDocsRouteData(slug, manifest, options);
  if (!route || route.kind !== "page") {
    return null;
  }
  return route.page;
}

export function getPageDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): DocPage {
  const entry = resolveDocsRouteDataOrThrow(slug, manifest, options);
  if (entry.kind === "page") {
    return entry.page;
  }

  throw createRouteNotFoundError(`docs page route ${entry.route} was not generated`, entry.route);
}

export function getVersionedPageData(
  version: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolveVersionedPageOptions = {}
): DocPage | null {
  const routePath = toVersionedPath({
    version,
    slug,
    basePath: options.basePath,
    mode: options.mode,
  });
  const entry = resolveRouteEntry(routePath, manifest);
  return entry?.kind === "page" ? entry.page : null;
}

export function getVersionedPageDataOrThrow(
  version: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolveVersionedPageOptions = {}
): DocPage {
  const routePath = toVersionedPath({
    version,
    slug,
    basePath: options.basePath,
    mode: options.mode,
  });
  const entry = resolveRouteEntry(routePath, manifest);
  if (entry?.kind === "page") {
    return entry.page;
  }

  throw createRouteNotFoundError(`docs route ${routePath} was not generated`, routePath);
}

export function getCollectionPosts(
  collectionId: string,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
): BlogPost[] {
  const normalizedCollectionId = normalizeCollectionId(collectionId);
  if (!normalizedCollectionId) {
    return [];
  }

  const includeDrafts = Boolean(options.includeDrafts);
  const collection = getDatedCollectionSurface(normalizedCollectionId, manifest);
  const postOrder = collection?.postOrder ?? [];
  const orderedPosts = postOrder
    .map((id) => manifest.posts[id])
    .filter(
      (post): post is BlogPost =>
        Boolean(post) &&
        getPostCollectionId(post) === normalizedCollectionId &&
        (includeDrafts || !post.draft)
    );

  if (postOrder.length > 0) {
    return orderedPosts;
  }

  return Object.values(manifest.posts)
    .filter(
      (post) =>
        getPostCollectionId(post) === normalizedCollectionId &&
        (includeDrafts || !post.draft)
    )
    .sort((left, right) => {
      const dateCompare = right.date.localeCompare(left.date);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return compareStrings(left.slug, right.slug);
    });
}

export function getCollectionPostData(
  collectionId: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
): BlogPost | null {
  const normalizedSlug = normalizePostSlug(slug);
  return (
    getCollectionPosts(collectionId, manifest, options).find(
      (post) => post.slug === normalizedSlug
    ) ?? null
  );
}

export function getCollectionPostDataOrThrow(
  collectionId: string,
  slug: SlugParam,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
): BlogPost {
  const post = getCollectionPostData(collectionId, slug, manifest, options);
  if (post) {
    return post;
  }
  const route = resolveCollectionPostRoute(collectionId, slug, manifest);
  throw createRouteNotFoundError(
    `${normalizeCollectionId(collectionId) || "collection"} route ${route} was not generated`,
    route
  );
}

export function getPostData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
): BlogPost | null {
  return getCollectionPostData("blog", slug, manifest, options);
}

export function getPostDataOrThrow(
  slug: SlugParam,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
): BlogPost {
  return getCollectionPostDataOrThrow("blog", slug, manifest, options);
}

export function getApiData(
  slug: SlugParam,
  manifest: DocsManifest,
  options: ResolvePageOptions = {}
): ApiReference | null {
  const basePath = normalizeBasePath(options.basePath);
  const segments = normalizeSlugSegments(slug);
  const logicalSegments = segments[0] === "api" ? segments.slice(1) : segments;
  const suffix = logicalSegments.length > 0 ? `/${logicalSegments.join("/")}` : "";
  const routePath = `${basePath}/api${suffix}`.replace(/\/{2,}/g, "/");
  const entry = resolveRouteEntry(routePath, manifest);
  return entry?.kind === "api" ? entry.api : null;
}

export function generatePageMetadata(
  page: DocPage,
  site: string | GenerateMetadataOptions
): {
  title: string;
  description: string;
  alternates: { canonical: string };
  openGraph: { title: string; description: string; url: string };
} {
  const siteOptions =
    typeof site === "string"
      ? ({ siteTitle: site } satisfies GenerateMetadataOptions)
      : site;
  const siteTitle = siteOptions.siteTitle;
  const title = siteTitle ? `${page.title} | ${siteTitle}` : page.title;
  const description = page.description || `Documentation for ${page.title}`;
  const canonical = resolveCanonicalUrl(siteOptions.canonicalUrl, page.path);

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      title,
      description,
      url: canonical,
    },
  };
}

export function generateCollectionParams(
  collectionId: string,
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
) {
  return getCollectionPosts(collectionId, manifest, options)
    .sort((left, right) => compareStrings(left.slug, right.slug))
    .map((post) => ({
      slug: options.catchAll ? post.slug.split("/") : post.slug,
    }));
}

export function generateBlogParams(
  manifest: DocsManifest,
  options: CollectionPostOptions = {}
) {
  return generateCollectionParams("blog", manifest, options);
}

/** Parameters for a dedicated API [[...slug]] route (overview and all child pages). */
export function generateApiParams(manifest: DocsManifest, options: { catchAll?: boolean } = {}) {
  const slugs = Object.values(manifest.apis).flatMap((api) => {
    const reference = api.spec as { routes?: { all?: string[] } } | undefined;
    return (reference?.routes?.all ?? [api.path]).map((route) =>
      route === api.path ? api.slug : `${api.slug}${route.slice(api.path.length)}`);
  });
  return [...new Set(slugs)].sort(compareStrings).map((slug) =>
    options.catchAll && !slug ? {} : { slug: options.catchAll ? slug.split("/").filter(Boolean) : slug });
}

export function resolveDocsPageSurface(input: {
  manifest: DocsManifest;
  route: string;
  page?: DocPage;
  options?: ResolvePageSurfaceOptions;
}): NextDocsPageSurface {
  const options = input.options ?? {};
  const basePath = normalizeBasePath(options.basePath);
  const page = input.page ?? (() => {
    const entry = resolveRouteEntry(input.route, input.manifest);
    return entry?.kind === "page" ? entry.page : undefined;
  })();

  const sidebarId =
    options.sidebarId ??
    resolveSidebarForRoute({
      sidebars: input.manifest.sidebars,
      route: input.route,
    }) ?? undefined;
  const sidebar = sidebarId ? input.manifest.sidebars[sidebarId] : undefined;

  const breadcrumbs = sidebar
    ? generateBreadcrumbs(input.route, input.manifest, {
        homeLabel: options.homeLabel ?? input.manifest.site.title,
        homeHref: options.homeHref ?? basePath,
        sidebarId,
      })
    : [];

  const pagination = sidebar
    ? getPaginationFromSidebarWithTitles(input.route, sidebar, input.manifest.pages)
    : {};

  const canonicalPath = input.route;
  const canonicalUrl = resolveCanonicalUrl(options.canonicalUrl, canonicalPath);

  return {
    route: input.route,
    title: page?.title,
    description: page?.description,
    canonicalPath,
    canonicalUrl,
    sidebarId,
    headings: page?.headings,
    breadcrumbs,
    pagination,
    topNav: getTopNavigation(input.manifest),
    versions: input.manifest.versions,
    currentVersion: page?.version,
    versionLinks: resolveVersionLinks({
      route: input.route,
      currentVersion: page?.version,
      versions: input.manifest.versions,
      manifest: input.manifest,
      basePath,
      mode: options.versionMode ?? "path-prefix",
    }),
    editLink: options.editLink,
    pageActions: options.pageActions,
  };
}

export async function createSearchArtifactResponse(
  input: SearchArtifactResponseInput
): Promise<Response> {
  try {
    const artifact = input.artifact ?? (input.loadArtifact ? await input.loadArtifact() : undefined);
    if (!artifact) {
      throw createDocsError({
        code: "DOCS_ARTIFACT_INVALID",
        message: "search artifact is not available",
        diagnostics: [
          createDiagnostic({
            code: "DOCS_ARTIFACT_INVALID",
            message: "search artifact is not available",
          }),
        ],
      });
    }

    return new Response(JSON.stringify(artifact), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": input.cacheControl ?? "public, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "DOCS_ARTIFACT_INVALID";
    const message = error instanceof Error ? error.message : "failed to load search artifact";

    return new Response(
      JSON.stringify({
        code,
        message,
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  }
}

export async function createDatedCollectionJsonFeedResponse(
  input: DatedCollectionJsonFeedResponseInput
): Promise<Response> {
  try {
    const manifest = input.manifest ?? (input.loadManifest ? await input.loadManifest() : undefined);
    if (!manifest) {
      throw createDocsError({
        code: "DOCS_ARTIFACT_INVALID",
        message: "docs manifest is not available",
        diagnostics: [
          createDiagnostic({
            code: "DOCS_ARTIFACT_INVALID",
            message: "docs manifest is not available",
          }),
        ],
      });
    }

    const feed = buildDatedCollectionJsonFeed(manifest, input);
    return new Response(JSON.stringify(feed), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": input.cacheControl ?? "public, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "DOCS_ARTIFACT_INVALID";
    const message =
      error instanceof Error ? error.message : "failed to load dated collection JSON feed";

    return new Response(
      JSON.stringify({
        code,
        message,
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  }
}
