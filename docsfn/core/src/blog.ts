import { createDiagnostic, createDocsError } from "./diagnostics";
import type { NormalizedPostRecord } from "./normalize";
import type {
  BlogArchivePage,
  BlogManifestSurface,
  BlogPost,
  BlogTagIndex,
  DatedCollectionManifestSurface,
} from "./types";

export interface BuildCanonicalDatedCollectionRecordsInput {
  posts: NormalizedPostRecord[];
  collectionId?: string;
  label?: string;
  searchScope?: string;
  basePath?: string;
  routeBase?: string;
  feedPath?: string;
  preview?: boolean;
  pageSize?: number;
}

export interface BuildCanonicalBlogRecordsInput
  extends BuildCanonicalDatedCollectionRecordsInput {}

export interface CanonicalDatedCollectionBuildResult
  extends DatedCollectionManifestSurface {
  posts: BlogPost[];
}

export interface CanonicalBlogBuildResult extends BlogManifestSurface {
  posts: BlogPost[];
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(start, end);
}

function normalizeBasePath(basePath?: string): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlashes(prefixed);
}

function normalizeAbsoluteRoute(value: string, fallback: string): string {
  const candidate = value.trim().length > 0 ? value : fallback;
  const prefixed = candidate.startsWith("/") ? candidate : `/${candidate}`;
  return trimTrailingSlashes(prefixed);
}

function appendRoute(basePath: string, suffix: string): string {
  const normalizedBase = normalizeAbsoluteRoute(basePath, "/");
  const normalizedSuffix = trimSlashes(suffix);
  if (!normalizedSuffix) {
    return normalizedBase;
  }
  return normalizedBase === "/"
    ? `/${normalizedSuffix}`
    : `${normalizedBase}/${normalizedSuffix}`;
}

function stripMarkdown(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(source: string, maxLength = 220): string {
  const normalized = stripMarkdown(source);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function toTagSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "tag";
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const canonical = tag.trim().toLowerCase();
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized.sort(compareStrings);
}

function parseDraftFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

function parseAuthor(frontmatter: Record<string, unknown>): string | undefined {
  const rawAuthor = frontmatter.author;
  if (typeof rawAuthor === "string" && rawAuthor.trim().length > 0) {
    return rawAuthor.trim();
  }
  if (typeof rawAuthor === "object" && rawAuthor !== null) {
    const fromObject =
      typeof (rawAuthor as { name?: unknown }).name === "string"
        ? String((rawAuthor as { name: string }).name).trim()
        : "";
    if (fromObject.length > 0) {
      return fromObject;
    }
  }
  return undefined;
}

function parseFrontmatterDate(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return undefined;
}

function parseExcerpt(input: {
  excerpt?: unknown;
  body: string;
}): string | undefined {
  if (typeof input.excerpt === "string" && input.excerpt.trim().length > 0) {
    return input.excerpt.trim();
  }
  const summary = summarize(input.body);
  return summary.length > 0 ? summary : undefined;
}

function parsePublishedDate(input: {
  date: string;
  sourceId: string;
  collectionLabel?: string;
}): {
  date: string;
  publishedAt: string;
  timestamp: number;
} {
  const timestamp = Date.parse(input.date);
  if (!Number.isFinite(timestamp)) {
    const label = input.collectionLabel ?? "dated content entry";
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: `${label} ${input.sourceId} has invalid publish date metadata`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: `${label} ${input.sourceId} has invalid publish date metadata`,
          details: {
            sourceId: input.sourceId,
            date: input.date,
          },
        }),
      ],
    });
  }

  const published = new Date(timestamp).toISOString();
  return {
    date: published.slice(0, 10),
    publishedAt: published,
    timestamp,
  };
}

function buildArchivePages(input: {
  orderedPosts: BlogPost[];
  listRoute: string;
  pageSize: number;
}): BlogArchivePage[] {
  const totalPosts = input.orderedPosts.length;
  const totalPages = Math.max(1, Math.ceil(totalPosts / input.pageSize));
  const pages: BlogArchivePage[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * input.pageSize;
    const slice = input.orderedPosts.slice(start, start + input.pageSize);
    pages.push({
      page,
      path: page === 1 ? input.listRoute : appendRoute(input.listRoute, `page/${page}`),
      postIds: slice.map((post) => post.id),
      totalPages,
      totalPosts,
      pageSize: input.pageSize,
    });
  }

  return pages;
}

function buildTagIndexes(input: {
  orderedPosts: BlogPost[];
  listRoute: string;
}): Record<string, BlogTagIndex> {
  const tagMap = new Map<string, BlogTagIndex>();
  const slugOwners = new Map<string, string>();
  for (const post of input.orderedPosts) {
    for (const tag of post.tags) {
      const slug = toTagSlug(tag);
      const owner = slugOwners.get(slug);
      if (owner && owner !== tag) {
        throw createDocsError({
          code: "DOCS_ARTIFACT_INVALID",
          message: `dated-collection tags "${owner}" and "${tag}" collapse to the same slug "${slug}"`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_ARTIFACT_INVALID",
              message: `dated-collection tags "${owner}" and "${tag}" collapse to the same slug "${slug}"`,
              details: {
                tags: [owner, tag],
                slug,
              },
            }),
          ],
        });
      }
      slugOwners.set(slug, tag);
      const existing = tagMap.get(tag);
      if (existing) {
        existing.postIds.push(post.id);
        continue;
      }
      tagMap.set(tag, {
        tag,
        slug,
        path: appendRoute(input.listRoute, `tags/${slug}`),
        postIds: [post.id],
      });
    }
  }

  return Object.fromEntries(
    [...tagMap.entries()].sort(([left], [right]) => compareStrings(left, right))
  );
}

