import { describe, expect, it } from "vitest";
import { buildCanonicalBlogRecords, buildCanonicalDatedCollectionRecords } from "./blog";
import type { NormalizedPostRecord } from "./normalize";

function createPost(
  id: string,
  overrides: Partial<NormalizedPostRecord> = {}
): NormalizedPostRecord {
  const date = overrides.date ?? "2026-03-01";
  const frontmatter = {
    date,
    ...(overrides.frontmatter ?? {}),
  };

  return {
    id,
    slug: id.replace(/^blog:/, "").replace(".mdx", ""),
    path: `/blog/${id}`,
    title: id,
    date,
    tags: [],
    body: "# Heading\n\nBody text",
    ...overrides,
    frontmatter,
  };
}

describe("buildCanonicalBlogRecords", () => {
  it("normalizes blog fields, excludes drafts, and emits deterministic tag/pagination surfaces (TV-BLOG-001)", () => {
    const input: NormalizedPostRecord[] = [
      createPost("blog:alpha.mdx", {
        slug: "alpha",
        title: "Alpha",
        date: "2026-03-01",
        tags: ["Release"],
        body: "Alpha release details",
        frontmatter: {
          author: "Docs Team",
        },
      }),
      createPost("blog:beta.mdx", {
        slug: "beta",
        title: "Beta",
        date: "2026-03-02",
        tags: ["release", "platform"],
        body: "Beta release details",
      }),
      createPost("blog:draft.mdx", {
        slug: "draft-post",
        title: "Draft",
        date: "2026-03-03",
        tags: ["internal"],
        frontmatter: {
          draft: true,
        },
      }),
    ];

    const canonical = buildCanonicalBlogRecords({
      posts: input,
      basePath: "/docs",
      pageSize: 1,
    });

    expect(canonical.posts.map((post) => post.slug)).toEqual(["beta", "alpha"]);
    expect(canonical.posts.every((post) => post.path.startsWith("/docs/blog"))).toBe(true);
    expect(canonical.posts[0]).toMatchObject({
      title: "Beta",
      date: "2026-03-02",
      draft: false,
      tags: ["platform", "release"],
    });
    expect(canonical.posts[1].author).toBe("Docs Team");
    expect(canonical.posts[1].excerpt).toBeDefined();

    expect(canonical.listRoute).toBe("/docs/blog");
    expect(canonical.feedPath).toBe("/docs/blog/rss.xml");
    expect(canonical.postOrder).toEqual(["blog:beta.mdx", "blog:alpha.mdx"]);
    expect(Object.keys(canonical.tags)).toEqual(["platform", "release"]);
    expect(canonical.tags.release.path).toBe("/docs/blog/tags/release");
    expect(canonical.tags.release.postIds).toEqual(["blog:beta.mdx", "blog:alpha.mdx"]);
    expect(canonical.archives.map((archive) => archive.path)).toEqual([
      "/docs/blog",
      "/docs/blog/page/2",
    ]);
  });

  it("rejects dated-collection tags that collapse to the same slug", () => {
    expect(() =>
      buildCanonicalBlogRecords({
        posts: [
          createPost("blog:cpp.mdx", { slug: "cpp", tags: ["c++"] }),
          createPost("blog:csharp.mdx", { slug: "csharp", tags: ["c#"] }),
        ],
        basePath: "/docs",
      })
    ).toThrowError(/collapse to the same slug/);
  });

  it("includes drafts only when preview mode is enabled", () => {
    const canonical = buildCanonicalBlogRecords({
      posts: [
        createPost("blog:draft.mdx", {
          slug: "draft-post",
          date: "2026-03-01",
          frontmatter: {
            draft: true,
          },
        }),
      ],
      preview: true,
      basePath: "/docs",
    });

    expect(canonical.posts).toHaveLength(1);
    expect(canonical.posts[0].draft).toBe(true);
  });

  it("accepts Date objects from parsed YAML frontmatter dates", () => {
    const canonical = buildCanonicalBlogRecords({
      posts: [
        createPost("blog:date-object.mdx", {
          slug: "date-object",
          frontmatter: {
            date: new Date("2026-03-04T00:00:00.000Z"),
          },
        }),
      ],
      basePath: "/docs",
    });

    expect(canonical.posts[0].date).toBe("2026-03-04");
  });

  it("uses custom route and feed paths for first-class changelog collections", () => {
    const canonical = buildCanonicalDatedCollectionRecords({
      posts: [
        createPost("collection:changelog:release.mdx", {
          collectionId: "changelog",
          collectionLabel: "Changelog",
          searchScope: "changelog",
          slug: "release",
          title: "Release",
          date: "2026-03-01",
          tags: ["release"],
        }),
      ],
      collectionId: "changelog",
      label: "Changelog",
      searchScope: "changelog",
      basePath: "/docs",
      routeBase: "/changelog",
      feedPath: "/changelog/rss.xml",
    });

    expect(canonical.listRoute).toBe("/changelog");
    expect(canonical.feedPath).toBe("/changelog/rss.xml");
    expect(canonical.id).toBe("changelog");
    expect(canonical.label).toBe("Changelog");
    expect(canonical.scope).toBe("changelog");
    expect(canonical.postOrder).toEqual(["collection:changelog:release.mdx"]);
    expect(canonical.posts[0].path).toBe("/changelog/release");
    expect(canonical.posts[0].collectionId).toBe("changelog");
    expect(canonical.tags.release.path).toBe("/changelog/tags/release");
    expect(canonical.archives[0].path).toBe("/changelog");
  });

  it("keeps root collection routes free of duplicate slashes", () => {
    const canonical = buildCanonicalDatedCollectionRecords({
      posts: [
        createPost("collection:releases:release.mdx", {
          collectionId: "releases",
          slug: "release",
          tags: ["release"],
        }),
        createPost("collection:releases:older.mdx", {
          collectionId: "releases",
          slug: "older",
          date: "2026-02-01",
        }),
      ],
      collectionId: "releases",
      basePath: "/",
      routeBase: "/",
      feedPath: "/rss.xml",
      pageSize: 1,
    });

    expect(canonical.feedPath).toBe("/rss.xml");
    expect(canonical.posts.map((post) => post.path)).toEqual(["/release", "/older"]);
    expect(canonical.tags.release.path).toBe("/tags/release");
    expect(canonical.archives.map((archive) => archive.path)).toEqual(["/", "/page/2"]);
  });

  it("throws DOCS_ARTIFACT_INVALID when publish date metadata is invalid", () => {
    expect(() =>
      buildCanonicalBlogRecords({
        posts: [
          createPost("blog:broken.mdx", {
            slug: "broken",
            date: "not-a-date",
          }),
        ],
        basePath: "/docs",
      })
    ).toThrowError(/DOCS_ARTIFACT_INVALID|invalid publish date metadata/);
  });

  it("is deterministic when provider entry order changes", () => {
    const source: NormalizedPostRecord[] = [
      createPost("blog:a.mdx", { slug: "a", date: "2026-03-01", tags: ["release"] }),
      createPost("blog:b.mdx", { slug: "b", date: "2026-03-02", tags: ["release", "platform"] }),
    ];

    const forward = buildCanonicalBlogRecords({ posts: source, basePath: "/docs" });
    const reversed = buildCanonicalBlogRecords({
      posts: [...source].reverse(),
      basePath: "/docs",
    });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

it.each(["", "rss.xml", "tags/release"])("rejects reserved collection route %s", (slug) => {
  expect(() => buildCanonicalBlogRecords({ posts: [createPost("blog:entry.mdx", { slug, tags: ["release"] })], basePath: "/docs" })).toThrow(/conflicts with generated collection route/);
});
