import { mkdir, mkdtemp, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getDocsConfigDependencies, isDocsConfigError, loadDocsConfig } from "./config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dirPath) => {
      for (const entry of await readdir(dirPath).catch(() => [] as string[])) {
        if (entry.startsWith(".docsfn.") && entry.endsWith(".mjs")) {
          await unlink(join(dirPath, entry)).catch(() => undefined);
        }
      }
      await rm(dirPath, { recursive: true, force: true });
    })
  );
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dirPath = await mkdtemp(join(tmpdir(), "docsfn-config-test-"));
  tempDirs.push(dirPath);
  return dirPath;
}

function serializeConfig(config: unknown): string {
  return `export default ${JSON.stringify(config, null, 2)};\n`;
}

describe("loadDocsConfig", () => {
  it("loads explicit configPath before default config file", async () => {
    const cwd = await createTempDir();
    const explicitConfigPath = join(cwd, "custom.config.mjs");

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Default Config", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
      })
    );

    await writeFile(
      explicitConfigPath,
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Explicit Config", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
      })
    );

    const loaded = await loadDocsConfig({
      cwd,
      configPath: explicitConfigPath,
    });

    expect(loaded.site.title).toBe("Explicit Config");
  });

  it("loads docsfn.config.ts when present", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.ts"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "TypeScript Config", basePath: "/docs" },
        compat: { preset: "fumadocs-v15" },
        content: { root: cwd, docsDir: "content/docs", apiDir: "api" },
      })
    );

    const loaded = await loadDocsConfig({ cwd });
    expect(loaded.site.title).toBe("TypeScript Config");
    expect(loaded.compat?.preset).toBe("fumadocs-v15");
  });

  it("loads a TypeScript config that imports a sibling module", async () => {
    const cwd = await createTempDir();

    await writeFile(join(cwd, "theme.js"), "export const title = 'Imported Theme';\n");
    await writeFile(
      join(cwd, "docsfn.config.ts"),
      [
        'import { title } from "./theme.js";',
        "namespace DocsfnForceTranspile { export const marker = 1; }",
        "void DocsfnForceTranspile.marker;",
        "export default {",
        "  schemaVersion: 1,",
        "  site: { title, basePath: '/docs' },",
        "  compat: { preset: 'none' },",
        `  content: { root: ${JSON.stringify(cwd)}, docsDir: 'content/docs' },`,
        "};",
        "",
      ].join("\n")
    );

    const [first, second] = await Promise.all([loadDocsConfig({ cwd }), loadDocsConfig({ cwd })]);
    expect(first.site.title).toBe("Imported Theme");
    expect(second.site.title).toBe("Imported Theme");
  });

  it("reloads an edited JavaScript config instead of returning the module cache", async () => {
    const cwd = await createTempDir();
    const configPath = join(cwd, "docsfn.config.mjs");
    const createConfig = (title: string) =>
      serializeConfig({
        schemaVersion: 1,
        site: { title, basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
      });

    await writeFile(configPath, createConfig("Before"));
    expect((await loadDocsConfig({ cwd })).site.title).toBe("Before");

    await writeFile(configPath, createConfig("After"));
    const changedAt = new Date(Date.now() + 1_000);
    await utimes(configPath, changedAt, changedAt);

    expect((await loadDocsConfig({ cwd })).site.title).toBe("After");
  });

  it("fails closed with DOCS_CONFIG_INVALID when config shape is invalid", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        site: { title: "Invalid Config", basePath: "docs" },
        compat: { preset: "none" },
        content: { root: cwd },
      })
    );

    try {
      await loadDocsConfig({ cwd });
      throw new Error("expected loadDocsConfig to throw");
    } catch (error) {
      expect(isDocsConfigError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("DOCS_CONFIG_INVALID");
      expect((error as Error).message).toContain("site.basePath must start with '/'");
      expect((error as Error).message).toContain("schemaVersion must be 1");
    }
  });

  it("rejects unsupported compatibility presets", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Invalid Compat", basePath: "/docs" },
        compat: { preset: "unsupported-preset" },
        content: { root: cwd, docsDir: "content/docs" },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toMatchObject({
      code: "DOCS_CONFIG_INVALID",
    });
  });

  it("rejects invalid versions config with multiple defaults", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Invalid Versions", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        versions: {
          mode: "path-prefix",
          versions: [
            { slug: "v1", label: "Version 1", default: true },
            { slug: "v2", label: "Version 2", default: true },
          ],
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toMatchObject({
      code: "DOCS_CONFIG_INVALID",
    });
  });

  it("loads blog route config for changelog-style sections", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Changelog Config", basePath: "/docs" },
        compat: { preset: "none" },
        content: {
          root: cwd,
          docsDir: "content/docs",
          blogDir: "content/changelog",
        },
        blog: {
          routeBase: "/changelog",
          feedPath: "/changelog/rss.xml",
        },
      })
    );

    const loaded = await loadDocsConfig({ cwd });

    expect(loaded.content.blogDir).toBe("content/changelog");
    expect(loaded.blog?.routeBase).toBe("/changelog");
    expect(loaded.blog?.feedPath).toBe("/changelog/rss.xml");
  });

  it("loads dated collection config for first-class changelog sections", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Collections Config", basePath: "/docs" },
        compat: { preset: "none" },
        content: {
          root: cwd,
          docsDir: "content/docs",
        },
        collections: {
          changelog: {
            type: "dated",
            dir: "content/changelog",
            routeBase: "/changelog",
            feedPath: "/changelog/rss.xml",
            label: "Changelog",
            scope: "changelog",
          },
        },
      })
    );

    const loaded = await loadDocsConfig({ cwd });

    expect(loaded.collections?.changelog?.dir).toBe("content/changelog");
    expect(loaded.collections?.changelog?.routeBase).toBe("/changelog");
    expect(loaded.collections?.changelog?.feedPath).toBe("/changelog/rss.xml");
    expect(loaded.collections?.changelog?.label).toBe("Changelog");
    expect(loaded.collections?.changelog?.scope).toBe("changelog");
  });

  it("loads multiple docs directories for shared and product-specific docs", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Multi Root Config", basePath: "/docs" },
        compat: { preset: "none" },
        content: {
          root: cwd,
          docsDir: ["../common/content/docs", "content/docs"],
        },
      })
    );

    const loaded = await loadDocsConfig({ cwd });

    expect(loaded.content.docsDir).toEqual(["../common/content/docs", "content/docs"]);
  });

  it("rejects blog route config that does not start with a slash", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Invalid Blog Route", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        blog: {
          routeBase: "changelog",
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toMatchObject({
      code: "DOCS_CONFIG_INVALID",
    });
  });

  it("rejects dated collection routes that do not start with a slash", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Invalid Collection Route", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        collections: {
          changelog: {
            dir: "content/changelog",
            routeBase: "changelog",
          },
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toMatchObject({
      code: "DOCS_CONFIG_INVALID",
    });
  });

  it("rejects collection ids that normalize to the legacy blog surface", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Reserved Collection", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        collections: {
          Blog: {
            dir: "content/blog-v2",
            routeBase: "/blog-v2",
            feedPath: "/blog-v2/rss.xml",
          },
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toThrowError(
      /reserved for the legacy blog surface/
    );
  });

  it("rejects collection ids that collide after normalization", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Colliding Collections", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        collections: {
          Changelog: {
            dir: "content/changelog",
            routeBase: "/changelog",
          },
          changelog: {
            dir: "content/changelog-alt",
            routeBase: "/changelog-alt",
          },
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toThrowError(/collides with 'Changelog'/);
  });

  it("rejects collection ids that normalize to an empty identifier", async () => {
    const cwd = await createTempDir();

    await writeFile(
      join(cwd, "docsfn.config.mjs"),
      serializeConfig({
        schemaVersion: 1,
        site: { title: "Empty Collection", basePath: "/docs" },
        compat: { preset: "none" },
        content: { root: cwd, docsDir: "content/docs" },
        collections: {
          "/": {
            dir: "content/slash",
            routeBase: "/slash",
          },
        },
      })
    );

    await expect(loadDocsConfig({ cwd })).rejects.toThrowError(
      /must normalize to a nonempty identifier/
    );
  });

  it("returns deterministic defaults only when no config file exists", async () => {
    const cwd = await createTempDir();

    const loaded = await loadDocsConfig({ cwd });

    expect(loaded).toMatchObject({
      schemaVersion: 1,
      site: {
        title: "Docs",
        basePath: "/docs",
      },
      compat: {
        preset: "none",
      },
      content: {
        root: cwd,
        docsDir: "content/docs",
        pagesDir: "pages",
        blogDir: "blog",
        apiDir: "api",
        assetsDir: "public",
        metaFileName: "meta.json",
      },
      auth: {
        enabled: false,
        mode: "public",
      },
      analytics: {
        enabled: false,
        provider: "watchfn",
        respectDnt: true,
      },
    });
  });
});

