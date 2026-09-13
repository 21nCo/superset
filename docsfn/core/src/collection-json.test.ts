import { describe, expect, it } from "vitest";
import { buildDatedCollectionJsonFeed } from "./collection-json";
import type { BlogPost, DocsManifest } from "./types";

function createPost(input: Partial<BlogPost> & Pick<BlogPost, "id" | "slug" | "path" | "title" | "date">): BlogPost {
  return {
    kind: "post",
    tags: [],
    body: `${input.title} body`,
    frontmatter: {},
    ...input,
  };
}

function createManifest(): DocsManifest {
  const blogPost = createPost({
    id: "blog:introducing-docsfn.md",
    collectionId: "blog",
    slug: "introducing-docsfn",
    path: "/blog/introducing-docsfn",
    title: "Introducing docsfn",
    date: "2026-03-22",
    publishedAt: "2026-03-22T00:00:00.000Z",
    excerpt: "Blog excerpt",
  });
  const olderChangelogPost = createPost({
    id: "collection:changelog:alpha.md",
    collectionId: "changelog",
    slug: "alpha",
    path: "/changelog/alpha",
    title: "Alpha update",
    date: "2026-07-09",
    publishedAt: "2026-07-09T00:00:00.000Z",
    excerpt: "Alpha excerpt",
    tags: ["platform"],
  });
  const latestChangelogPost = createPost({
    id: "collection:changelog:beta.md",
    collectionId: "changelog",
    slug: "beta",
    path: "/changelog/beta",
    title: "Beta update",
    date: "2026-07-10",
    publishedAt: "2026-07-10T00:00:00.000Z",
    summary: "Beta summary",
    tags: ["release"],
  });

  return {
    site: {
      title: "docsfn",
    },
    pages: {},
    posts: {
      [blogPost.id]: blogPost,
      [olderChangelogPost.id]: olderChangelogPost,
      [latestChangelogPost.id]: latestChangelogPost,
    },
    apis: {},
    sidebars: {},
    routes: {
      [blogPost.path]: blogPost.id,
      [olderChangelogPost.path]: olderChangelogPost.id,
      [latestChangelogPost.path]: latestChangelogPost.id,
    },
    blog: {
      listRoute: "/blog",
      feedPath: "/blog/rss.xml",
      postOrder: [blogPost.id],
      tags: {},
      archives: [],
    },
    collections: {
      changelog: {
        id: "changelog",
        label: "Changelog",
        scope: "changelog",
        listRoute: "/changelog",
        feedPath: "/changelog/rss.xml",
        postOrder: [latestChangelogPost.id, olderChangelogPost.id],
        tags: {},
        archives: [],
      },
    },
  };
}

describe("buildDatedCollectionJsonFeed", () => {
  it("builds a product-facing JSON feed from a named changelog collection", () => {
    const feed = buildDatedCollectionJsonFeed(createManifest(), {
      collectionId: "changelog",
      description: "Product updates",
    });

    expect(feed.collectionId).toBe("changelog");
    expect(feed.title).toBe("Changelog");
    expect(feed.description).toBe("Product updates");
    expect(feed.listPath).toBe("/changelog");
    expect(feed.feedPath).toBe("/changelog/rss.xml");
    expect(feed.latest?.slug).toBe("beta");
    expect(feed.latest?.embedPath).toBe("/changelog/beta?embed=1");
    expect(feed.items.map((item) => item.slug)).toEqual(["beta", "alpha"]);
    expect(feed.items.some((item) => item.slug === "introducing-docsfn")).toBe(false);
  });

  it("can limit notification payloads without changing item routes", () => {
    const feed = buildDatedCollectionJsonFeed(createManifest(), {
      collectionId: "changelog",
      limit: 1,
      embedParam: "docsEmbed",
    });

    expect(feed.items).toHaveLength(1);
    expect(feed.latest?.slug).toBe("beta");
    expect(feed.latest?.path).toBe("/changelog/beta");
    expect(feed.latest?.embedPath).toBe("/changelog/beta?docsEmbed=1");
  });

  it("normalizes Unicode collection ids consistently", () => {
    const manifest = createManifest();
    const changelog = manifest.collections!.changelog;
    manifest.collections = {
      "chang\u00e9log": {
        ...changelog,
        id: "chang\u00e9log",
      },
    };
    for (const post of Object.values(manifest.posts)) {
      if (post.collectionId === "changelog") {
        post.collectionId = "chang\u00e9log";
      }
    }

    const feed = buildDatedCollectionJsonFeed(manifest, {
      collectionId: "Change\u0301log",
    });

    expect(feed.collectionId).toBe("chang\u00e9log");
    expect(feed.items.map((item) => item.slug)).toEqual(["beta", "alpha"]);
  });

  it("preserves multi-hash fragments when appending the embed param", () => {
    const feed = buildDatedCollectionJsonFeed(createManifest(), {
      collectionId: "changelog",
      limit: 1,
      itemPath: (post) => `${post.path}#section#details`,
    });

    expect(feed.latest?.embedPath).toBe(
      "/changelog/beta?embed=1#section#details"
    );
  });
});
