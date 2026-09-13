import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultDocsConfig, type DocsConfig } from "@docsfn/core";
import { afterEach, describe, expect, it } from "vitest";
import { FsContentProvider } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  tempDirs.length = 0;
});

async function createTempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "docsfn-provider-fs-"));
  tempDirs.push(directory);
  return directory;
}

function createConfig(root: string, overrides: Partial<DocsConfig> = {}): DocsConfig {
  const defaults = createDefaultDocsConfig({ cwd: root });
  return {
    ...defaults,
    ...overrides,
    content: {
      ...defaults.content,
      ...(overrides.content ?? {}),
      root,
    },
  };
}

describe("FsContentProvider", () => {
  it("loads docs/pages/blog/api/assets and preserves meta.json as control entry", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await mkdir(join(root, "pages"), { recursive: true });
    await mkdir(join(root, "blog"), { recursive: true });
    await mkdir(join(root, "api"), { recursive: true });
    await mkdir(join(root, "public"), { recursive: true });

    await writeFile(join(root, "content/docs/meta.json"), '{"title":"Docs"}\n');
    await writeFile(
      join(root, "content/docs/index.mdx"),
      "---\ntitle: Home\n---\n\n# Home\n"
    );
    await writeFile(join(root, "pages/changelog.mdx"), "# Changelog\n");
    await writeFile(join(root, "blog/post-1.mdx"), "# Post\n");
    await writeFile(join(root, "api/openapi.yaml"), "openapi: 3.0.0\n");
    await writeFile(join(root, "public/diagram.png"), Buffer.from([0, 1, 2]));

    const provider = new FsContentProvider({ root });
    const entries = await provider.listEntries({
      config: createConfig(root),
      collections: ["docs", "pages", "blog", "api", "assets"],
    });

    const docsEntries = entries.filter((entry) => entry.collection === "docs");
    const pageEntries = entries.filter((entry) => entry.collection === "pages");
    const blogEntries = entries.filter((entry) => entry.collection === "blog");
    const apiEntries = entries.filter((entry) => entry.collection === "api");
    const assetEntries = entries.filter((entry) => entry.collection === "assets");
    const controlEntries = entries.filter((entry) => entry.entryType === "control");

    expect(docsEntries.some((entry) => entry.relativePath === "index.mdx")).toBe(true);
    expect(pageEntries.some((entry) => entry.relativePath === "changelog.mdx")).toBe(true);
    expect(blogEntries.some((entry) => entry.relativePath === "post-1.mdx")).toBe(true);
    expect(apiEntries.some((entry) => entry.relativePath === "openapi.yaml")).toBe(true);
    expect(assetEntries.some((entry) => entry.relativePath === "diagram.png")).toBe(true);
    expect(controlEntries.some((entry) => entry.relativePath === "meta.json")).toBe(true);
  });

  it("does not expose meta.json as a page in legacy list output", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/meta.json"), '{"title":"Docs"}\n');
    await writeFile(join(root, "content/docs/getting-started.mdx"), "# Getting Started\n");

    const provider = new FsContentProvider({ root });
    const legacyEntries = await provider.list();

    expect(legacyEntries.some((entry) => entry.id === "meta.json")).toBe(false);
    expect(legacyEntries.some((entry) => entry.id === "getting-started.mdx")).toBe(true);
  });

  it("resolves relative content roots from the requested site root", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");
    const config = createConfig(root);
    config.content.root = ".";

    const entries = await new FsContentProvider({ root }).listEntries({
      config,
      collections: ["docs"],
    });

    expect(entries.map((entry) => entry.relativePath)).toEqual(["index.mdx"]);
  });

  it("honors a configured metadata filename", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/_nav.json"), '{"pages":["index"]}\n');
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");

    const entries = await new FsContentProvider({ root }).listEntries({
      config: createConfig(root, { content: { root, metaFileName: "_nav.json" } }),
      collections: ["docs"],
    });

    expect(entries.find((entry) => entry.relativePath === "_nav.json")?.entryType).toBe(
      "control"
    );
  });

  it("rejects asset traversal, absolute paths, and symlink escapes", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");
    await writeFile(join(root, "public/inside.txt"), "inside\n");
    await writeFile(join(outside, "outside.txt"), "outside\n");
    await symlink(join(outside, "outside.txt"), join(root, "public/link.txt"));

    const provider = new FsContentProvider({ root });
    const config = createConfig(root);
    await expect(provider.loadAsset({ config, relativePath: "inside.txt" })).resolves.toMatchObject({
      relativePath: "inside.txt",
    });
    for (const relativePath of ["../outside.txt", "..\\outside.txt", "/tmp/outside.txt", "C:\\outside.txt", "link.txt"]) {
      await expect(provider.loadAsset({ config, relativePath })).rejects.toMatchObject({
        code: "DOCS_ENTRY_INVALID",
      });
    }
  });

  it("loads configured dated collections from their own directories", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await mkdir(join(root, "content/changelog"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");
    await writeFile(
      join(root, "content/changelog/release.mdx"),
      "---\ntitle: Release\ndate: 2026-03-01\n---\n\n# Release\n"
    );

    const provider = new FsContentProvider({ root });
    const changelogCollection = "collection:changelog" as const;
    const entries = await provider.listEntries({
      config: createConfig(root, {
        collections: {
          changelog: {
            dir: "content/changelog",
            routeBase: "/changelog",
          },
        },
      }),
      collections: ["docs", changelogCollection],
    });

    const changelogEntry = entries.find(
      (entry) => entry.collection === changelogCollection
    );
    expect(changelogEntry).toMatchObject({
      id: "collection:changelog:release.mdx",
      collection: changelogCollection,
      relativePath: "release.mdx",
      entryType: "content",
    });
    expect(changelogEntry?.frontmatter.title).toBe("Release");
  });

  it("assigns missing frontmatter title defaults", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/no-frontmatter.mdx"), "# Title\n");

    const provider = new FsContentProvider({ root });
    const entries = await provider.listEntries({
      config: createConfig(root),
      collections: ["docs"],
    });
    const entry = entries.find((value) => value.relativePath === "no-frontmatter.mdx");

    expect(entry).toBeDefined();
    expect(entry?.frontmatter.title).toBe("No Frontmatter");
  });

  it("loads multiple docs directories and lets later directories override shared pages", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "common/docs"), { recursive: true });
    await mkdir(join(root, "product/docs"), { recursive: true });
    await writeFile(join(root, "common/docs/shared.mdx"), "# Shared from common\n");
    await writeFile(join(root, "common/docs/override.mdx"), "# Override from common\n");
    await writeFile(join(root, "product/docs/override.mdx"), "# Override from product\n");
    await writeFile(join(root, "product/docs/product-only.mdx"), "# Product only\n");

    const provider = new FsContentProvider({ root });
    const entries = await provider.listEntries({
      config: createConfig(root, {
        content: {
          root,
          docsDir: ["common/docs", "product/docs"],
        },
      }),
      collections: ["docs"],
    });

    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "override.mdx",
      "product-only.mdx",
      "shared.mdx",
    ]);
    expect(entries.find((entry) => entry.relativePath === "override.mdx")?.body).toContain(
      "Override from product"
    );
    expect(entries.find((entry) => entry.relativePath === "shared.mdx")?.body).toContain(
      "Shared from common"
    );
  });

  it("ignores unsupported extensions for docs collection", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/ignored.txt"), "ignore\n");
    await writeFile(join(root, "content/docs/kept.mdx"), "# Keep\n");

    const provider = new FsContentProvider({ root });
    const entries = await provider.listEntries({
      config: createConfig(root),
      collections: ["docs"],
    });

    expect(entries.some((entry) => entry.relativePath === "ignored.txt")).toBe(false);
    expect(entries.some((entry) => entry.relativePath === "kept.mdx")).toBe(true);
  });

  it("throws DOCS_ENTRY_INVALID when configured docsDir is missing", async () => {
    const root = await createTempRoot();
    const provider = new FsContentProvider({ root });
    const config = createConfig(root, {
      content: {
        root,
        docsDir: "content/missing-docs",
      },
    });

    await expect(
      provider.listEntries({
        config,
        collections: ["docs"],
      })
    ).rejects.toMatchObject({
      code: "DOCS_ENTRY_INVALID",
    });
  });

  it("throws DOCS_ENTRY_INVALID for unreadable/missing provider roots", async () => {
    const root = join(await createTempRoot(), "missing-root");
    const provider = new FsContentProvider({ root });
    const config = createConfig(root);

    await expect(
      provider.listEntries({
        config,
        collections: ["docs"],
      })
    ).rejects.toMatchObject({
      code: "DOCS_ENTRY_INVALID",
    });
  });

  it("emits deterministic ordering regardless of filesystem creation order", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/zeta.mdx"), "# Zeta\n");
    await writeFile(join(root, "content/docs/alpha.mdx"), "# Alpha\n");

    const provider = new FsContentProvider({ root });
    const entries = await provider.listEntries({
      config: createConfig(root),
      collections: ["docs"],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "docs:alpha.mdx",
      "docs:zeta.mdx",
    ]);
  });
});
