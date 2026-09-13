import { describe, expect, it } from "vitest";
import {
  assertUniqueSourceEntryIds,
  assertValidSourceEntries,
  createSourceEntryId,
  normalizeProviderPath,
  stableSortSourceEntries,
  toLegacyRawEntries,
  type DocsSourceEntry,
} from "./provider";

function createEntry(
  overrides: Partial<DocsSourceEntry> & {
    collection: DocsSourceEntry["collection"];
    relativePath: string;
  }
): DocsSourceEntry {
  const id = createSourceEntryId(overrides.collection, overrides.relativePath);
  return {
    id,
    collection: overrides.collection,
    relativePath: overrides.relativePath,
    entryType: "content",
    frontmatter: {},
    ...overrides,
  };
}

describe("provider contract helpers", () => {
  it("normalizes provider paths with stable separators", () => {
    expect(normalizeProviderPath("docs\\\\guide/../guide/intro.mdx")).toBe(
      "docs/guide/../guide/intro.mdx"
    );
    expect(normalizeProviderPath("./docs/getting-started.mdx")).toBe(
      "docs/getting-started.mdx"
    );
  });

  it("sorts source entries deterministically", () => {
    const entries: DocsSourceEntry[] = [
      createEntry({ collection: "docs", relativePath: "b/02.mdx" }),
      createEntry({ collection: "blog", relativePath: "welcome.mdx" }),
      createEntry({ collection: "docs", relativePath: "a/01.mdx" }),
    ];

    const sorted = stableSortSourceEntries(entries);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "blog:welcome.mdx",
      "docs:a/01.mdx",
      "docs:b/02.mdx",
    ]);
  });

  it("throws DOCS_PROVIDER_ERROR on duplicate source ids", () => {
    const duplicateId = "docs:getting-started.mdx";
    const entries: DocsSourceEntry[] = [
      {
        id: duplicateId,
        collection: "docs",
        relativePath: "getting-started.mdx",
        entryType: "content",
        frontmatter: {},
      },
      {
        id: duplicateId,
        collection: "docs",
        relativePath: "guides/getting-started.mdx",
        entryType: "content",
        frontmatter: {},
      },
    ];

    expect(() => assertUniqueSourceEntryIds(entries)).toThrowError(
      /provider emitted duplicate source entry id/
    );
  });

  it("accepts remote-ready source metadata (TV-CMS-001)", () => {
    const entries: DocsSourceEntry[] = [
      {
        id: "docs:getting-started",
        collection: "docs",
        relativePath: "getting-started.mdx",
        entryType: "content",
        frontmatter: {},
        etag: "W/123",
        updatedAt: "2026-03-20T00:00:00Z",
      },
    ];

    const validated = assertValidSourceEntries(entries);
    expect(validated[0].id).toBe("docs:getting-started");
    expect(validated[0].etag).toBe("W/123");
    expect(validated[0].updatedAt).toBe("2026-03-20T00:00:00Z");
  });

  it("maps canonical entries to legacy raw entries with stable ordering", () => {
    const entries: DocsSourceEntry[] = [
      createEntry({
        collection: "docs",
        relativePath: "z-last.mdx",
        frontmatter: { title: "Z" },
        body: "# Z",
      }),
      createEntry({
        collection: "docs",
        relativePath: "a-first.mdx",
        frontmatter: { title: "A" },
        body: "# A",
      }),
      createEntry({
        collection: "docs",
        relativePath: "meta.json",
        entryType: "control",
        frontmatter: {},
        body: "{}",
      }),
    ];

    const legacy = toLegacyRawEntries(entries);
    expect(legacy.map((entry) => entry.id)).toEqual(["a-first.mdx", "z-last.mdx"]);
    expect(legacy.map((entry) => entry.kind)).toEqual(["page", "page"]);
  });
});