export function assertValidBlogPublishMetadata(post: Pick<BlogPost, "id" | "date">): {
  date: string;
  publishedAt: string;
  timestamp: number;
} {
  return parsePublishedDate({
    date: post.date,
    sourceId: post.id,
  });
}

export function resolveBlogLastBuildDate(posts: Array<Pick<BlogPost, "id" | "date">>): string {
  if (posts.length === 0) {
    return new Date("1970-01-01T00:00:00.000Z").toUTCString();
  }

  const latest = [...posts]
    .map((post) => ({
      id: post.id,
      ...assertValidBlogPublishMetadata(post),
    }))
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return compareStrings(left.id, right.id);
    })[0];

  return new Date(latest.publishedAt).toUTCString();
}

export function buildCanonicalDatedCollectionRecords(
  input: BuildCanonicalDatedCollectionRecordsInput
): CanonicalDatedCollectionBuildResult {
  const collectionId = input.collectionId ?? "blog";
  const label = input.label ?? (collectionId === "blog" ? "Blog" : collectionId);
  const searchScope = input.searchScope ?? (collectionId === "blog" ? "blog" : collectionId);
  const basePath = normalizeBasePath(input.basePath);
  const defaultRouteBase = appendRoute(basePath, collectionId);
  const listRoute = normalizeAbsoluteRoute(
    input.routeBase ?? (collectionId === "blog" ? appendRoute(basePath, "blog") : defaultRouteBase),
    collectionId === "blog" ? appendRoute(basePath, "blog") : defaultRouteBase
  );
  const feedPath = normalizeAbsoluteRoute(
    input.feedPath ?? appendRoute(listRoute, "rss.xml"),
    appendRoute(listRoute, "rss.xml")
  );
  const includeDrafts = Boolean(input.preview);
  const pageSize = Math.max(1, Math.trunc(input.pageSize ?? 10));

  const canonicalPosts = input.posts
    .map((post) => {
      const frontmatterDate = parseFrontmatterDate(post.frontmatter?.date);
      if (!frontmatterDate) {
        throw createDocsError({
          code: "DOCS_ARTIFACT_INVALID",
          message: `${label} ${post.id} is missing publish date metadata`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_ARTIFACT_INVALID",
              message: `${label} ${post.id} is missing publish date metadata`,
              details: {
                sourceId: post.id,
              },
            }),
          ],
        });
      }

      const draft = parseDraftFlag(post.frontmatter?.draft);
      const publish = parsePublishedDate({
        date: frontmatterDate,
        sourceId: post.id,
        collectionLabel: label,
      });
      const tags = normalizeTags(post.tags);
      const excerpt = parseExcerpt({
        excerpt: post.frontmatter?.excerpt,
        body: post.body,
      });

      return {
        kind: "post" as const,
        id: post.id,
        collectionId: post.collectionId ?? collectionId,
        collectionLabel: post.collectionLabel ?? label,
        searchScope: post.searchScope ?? searchScope,
        slug: post.slug,
        path: post.slug ? appendRoute(listRoute, post.slug) : listRoute,
        title: post.title,
        date: publish.date,
        publishedAt: publish.publishedAt,
        author: parseAuthor(post.frontmatter),
        excerpt,
        summary: excerpt ?? summarize(post.body),
        draft,
        tags,
        body: post.body,
        frontmatter: post.frontmatter,
        _sortTimestamp: publish.timestamp,
      };
    })
    .filter((post) => includeDrafts || !post.draft)
    .sort((left, right) => {
      if (left._sortTimestamp !== right._sortTimestamp) {
        return right._sortTimestamp - left._sortTimestamp;
      }
      const slugCompare = compareStrings(left.slug, right.slug);
      if (slugCompare !== 0) {
        return slugCompare;
      }
      return compareStrings(left.id, right.id);
    });

  const posts = canonicalPosts.map(({ _sortTimestamp, ...post }) => post);
  const tags = buildTagIndexes({ orderedPosts: posts, listRoute });
  const archives = buildArchivePages({
    orderedPosts: posts,
    listRoute,
    pageSize,
  });
  const surfaceRoutes = new Set([listRoute, feedPath, ...Object.values(tags).map((tag) => tag.path), ...archives.map((archive) => archive.path)]);
  for (const post of posts) {
    if (surfaceRoutes.has(post.path)) {
      throw createDocsError({ code: "DOCS_ARTIFACT_INVALID", message: `${label} post ${post.id} conflicts with generated collection route ${post.path}`, diagnostics: [] });
    }
  }
  const postOrder = posts.map((post) => post.id);

  return {
    id: collectionId,
    label,
    scope: searchScope,
    posts,
    listRoute,
    feedPath,
    postOrder,
    tags,
    archives,
  };
}

export function buildCanonicalBlogRecords(
  input: BuildCanonicalBlogRecordsInput
): CanonicalBlogBuildResult {
  const canonical = buildCanonicalDatedCollectionRecords({
    ...input,
    collectionId: input.collectionId ?? "blog",
    label: input.label ?? "Blog",
    searchScope: input.searchScope ?? "blog",
  });
  return {
    posts: canonical.posts,
    listRoute: canonical.listRoute,
    feedPath: canonical.feedPath,
    postOrder: canonical.postOrder,
    tags: canonical.tags,
    archives: canonical.archives,
  };
}
