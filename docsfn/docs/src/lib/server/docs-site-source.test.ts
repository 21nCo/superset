import { describe, expect, it, vi } from "vitest";
import {
  createDocsSiteSearchRuntime,
  getCompiledDocsPage,
  getDocsSiteCompiledCacheSummary,
  loadDocsSiteSource,
} from "./docs-site-source";
import { load as loadBlogListPage } from "../../routes/blog/+page.server";
import { load as loadBlogPage } from "../../routes/blog/[...slug]/+page.server";
import { load as loadChangelogPage } from "../../routes/changelog/[slug]/+page.server";
import { GET as getLatestChangelog } from "../../routes/changelog/latest/+server";
import { GET as getChangelogJson } from "../../routes/changelog.json/+server";
import { load as loadDocsPage } from "../../routes/docs/[...slug]/+page.server";

describe("docsfn dogfood site source", () => {
  it("classifies API content truthfully and queries through the canonical search runtime", async () => {
    const source = await loadDocsSiteSource();

    const apiMarkdownPage = source.searchArtifact.documents.find(
      (document) => document.path === "/docs/api/core"
    );
    expect(apiMarkdownPage?.kind).toBe("page");
    expect(apiMarkdownPage?.scope).toBe("api");

    const generatedApiDocument = source.searchArtifact.documents.find(
      (document) => document.kind === "api"
    );
    expect(generatedApiDocument).toBeDefined();
    expect(generatedApiDocument?.scope).toBe("api");

    const runtime = await createDocsSiteSearchRuntime();
    const results = await runtime.query({
      query: "manifest",
      scope: "api",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.scope === "api")).toBe(true);
    expect(results.some((item) => item.path === "/docs/api/core")).toBe(true);
    expect(results.some((item) => item.path.startsWith("/docs/core-concepts/"))).toBe(false);

    const changelogDocument = source.searchArtifact.documents.find(
      (document) => document.path === "/changelog/docsfn-v0-1-0"
    );
    expect(changelogDocument?.kind).toBe("post");
    expect(changelogDocument?.scope).toBe("changelog");

    const changelogResults = await runtime.query({
      query: "changelog foundation",
      scope: "changelog",
      limit: 10,
    });
    expect(changelogResults.some((item) => item.path === "/changelog/docsfn-v0-1-0")).toBe(true);

    const changelogJsonResponse = (await getChangelogJson()) as Response;
    expect(changelogJsonResponse.status).toBe(200);
    const changelogJson = (await changelogJsonResponse.json()) as {
      collectionId: string;
      latest: { slug: string; embedPath: string } | null;
      items: Array<{ collectionId?: string; slug: string }>;
    };
    expect(changelogJson.collectionId).toBe("changelog");
    expect(changelogJson.latest?.slug).toBe("docsfn-v0-1-0");
    expect(changelogJson.latest?.embedPath).toBe("/changelog/docsfn-v0-1-0?embed=1");
    expect(changelogJson.items.every((item) => item.collectionId === "changelog")).toBe(true);

    const latestChangelogResponse = (await getLatestChangelog({
      url: new URL("https://docsfn.test/changelog/latest?embed=1"),
    } as never)) as Response;
    expect(latestChangelogResponse.status).toBe(302);
    expect(latestChangelogResponse.headers.get("location")).toBe(
      "/changelog/docsfn-v0-1-0?embed=1"
    );

    const blogList = await loadBlogListPage({
      parent: async () => ({ source }),
    } as never);
    expect(blogList.posts.every((post) => post.collectionId === "blog")).toBe(true);
    expect(blogList.posts.some((post) => post.slug === "docsfn-v0-1-0")).toBe(false);
  });

  it("reuses deterministic compiled artifacts across repeated docs and blog loads", async () => {
    const source = await loadDocsSiteSource();

    const cacheSummaryA = await getDocsSiteCompiledCacheSummary();
    const cacheSummaryB = await getDocsSiteCompiledCacheSummary();

    expect(cacheSummaryA).toEqual(cacheSummaryB);
    expect(cacheSummaryA.framework).toBe("svelte");
    expect(cacheSummaryA.pageKeys.length).toBeGreaterThan(0);
    expect(cacheSummaryA.postKeys.length).toBeGreaterThan(0);
    expect(cacheSummaryA.pageKeys.every((key) => key.endsWith("|svelte|none"))).toBe(true);
    expect(cacheSummaryA.postKeys.every((key) => key.endsWith("|svelte|none"))).toBe(true);

    const firstDocsLoad = await loadDocsPage({
      params: {
        slug: ["api", "core"],
      },
      url: new URL("https://docsfn.test/docs/api/core"),
      parent: async () => ({ source }),
    } as never);
    const secondDocsLoad = await loadDocsPage({
      params: {
        slug: ["api", "core"],
      },
      url: new URL("https://docsfn.test/docs/api/core"),
      parent: async () => ({ source }),
    } as never);

    expect(firstDocsLoad.compiled).toBe(secondDocsLoad.compiled);
    expect(firstDocsLoad.compiled?.renderModelVersion).toBe(2);

    const embeddedDocsLoad = await loadDocsPage({
      params: {
        slug: ["api", "core"],
      },
      url: new URL("https://docsfn.test/docs/api/core?embed=1"),
      parent: async () => ({ source }),
    } as never);
    expect(embeddedDocsLoad.embed).toBe(true);

    const firstBlogLoad = await loadBlogPage({
      params: {
        slug: "introducing-docsfn",
      },
      parent: async () => ({ source }),
    } as never);
    const secondBlogLoad = await loadBlogPage({
      params: {
        slug: "introducing-docsfn",
      },
      parent: async () => ({ source }),
    } as never);

    expect(firstBlogLoad.compiled).toBe(secondBlogLoad.compiled);
    expect(firstBlogLoad.compiled?.renderModelVersion).toBe(2);

    const firstChangelogLoad = await loadChangelogPage({
      params: {
        slug: "docsfn-v0-1-0",
      },
      url: new URL("https://docsfn.test/changelog/docsfn-v0-1-0"),
      parent: async () => ({ source }),
    } as never);
    const secondChangelogLoad = await loadChangelogPage({
      params: {
        slug: "docsfn-v0-1-0",
      },
      url: new URL("https://docsfn.test/changelog/docsfn-v0-1-0"),
      parent: async () => ({ source }),
    } as never);

    expect(firstChangelogLoad.post.collectionId).toBe("changelog");
    expect(firstChangelogLoad.compiled).toBe(secondChangelogLoad.compiled);
    expect(firstChangelogLoad.compiled?.renderModelVersion).toBe(2);

    const embeddedChangelogLoad = await loadChangelogPage({
      params: {
        slug: "docsfn-v0-1-0",
      },
      url: new URL("https://docsfn.test/changelog/docsfn-v0-1-0?embed=1"),
      parent: async () => ({ source }),
    } as never);
    expect(embeddedChangelogLoad.embed).toBe(true);
  });

  it("resolves relative links on collapsed index pages against the section route", async () => {
    const compiled = await getCompiledDocsPage("docs:core-concepts/index.md");
    const html = compiled.blocks
      .map((block) => ("html" in block ? block.html : ""))
      .join("\n");
    expect(html).toContain('href="/docs/core-concepts/configuration"');
    expect(html).not.toContain('href="./configuration"');
  });
});

it('rejects changelog paths that are not mounted by the site', async () => {
  vi.resetModules();
  vi.doMock('@docsfn/core', async (importOriginal) => {
    const core = await importOriginal<typeof import('@docsfn/core')>();
    return { ...core, loadDocsConfig: async (input: Parameters<typeof core.loadDocsConfig>[0]) => {
      const config = await core.loadDocsConfig(input);
      return { ...config, collections: { ...config.collections, changelog: { ...config.collections?.changelog, routeBase: '/elsewhere' } } };
    } };
  });
  try {
    const { loadDocsSiteSource: loadFresh } = await import('./docs-site-source');
    await expect(loadFresh()).rejects.toThrow(/changelog routes are mounted/);
  } finally { vi.doUnmock('@docsfn/core'); vi.resetModules(); }
});