it("reloads transitive ESM config imports and cleans temporary modules", async () => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, "docsfn.config.mjs"), 'import { title } from "./theme.mjs"; export default { schemaVersion: 1, site: { title }, content: { root: "." } };');
  await writeFile(join(cwd, "theme.mjs"), 'export { title } from "./title.mjs";');
  await writeFile(join(cwd, "title.mjs"), 'export const title = "Before";');
  expect((await loadDocsConfig({ cwd })).site.title).toBe("Before");
  await writeFile(join(cwd, "title.mjs"), 'export const title = "After";');
  expect((await loadDocsConfig({ cwd })).site.title).toBe("After");
  expect((await readdir(cwd)).filter((name) => name.startsWith(".docsfn."))).toEqual([]);
});
it.each([["/"], ["v1", "v1"]])("rejects ambiguous version slugs %j", async (...values) => {
  const slugs = values.flat() as string[];
  const cwd = await createTempDir();
  await writeFile(join(cwd, "docsfn.config.mjs"), serializeConfig({ schemaVersion: 1, site: { title: "Test" }, content: { root: "." }, versions: { mode: "path-prefix", versions: slugs.map((slug) => ({ slug, label: slug })) } }));
  await expect(loadDocsConfig({ cwd })).rejects.toMatchObject({ code: "DOCS_CONFIG_INVALID" });
});

