import { createDiagnostic, createDocsError } from "./diagnostics";
import type { DocsConfig, DocsVersionConfig, DocsVersionMode } from "./types";

export interface RouteBuildInput {
  collection: "docs" | "pages" | "blog" | "api";
  sourcePath: string;
  frontmatter?: Record<string, unknown>;
  config: DocsConfig;
}

export interface RouteBuildResult {
  slug: string;
  path: string;
  version?: string;
  logicalPath: string;
}

const SOURCE_EXTENSION_REGEX = /\.(md|mdx|json|yaml|yml)$/i;

export function stripSourceExtension(relativePath: string): string {
  return normalizeSlug(relativePath).replace(SOURCE_EXTENSION_REGEX, "");
}

export function normalizeSlug(value: string): string {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

export function slugToSegments(slug: string): string[] {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return [];
  }
  return normalized.split("/");
}

export function segmentsToSlug(segments: string[]): string {
  return segments.filter(Boolean).join("/");
}

export function deriveLogicalPathFromSourcePath(sourcePath: string): string {
  const segments = slugToSegments(sourcePath);
  if (segments.length === 0) {
    return "";
  }
  if (segments[segments.length - 1] === "index") {
    return segmentsToSlug(segments.slice(0, -1));
  }
  return segmentsToSlug(segments);
}

function normalizeBasePath(basePath: string | undefined): string {
  const value = basePath && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  let end = prefixed.length;
  while (end > 1 && prefixed.charCodeAt(end - 1) === 47) end -= 1;
  return prefixed.slice(0, end);
}

function buildPath(basePath: string, slug: string): string {
  if (!slug) {
    return basePath;
  }
  const suffix = slug.startsWith("/") ? slug : `/${slug}`;
  return `${basePath}${suffix}`.replace(/\/{2,}/g, "/");
}

function resolveConfiguredVersions(config: DocsConfig): {
  mode: DocsVersionMode;
  versions: DocsVersionConfig[];
  defaultVersion?: DocsVersionConfig;
} {
  const mode = config.versions?.mode ?? "none";
  const versions = config.versions?.versions ?? [];
  const defaultVersion = versions.find((version) => version.default);

  if (mode !== "none" && versions.length > 0 && !defaultVersion) {
    throw createDocsError({
      code: "DOCS_VERSION_INVALID",
      message: "version mode requires exactly one default version",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_VERSION_INVALID",
          message: "version mode requires exactly one default version",
        }),
      ],
    });
  }

  return {
    mode,
    versions,
    defaultVersion,
  };
}

function resolveVersionContext(input: {
  logicalPath: string;
  frontmatter?: Record<string, unknown>;
  config: DocsConfig;
}): { version?: string; slugWithoutVersion: string } {
  const { mode, versions, defaultVersion } = resolveConfiguredVersions(input.config);
  if (mode === "none" || versions.length === 0) {
    return {
      version: undefined,
      slugWithoutVersion: input.logicalPath,
    };
  }

  const validSlugs = new Set(versions.map((version) => version.slug));
  const logicalSegments = slugToSegments(input.logicalPath);
  const frontmatterVersion = input.frontmatter?.version;
  let requestedVersion: string | undefined;

  if (typeof frontmatterVersion === "string" && frontmatterVersion.length > 0) {
    if (!validSlugs.has(frontmatterVersion)) {
      throw createDocsError({
        code: "DOCS_VERSION_INVALID",
        message: `unknown configured version ${frontmatterVersion}`,
        diagnostics: [
          createDiagnostic({
            code: "DOCS_VERSION_INVALID",
            message: `unknown configured version ${frontmatterVersion}`,
          }),
        ],
      });
    }
    const pathVersion = mode === "path-segment" ? logicalSegments.at(-1) : logicalSegments[0];
    if (pathVersion && validSlugs.has(pathVersion) && pathVersion !== frontmatterVersion) {
      throw createDocsError({ code: "DOCS_VERSION_INVALID", message: `path version ${pathVersion} conflicts with frontmatter version ${frontmatterVersion}`, diagnostics: [createDiagnostic({ code: "DOCS_VERSION_INVALID", message: "Path and frontmatter versions conflict", details: { pathVersion, frontmatterVersion } })] });
    }
    requestedVersion = frontmatterVersion;
  } else if (mode === "path-segment" && logicalSegments.length > 0 && validSlugs.has(logicalSegments[logicalSegments.length - 1])) {
    requestedVersion = logicalSegments[logicalSegments.length - 1];
  } else if (mode !== "path-segment" && logicalSegments.length > 0 && validSlugs.has(logicalSegments[0])) {
    requestedVersion = logicalSegments[0];
  } else {
    requestedVersion = defaultVersion?.slug;
  }

  let slugWithoutVersion = input.logicalPath;
  if (requestedVersion && logicalSegments.length > 0) {
    if (mode === "path-segment" && logicalSegments[logicalSegments.length - 1] === requestedVersion) {
      slugWithoutVersion = segmentsToSlug(logicalSegments.slice(0, -1));
    } else if (mode !== "path-segment" && logicalSegments[0] === requestedVersion) {
      slugWithoutVersion = segmentsToSlug(logicalSegments.slice(1));
    }
  }

  const remainingSegments = slugToSegments(slugWithoutVersion);
  const duplicated =
    requestedVersion &&
    remainingSegments.length > 0 &&
    (mode === "path-segment"
      ? remainingSegments[remainingSegments.length - 1] === requestedVersion
      : remainingSegments[0] === requestedVersion);
  if (duplicated) {
    throw createDocsError({
      code: "DOCS_VERSION_INVALID",
      message: "version segment duplicated during route normalization",
      diagnostics: [
        createDiagnostic({
          code: "DOCS_VERSION_INVALID",
          message: "version segment duplicated during route normalization",
          details: {
            version: requestedVersion,
            logicalPath: input.logicalPath,
            normalized: slugWithoutVersion,
          },
        }),
      ],
    });
  }

  return {
    version: requestedVersion,
    slugWithoutVersion,
  };
}

