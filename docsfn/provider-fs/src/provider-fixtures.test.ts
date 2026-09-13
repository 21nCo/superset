import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDefaultDocsConfig } from "@docsfn/core";
import { describe, expect, it } from "vitest";
import { FsContentProvider } from "./index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(__dirname, "..", "..", "test-fixtures", "repo");

function fixtureRoot(name: "datafn-docs" | "searchfn-docs"): string {
  return resolve(fixturesRoot, name);
}

describe("provider canonical fixture coverage", () => {
  it.each([
    { name: "datafn-docs" as const, minDocsEntries: 20 },
    { name: "searchfn-docs" as const, minDocsEntries: 8 },
  ])("loads canonical fixture $name deterministically", async ({ name, minDocsEntries }) => {
    const root = fixtureRoot(name);
    const provider = new FsContentProvider({ root });
    const config = createDefaultDocsConfig({ cwd: root });

    const runA = await provider.listEntries({
      config,
      collections: ["docs", "pages", "blog", "api", "assets"],
    });
    const runB = await provider.listEntries({
      config,
      collections: ["docs", "pages", "blog", "api", "assets"],
    });

    const docsEntries = runA.filter(
      (entry) => entry.collection === "docs" && entry.entryType === "content"
    );
    const controlEntries = runA.filter(
      (entry) => entry.collection === "docs" && entry.entryType === "control"
    );

    expect(docsEntries.length).toBeGreaterThanOrEqual(minDocsEntries);
    expect(controlEntries.some((entry) => entry.relativePath.endsWith("meta.json"))).toBe(
      true
    );
    expect(runA.map((entry) => entry.id)).toEqual(runB.map((entry) => entry.id));
    expect(runA.every((entry) => entry.id.includes(":"))).toBe(true);
  });
});