it("reloads local CommonJS and JSON dependencies without retaining files", async () => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, "docsfn.config.js"), 'const title = require("./theme.cjs"); module.exports = { schemaVersion: 1, site: { title }, content: { root: "." } };');
  await writeFile(join(cwd, "theme.cjs"), 'module.exports = require("./title.json").title;');
  await writeFile(join(cwd, "title.json"), '{"title":"Before"}');
  expect((await loadDocsConfig({ cwd })).site.title).toBe("Before");
  await writeFile(join(cwd, "title.json"), '{"title":"After"}');
  expect((await loadDocsConfig({ cwd })).site.title).toBe("After");
  expect((await readdir(cwd)).filter((name) => name.startsWith(".docsfn."))).toEqual([]);
});

it('loads extensionless TypeScript config dependencies concurrently', async () => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, 'theme.ts'), 'export const title: string = "Theme";');
  await writeFile(join(cwd, 'docsfn.config.ts'), `import { title } from './theme'; export default { schemaVersion: 1, site: { title }, content: { root: ${JSON.stringify(cwd)} }, compat: { preset: 'none' } };`);
  const loaded = await Promise.all(Array.from({ length: 12 }, () => loadDocsConfig({ cwd })));
  expect(loaded.every(config => config.site.title === 'Theme')).toBe(true);
  expect((await readdir(cwd)).some(file => file.startsWith('.docsfn.'))).toBe(false);
});
it('respects CommonJS scope for side-effect-only require dependencies', async () => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(cwd, 'side.js'), 'require("./values.json");');
  await writeFile(join(cwd, 'values.json'), '{}');
  await writeFile(join(cwd, 'docsfn.config.cjs'), `require('./side.js'); module.exports = { schemaVersion: 1, site: { title: 'CJS' }, content: { root: ${JSON.stringify(cwd)} }, compat: { preset: 'none' } };`);
  expect((await loadDocsConfig({ cwd, configPath: 'docsfn.config.cjs' })).site.title).toBe('CJS');
});

it("records missing extensionless dependency candidates and recovers when created", async () => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, "docsfn.config.ts"), `import { title } from './missing'; export default { schemaVersion: 1, site: { title }, content: { root: ${JSON.stringify(cwd)} } };`);
  await expect(loadDocsConfig({ cwd })).rejects.toThrow();
  expect(getDocsConfigDependencies(join(cwd, "docsfn.config.ts"))).toContain(join(cwd, "missing.ts"));
  await writeFile(join(cwd, "missing.ts"), 'export const title = "Recovered";');
  expect((await loadDocsConfig({ cwd })).site.title).toBe("Recovered");
});

it.each(['theme', 'theme/index.js', 'theme/index.ts'])('reloads exact extensionless and directory dependencies: %s', async relative => {
  const cwd = await createTempDir();
  if (relative.includes('/')) await mkdir(join(cwd, 'theme'));
  await writeFile(join(cwd, relative), 'export const title = "Before";');
  await writeFile(join(cwd, 'docsfn.config.ts'), `import { title } from './theme'; export default { schemaVersion: 1, site: { title }, content: { root: '.' } };`);
  expect((await loadDocsConfig({ cwd })).site.title).toBe('Before');
  await writeFile(join(cwd, relative), 'export const title = "After";');
  expect((await loadDocsConfig({ cwd })).site.title).toBe('After');
});
it.each(['import values from "./values.json";', 'const { default: values } = await import("./values.json");', 'import values from "./values.json" with { type: "json" };'])('loads and refreshes ESM JSON config imports: %s', async statement => {
  const cwd = await createTempDir();
  await writeFile(join(cwd, 'values.json'), '{"title":"Before"}');
  await writeFile(join(cwd, 'docsfn.config.mjs'), `${statement} export default { schemaVersion: 1, site: { title: values.title }, content: { root: '.' } };`);
  expect((await loadDocsConfig({ cwd })).site.title).toBe('Before');
  await writeFile(join(cwd, 'values.json'), '{"title":"After"}');
  expect((await loadDocsConfig({ cwd })).site.title).toBe('After');
  expect((await readdir(cwd)).some(file => file.startsWith('.docsfn.'))).toBe(false);
});

it.each(['theme', 'theme/index.js'])('reloads CommonJS exact and directory modules: %s', async relative => {
  const cwd = await createTempDir();
  if (relative.includes('/')) await mkdir(join(cwd, 'theme'));
  await writeFile(join(cwd, relative), 'module.exports = "Before";');
  await writeFile(join(cwd, 'docsfn.config.cjs'), `const title = require('./theme'); module.exports = { schemaVersion: 1, site: { title }, content: { root: '.' } };`);
  expect((await loadDocsConfig({ cwd, configPath: 'docsfn.config.cjs' })).site.title).toBe('Before');
  await writeFile(join(cwd, relative), 'module.exports = "After";');
  expect((await loadDocsConfig({ cwd, configPath: 'docsfn.config.cjs' })).site.title).toBe('After');
});