function applyVersionToSlug(input: {
  slug: string;
  version?: string;
  mode: DocsVersionMode;
}): string {
  if (!input.version || input.mode === "none") {
    return input.slug;
  }

  const slugSegments = slugToSegments(input.slug);

  if (input.mode === "path-prefix") {
    return segmentsToSlug([input.version, ...slugSegments]);
  }

  if (input.mode === "path-segment") {
    return segmentsToSlug([...slugSegments, input.version]);
  }

  return input.slug;
}

export function buildRoute(input: RouteBuildInput): RouteBuildResult {
  const logicalPath = deriveLogicalPathFromSourcePath(input.sourcePath);
  const basePath = normalizeBasePath(input.config.site.basePath);

  if (input.collection === "docs") {
    const versionContext = resolveVersionContext({
      logicalPath,
      frontmatter: input.frontmatter,
      config: input.config,
    });
    const mode = input.config.versions?.mode ?? "none";
    const slug = applyVersionToSlug({
      slug: versionContext.slugWithoutVersion,
      version: versionContext.version,
      mode,
    });

    return {
      slug,
      path: buildPath(basePath, slug),
      version: versionContext.version,
      logicalPath: versionContext.slugWithoutVersion,
    };
  }

  if (input.collection === "pages") {
    const slug = logicalPath;
    return {
      slug,
      path: buildPath("", slug || "/"),
      logicalPath,
    };
  }

  if (input.collection === "blog") {
    const slug = logicalPath;
    return {
      slug,
      path: buildPath("/blog", slug),
      logicalPath,
    };
  }

  const slug = logicalPath;
  return {
    slug,
    path: buildPath("/api", slug),
    logicalPath,
  };
}

export function assertRouteAvailability(input: {
  routes: Map<string, string>;
  path: string;
  sourceId: string;
}): void {
  const existing = input.routes.get(input.path);
  if (existing && existing !== input.sourceId) {
    throw createDocsError({
      code: "DOCS_ROUTE_CONFLICT",
      message: `route ${input.path} is claimed by multiple source entries`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ROUTE_CONFLICT",
          message: `route ${input.path} is claimed by multiple source entries`,
          details: {
            route: input.path,
            firstSource: existing,
            secondSource: input.sourceId,
          },
        }),
      ],
    });
  }
}

export function buildDocsStaticParams(input: {
  routes: string[];
  basePath?: string;
  versions?: DocsConfig["versions"];
}): Array<{ slug?: string[]; version?: string }> {
  const basePath = normalizeBasePath(input.basePath);
  const versionMode = input.versions?.mode ?? "none";
  const versionSlugs = new Set(
    (input.versions?.versions ?? []).map((version) => version.slug)
  );

  return input.routes.map((route) => {
    const routeWithoutBase = route.startsWith(basePath)
      ? route.slice(basePath.length).replace(/^\/+/, "")
      : normalizeSlug(route);
    const segments = slugToSegments(routeWithoutBase);
    if (segments.length === 0) {
      return {};
    }

    if (versionMode === "path-prefix" && versionSlugs.has(segments[0])) {
      const [version, ...slug] = segments;
      return { version, slug };
    }

    if (versionMode === "path-segment" && versionSlugs.has(segments[segments.length - 1])) {
      const version = segments[segments.length - 1];
      const slug = segments.slice(0, -1);
      return { version, slug };
    }

    return { slug: segments };
  });
}
