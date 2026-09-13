import { describe, expect, it } from "vitest";
import { buildCanonicalBlogRecords, buildCanonicalDatedCollectionRecords } from "./blog";
import { generateRSSFeed } from "./rss";
import type { DocsManifest } from "./types";

function createManifest(): DocsManifest {
  const canonicalBlog = buildCanonicalBlogRecords({
    posts: [
      {
        id: "blog:alpha.mdx",
        slug: "alpha",
        path: "/blog/alpha",
        title: "Alpha",
        date: "2026-03-01",
        tags: ["release"],
        body: "Alpha release details",
        frontmatter: {
          date: "2026-03-01",
          excerpt: "Alpha excerpt",
          author: "Core Team",
        },
      },
      {
        id: "blog:beta.mdx",
        slug: "beta",
        path: "/blog/beta",
        title: "Beta",
        date: "2026-03-02",
        tags: ["release", "platform"],
        body: "Beta release details",
        frontmatter: {
          date: "2026-03-02",
          excerpt: "Beta excerpt",
        },
      },
    ],
    basePath: "/docs",
  });

  return {
    site: {
      title: "Docs",
    },
    pages: {},
    posts: Object.fromEntries(canonicalBlog.posts.map((post) => [post.id, post])),
    apis: {},
    sidebars: {},
    routes: Object.fromEntries(canonicalBlog.posts.map((post) => [post.path, post.id])),
    blog: {
      listRoute: canonicalBlog.listRoute,
      feedPath: canonicalBlog.feedPath,
      postOrder: canonicalBlog.postOrder,
      tags: canonicalBlog.tags,
      archives: canonicalBlog.archives,
    },
  };
}

