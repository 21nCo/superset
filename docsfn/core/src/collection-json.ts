import { assertValidBlogPublishMetadata } from "./blog";
import { normalizeDatedCollectionId } from "./provider";
import type { BlogPost, DocsManifest } from "./types";

export interface DatedCollectionJsonFeedItem {
  id: string;
  collectionId?: string;
  title: string;
  slug: string;
  date: string;
  publishedAt?: string;
  path: string;
  embedPath: string;
  excerpt?: string;
  summary?: string;
  author?: string;
  tags: string[];
  version?: string;
}

export interface DatedCollectionJsonFeed {
  collectionId: string;
  title: string;
  description?: string;
  listPath: string;
  feedPath?: string;
  latest: DatedCollectionJsonFeedItem | null;
  items: DatedCollectionJsonFeedItem[];
}

export interface BuildDatedCollectionJsonFeedOptions {
  collectionId: string;
  title?: string;
  description?: string;
  limit?: number;
  includeDrafts?: boolean;
  embedParam?: string;
  itemPath?: (post: BlogPost) => string;
  itemEmbedPath?: (post: BlogPost) => string;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function normalizeCollectionId(collectionId: string): string {
  const trimmed = collectionId.trim();
  const withoutPrefix = trimmed.startsWith("collection:")
    ? trimmed.slice("collection:".length)
    : trimmed;
  return normalizeDatedCollectionId(withoutPrefix);
}

function getPostCollectionId(post: BlogPost): string {
  return normalizeCollectionId(post.collectionId ?? "blog") || "blog";
}

function appendEmbedParam(path: string, param: string): string {
  const hashIndex = path.indexOf("#");
  const pathAndSearch = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : path.slice(hashIndex + 1);
  const separator = pathAndSearch.includes("?") ? "&" : "?";
  const withParam = `${pathAndSearch}${separator}${encodeURIComponent(param)}=1`;
  return hash.length > 0 ? `${withParam}#${hash}` : withParam;
}

function normalizeEmbedParam(param: string | undefined): string {
  const normalized = typeof param === "string" ? param.trim() : "";
  return normalized.length > 0 ? normalized : "embed";
}

function getCollectionSurface(collectionId: string, manifest: DocsManifest) {
  if (collectionId === "blog" && manifest.blog) {
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
  return manifest.collections?.[collectionId];
}

function getCollectionPosts(input: {
  manifest: DocsManifest;
  collectionId: string;
  includeDrafts: boolean;
}): BlogPost[] {
  const surface = getCollectionSurface(input.collectionId, input.manifest);
  const postOrder = surface?.postOrder ?? [];
  const orderedPosts = postOrder
    .map((id) => input.manifest.posts[id])
    .filter(
      (post): post is BlogPost =>
        Boolean(post) &&
        getPostCollectionId(post) === input.collectionId &&
        (input.includeDrafts || !post.draft)
    );

  if (postOrder.length > 0) {
    return orderedPosts;
  }

  return Object.values(input.manifest.posts)
    .filter(
      (post) =>
        getPostCollectionId(post) === input.collectionId &&
        (input.includeDrafts || !post.draft)
    )
    .sort((left, right) => {
      const leftDate = assertValidBlogPublishMetadata(left).timestamp;
      const rightDate = assertValidBlogPublishMetadata(right).timestamp;
      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }
      return compareStrings(left.slug, right.slug);
    });
}

function toFeedItem(input: {
  post: BlogPost;
  embedParam: string;
  itemPath?: (post: BlogPost) => string;
  itemEmbedPath?: (post: BlogPost) => string;
}): DatedCollectionJsonFeedItem {
  assertValidBlogPublishMetadata(input.post);

  const path = input.itemPath ? input.itemPath(input.post) : input.post.path;
  const embedPath = input.itemEmbedPath
    ? input.itemEmbedPath(input.post)
    : appendEmbedParam(path, input.embedParam);

  return {
    id: input.post.id,
    collectionId: input.post.collectionId,
    title: input.post.title,
    slug: input.post.slug,
    date: input.post.date,
    publishedAt: input.post.publishedAt,
    path,
    embedPath,
    excerpt: input.post.excerpt,
    summary: input.post.summary,
    author: input.post.author,
    tags: input.post.tags,
    version: input.post.version,
  };
}

export function buildDatedCollectionJsonFeed(
  manifest: DocsManifest,
  options: BuildDatedCollectionJsonFeedOptions
): DatedCollectionJsonFeed {
  const collectionId = normalizeCollectionId(options.collectionId);
  const surface = getCollectionSurface(collectionId, manifest);
  const title = options.title ?? surface?.label ?? collectionId;
  const listPath = surface?.listRoute ?? (collectionId === "blog" ? "/blog" : `/${collectionId}`);
  const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
  const embedParam = normalizeEmbedParam(options.embedParam);

  const items = getCollectionPosts({
    manifest,
    collectionId,
    includeDrafts: Boolean(options.includeDrafts),
  })
    .slice(0, limit)
    .map((post) =>
      toFeedItem({
        post,
        embedParam,
        itemPath: options.itemPath,
        itemEmbedPath: options.itemEmbedPath,
      })
    );

  return {
    collectionId,
    title,
    description: options.description,
    listPath,
    feedPath: surface?.feedPath,
    latest: items[0] ?? null,
    items,
  };
}
