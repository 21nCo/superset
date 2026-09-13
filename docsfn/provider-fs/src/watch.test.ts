import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultDocsConfig } from "@docsfn/core";
import { afterEach, describe, expect, it } from "vitest";
import { FsContentProvider } from "./index";
import { buildFsWatchMetadata } from "./watch";

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
  const directory = await mkdtemp(join(tmpdir(), "docsfn-watch-test-"));
  tempDirs.push(directory);
  return directory;
}

describe("provider watch metadata", () => {
  it("builds deterministic watch metadata from entries", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");

    const provider = new FsContentProvider({ root });
    const config = createDefaultDocsConfig({ cwd: root });
    const entries = await provider.listEntries({
      config,
      collections: ["docs"],
    });

    const metadata = buildFsWatchMetadata({
      root,
      collectionDirectories: { docs: join(root, "content/docs") },
      entries,
    });

    expect(metadata.watchedFiles.length).toBeGreaterThan(0);
    expect(metadata.watchedDirectories.some((directory) => directory === root)).toBe(true);
    expect(metadata.collectionGlobs.docs?.some((glob) => glob.endsWith("/**/*"))).toBe(
      true
    );
  });

  it("returns watch metadata via provider.watch()", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");

    const provider = new FsContentProvider({ root });
    const config = createDefaultDocsConfig({ cwd: root });
    const subscription = await provider.watch({
      config,
      collections: ["docs"],
      onChange: () => {},
    });

    expect(subscription.metadata.watchedFiles.length).toBeGreaterThan(0);
    expect(subscription.metadata.watchedDirectories.length).toBeGreaterThan(0);
    await expect(subscription.close()).resolves.toBeUndefined();
  });

  it("resolves relative roots and includes configured named collections", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "content/docs"), { recursive: true });
    await mkdir(join(root, "content/changelog"), { recursive: true });
    await writeFile(join(root, "content/docs/index.mdx"), "# Home\n");
    await writeFile(
      join(root, "content/changelog/release.mdx"),
      "---\ntitle: Release\ndate: 2026-09-01\n---\n\n# Release\n"
    );

    const provider = new FsContentProvider({ root });
    const config = createDefaultDocsConfig({ cwd: root });
    config.content.root = ".";
    config.collections = {
      changelog: {
        dir: "content/changelog",
        routeBase: "/changelog",
      },
    };
    const subscription = await provider.watch({
      config,
      onChange: () => {},
    });

    expect(subscription.metadata.watchedDirectories).toContain(root);
    expect(subscription.metadata.watchedDirectories).toContain(
      join(root, "content/changelog")
    );
    expect(subscription.metadata.collectionGlobs["collection:changelog"]).toEqual(
      expect.arrayContaining([`${join(root, "content/changelog")}/**/*`])
    );
    await subscription.close();
  });
});
