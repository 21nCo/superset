import { assertValidBlogPublishMetadata, resolveBlogLastBuildDate } from "./blog";
import { normalizeDatedCollectionId } from "./provider";
import type { BlogPost, DocsManifest } from "./types";

export interface RSSFeedOptions {
  title: string;
  description: string;
  /**
   * Generate a feed for a named dated collection such as `changelog`.
   * When omitted, the legacy blog surface is used.
   */
  collectionId?: string;
  /** Public URL for the channel (often the blog index page). */
  link: string;
  language?: string;
  /**
   * Absolute URL for this feed’s `atom:link rel="self"`.
   * Default: the origin from `link` joined with the manifest feed path.
   */
  feedHref?: string;
  /**
   * Absolute permalink for a post. Use when public blog URLs differ from `post.path` on the manifest
   * (e.g. docs at `/docs` but the app serves posts under `/blog/[slug]`).
   */
  itemHref?: (post: BlogPost) => string;
}

/**
 * Generate RSS 2.0 feed XML from blog posts
 */
export function generateRSSFeed(
  manifest: DocsManifest,
  options: RSSFeedOptions
): string {
  const { title, description, link, language = "en" } = options;

  let linkEnd = link.length;
  while (linkEnd > 0 && link.charCodeAt(linkEnd - 1) === 47) linkEnd -= 1;
  const normalizedLink = link.slice(0, linkEnd);
  const siteOrigin = new URL(normalizedLink).origin;
  const hasRequestedCollection = options.collectionId !== undefined;
  const requestedCollectionId = hasRequestedCollection
    ? normalizeDatedCollectionId(options.collectionId ?? "")
    : undefined;
  const collectionSurface = requestedCollectionId
    ? manifest.collections?.[requestedCollectionId]
    : undefined;
  const orderedIds = hasRequestedCollection
    ? collectionSurface?.postOrder ?? []
    : manifest.blog?.postOrder ?? [];
  const orderedPostsFromManifest = orderedIds
    .map((id) => manifest.posts[id])
    .filter((post): post is BlogPost => Boolean(post));
  const fallbackPosts =
    hasRequestedCollection && !collectionSurface
      ? []
      : Object.values(manifest.posts)
          .filter(
            (post) =>
              normalizeDatedCollectionId(post.collectionId ?? "blog") ===
              (requestedCollectionId ?? "blog")
          )
          .sort((left, right) => {
            const leftDate = assertValidBlogPublishMetadata(left).timestamp;
            const rightDate = assertValidBlogPublishMetadata(right).timestamp;
            if (leftDate !== rightDate) {
              return rightDate - leftDate;
            }
            return left.slug.localeCompare(right.slug, "en", {
              sensitivity: "variant",
              numeric: true,
            });
          });
  const posts =
    orderedPostsFromManifest.length > 0
      ? orderedPostsFromManifest
      : fallbackPosts;

  const items = posts
    .map((post) => {
      const publish = assertValidBlogPublishMetadata(post);
      const postLink = options.itemHref
        ? options.itemHref(post)
        : resolveSameOriginUrl(siteOrigin, post.path);
      const descriptionValue = post.excerpt ?? post.summary;
      return `
    <item>
      <title><![CDATA[${escapeCdata(post.title)}]]></title>
      <link>${escapeXml(postLink)}</link>
      <guid isPermaLink="true">${escapeXml(postLink)}</guid>
      <pubDate>${new Date(publish.publishedAt).toUTCString()}</pubDate>
      ${descriptionValue ? `<description><![CDATA[${escapeCdata(descriptionValue)}]]></description>` : ""}
      ${post.author ? `<author>${escapeXml(post.author)}</author>` : ""}
      ${post.tags.map((tag) => `<category>${escapeXml(tag)}</category>`).join("\n      ")}
    </item>
  `;
    })
    .join("");

  const feedPath = hasRequestedCollection
    ? collectionSurface?.feedPath ?? "/rss.xml"
    : manifest.blog?.feedPath ?? "/rss.xml";
  const feedLink = options.feedHref ?? resolveSameOriginUrl(siteOrigin, feedPath);
  const lastBuildDate = resolveBlogLastBuildDate(posts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${escapeXml(normalizedLink)}</link>
    <language>${escapeXml(language)}</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

function resolveSameOriginUrl(siteOrigin: string, route: string): string {
  const origin = new URL(siteOrigin).origin;
  const path = `/${route.replaceAll("\\", "/").replace(/^[a-z][a-z0-9+.-]*:/i, "").replace(/^\/+/, "")}`;
  const resolved = new URL(path, `${origin}/`);
  if (resolved.origin !== origin) {
    return new URL("/", `${origin}/`).toString();
  }
  return resolved.toString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeCdata(value: string): string {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}