describe("generateRSSFeed", () => {
  it("emits deterministic RSS with canonical post order and feed location", () => {
    const manifest = createManifest();
    const rssA = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });
    const rssB = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });

    expect(rssA).toBe(rssB);
    expect(rssA).toContain("<atom:link href=\"https://docs.example.com/docs/blog/rss.xml\"");
    expect(rssA.indexOf("/docs/blog/beta")).toBeLessThan(rssA.indexOf("/docs/blog/alpha"));
    expect(rssA).toContain(
      `<lastBuildDate>${new Date("2026-03-02T00:00:00.000Z").toUTCString()}</lastBuildDate>`
    );
  });

  it("uses feedHref and itemHref when the public blog URLs differ from manifest paths", () => {
    const manifest = createManifest();
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://app.example.com/blog",
      feedHref: "https://app.example.com/blog/rss.xml",
      itemHref: (post) => `https://app.example.com/blog/${post.slug}`,
    });

    expect(rss).toContain(
      "<atom:link href=\"https://app.example.com/blog/rss.xml\" rel=\"self\" type=\"application/rss+xml\"/>"
    );
    expect(rss).toContain("<link>https://app.example.com/blog</link>");
    expect(rss).toContain("<link>https://app.example.com/blog/beta</link>");
    expect(rss).not.toContain("https://app.example.com/blog/docs/blog/");
  });

  it("fails closed on invalid publish metadata", () => {
    const manifest = createManifest();
    manifest.posts["blog:broken.mdx"] = {
      kind: "post",
      id: "blog:broken.mdx",
      slug: "broken",
      path: "/docs/blog/broken",
      title: "Broken",
      date: "invalid-date",
      tags: [],
      body: "broken",
      frontmatter: {},
    };
    manifest.blog = {
      ...manifest.blog!,
      postOrder: ["blog:broken.mdx", ...manifest.blog!.postOrder],
    };

    expect(() =>
      generateRSSFeed(manifest, {
        title: "Docs Blog",
        description: "Release updates",
        link: "https://docs.example.com",
      })
    ).toThrowError(/DOCS_ARTIFACT_INVALID|invalid publish date metadata/);
  });

  it("generates RSS for a named dated collection without mixing blog posts", () => {
    const manifest = createManifest();
    const canonicalChangelog = buildCanonicalDatedCollectionRecords({
      collectionId: "changelog",
      label: "Changelog",
      searchScope: "changelog",
      routeBase: "/changelog",
      feedPath: "/changelog/rss.xml",
      posts: [
        {
          id: "collection:changelog:release.mdx",
          collectionId: "changelog",
          collectionLabel: "Changelog",
          searchScope: "changelog",
          slug: "release",
          path: "/changelog/release",
          title: "Release",
          date: "2026-04-01",
          tags: ["release"],
          body: "Release details",
          frontmatter: {
            date: "2026-04-01",
            excerpt: "Release excerpt",
          },
        },
      ],
    });
    manifest.posts = {
      ...manifest.posts,
      ...Object.fromEntries(canonicalChangelog.posts.map((post) => [post.id, post])),
    };
    manifest.collections = {
      changelog: {
        id: canonicalChangelog.id,
        label: canonicalChangelog.label,
        scope: canonicalChangelog.scope,
        listRoute: canonicalChangelog.listRoute,
        feedPath: canonicalChangelog.feedPath,
        postOrder: canonicalChangelog.postOrder,
        tags: canonicalChangelog.tags,
        archives: canonicalChangelog.archives,
      },
    };

    const rss = generateRSSFeed(manifest, {
      collectionId: "ChangeLog",
      title: "Docs Changelog",
      description: "Product updates",
      link: "https://docs.example.com/changelog",
      feedHref: "https://docs.example.com/changelog/rss.xml",
      itemHref: (post) => `https://docs.example.com${post.path}`,
    });

    expect(rss).toContain("<title>Docs Changelog</title>");
    expect(rss).toContain("https://docs.example.com/changelog/release");
    expect(rss).not.toContain("/docs/blog/alpha");
    expect(rss).not.toContain("/docs/blog/beta");
  });

  it("does not fall back to blog posts for an unknown named collection", () => {
    const rss = generateRSSFeed(createManifest(), {
      collectionId: "missing",
      title: "Missing Collection",
      description: "No updates",
      link: "https://docs.example.com/missing",
    });

    expect(rss).not.toContain("/docs/blog/alpha");
    expect(rss).not.toContain("/docs/blog/beta");
    expect(rss).toContain(
      '<atom:link href="https://docs.example.com/rss.xml"'
    );
  });

  it("joins manifest routes from the site origin and safely splits CDATA terminators", () => {
    const manifest = createManifest();
    manifest.posts["blog:alpha.mdx"].title = "Alpha ]]> release";
    manifest.posts["blog:alpha.mdx"].excerpt = "Details ]]> continued";
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Updates",
      link: "https://docs.example.com/docs/blog",
    });
    expect(rss).toContain("https://docs.example.com/docs/blog/alpha");
    expect(rss).not.toContain("/docs/blog/docs/blog/");
    expect(rss).toContain("]]]]><![CDATA[>");
  });

  it("keeps protocol-relative feed paths on the site origin", () => {
    const manifest = createManifest();
    manifest.blog = {
      ...manifest.blog!,
      feedPath: "//evil.example/rss.xml",
    };
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });
    expect(rss).toContain(
      '<atom:link href="https://docs.example.com/evil.example/rss.xml"'
    );
    expect(rss).not.toContain("https://evil.example");
  });

  it("keeps backslash-prefixed feed paths on the site origin", () => {
    const manifest = createManifest();
    manifest.blog = {
      ...manifest.blog!,
      feedPath: "/\\evil.example/rss.xml",
    };
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });
    expect(rss).toContain(
      '<atom:link href="https://docs.example.com/evil.example/rss.xml"'
    );
    expect(rss).not.toContain("https://evil.example");
  });

  it("does not publish named-collection posts on the default blog feed", () => {
    const manifest = createManifest();
    manifest.blog = {
      ...manifest.blog!,
      postOrder: [],
    };
    manifest.posts["changelog:one.mdx"] = {
      kind: "post",
      id: "changelog:one.mdx",
      collectionId: "changelog",
      slug: "one",
      path: "/changelog/one",
      title: "Changelog One",
      date: "2026-03-03",
      tags: [],
      body: "one",
      frontmatter: {},
    };
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });
    expect(rss).not.toContain("Changelog One");
  });
});
