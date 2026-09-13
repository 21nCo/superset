import {
  DocsCollection,
  DocsContentProvider,
  DocsProviderListEntriesInput,
  DocsProviderLoadEntryInput,
  DocsSourceEntry,
  RawContentEntry,
  DocPage,
  BlogPost,
  ApiReference,
} from "./types";
import { createSourceEntryId } from "./provider";

/**
 * Mock content provider for testing
 */
export class MockContentProvider implements DocsContentProvider {
  readonly providerId = "mock-content";

  constructor(private entries: RawContentEntry[]) {}

  async list(): Promise<RawContentEntry[]> {
    return this.entries;
  }

  async listEntries(
    input: DocsProviderListEntriesInput
  ): Promise<DocsSourceEntry[]> {
    const allowedCollections = new Set<DocsCollection>(input.collections);
    return this.entries
      .map((entry) => this.rawEntryToSourceEntry(entry))
      .filter((entry) => allowedCollections.has(entry.collection));
  }

  async loadEntry(input: DocsProviderLoadEntryInput): Promise<DocsSourceEntry> {
    return input.entry;
  }

  private rawEntryToSourceEntry(entry: RawContentEntry): DocsSourceEntry {
    const collection =
      entry.kind === "api"
        ? "api"
        : entry.kind === "post"
          ? "blog"
          : entry.kind === "asset"
            ? "assets"
            : "docs";
    const relativePath = entry.id;

    return {
      id: createSourceEntryId(collection, relativePath),
      collection,
      relativePath,
      absolutePath: entry.filepath,
      entryType: entry.kind === "asset" ? "asset" : "content",
      frontmatter: entry.frontmatter,
      body: entry.body,
      bytes: Buffer.byteLength(entry.body ?? "", "utf8"),
    };
  }
}

/**
 * Create a mock doc page entry
 */
export function createMockDocEntry(
  overrides: Partial<RawContentEntry> = {}
): RawContentEntry {
  return {
    id: "test-doc.md",
    kind: "page",
    body: "# Test Doc\n\n## Section 1\n\nContent here.",
    frontmatter: {
      title: "Test Document",
      description: "A test document",
    },
    ...overrides,
  };
}

/**
 * Create a mock blog post entry
 */
export function createMockPostEntry(
  overrides: Partial<RawContentEntry> = {}
): RawContentEntry {
  return {
    id: "test-post.md",
    kind: "post",
    body: "# Test Post\n\nBlog content.",
    frontmatter: {
      title: "Test Post",
      date: "2026-01-18",
      tags: ["testing", "docs"],
      author: "Test Author",
    },
    ...overrides,
  };
}

/**
 * Create a mock API reference entry
 */
export function createMockApiEntry(
  overrides: Partial<RawContentEntry> = {}
): RawContentEntry {
  return {
    id: "test-api.json",
    kind: "api",
    body: JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {},
    }),
    frontmatter: {
      title: "Test API Reference",
    },
    ...overrides,
  };
}

/**
 * Validate that a DocPage has the required fields
 */
export function assertValidDocPage(page: unknown): asserts page is DocPage {
  if (typeof page !== "object" || page === null) {
    throw new Error("Invalid page: not an object");
  }

  const p = page as Partial<DocPage>;

  if (p.kind !== "page") throw new Error(`Invalid kind: ${p.kind}`);
  if (typeof p.id !== "string") throw new Error("Missing id");
  if (typeof p.slug !== "string") throw new Error("Missing slug");
  if (typeof p.path !== "string") throw new Error("Missing path");
  if (typeof p.title !== "string") throw new Error("Missing title");
  if (typeof p.body !== "string") throw new Error("Missing body");
  if (!Array.isArray(p.headings)) throw new Error("Missing headings array");
}

/**
 * Validate that a BlogPost has the required fields
 */
export function assertValidBlogPost(post: unknown): asserts post is BlogPost {
  if (typeof post !== "object" || post === null) {
    throw new Error("Invalid post: not an object");
  }

  const p = post as Partial<BlogPost>;

  if (p.kind !== "post") throw new Error(`Invalid kind: ${p.kind}`);
  if (typeof p.id !== "string") throw new Error("Missing id");
  if (typeof p.slug !== "string") throw new Error("Missing slug");
  if (typeof p.path !== "string") throw new Error("Missing path");
  if (typeof p.title !== "string") throw new Error("Missing title");
  if (typeof p.date !== "string") throw new Error("Missing date");
  if (!Array.isArray(p.tags)) throw new Error("Missing tags array");
}

/**
 * Validate that an ApiReference has the required fields
 */
export function assertValidApiReference(
  api: unknown
): asserts api is ApiReference {
  if (typeof api !== "object" || api === null) {
    throw new Error("Invalid api: not an object");
  }

  const a = api as Partial<ApiReference>;

  if (a.kind !== "api") throw new Error(`Invalid kind: ${a.kind}`);
  if (typeof a.id !== "string") throw new Error("Missing id");
  if (typeof a.slug !== "string") throw new Error("Missing slug");
  if (typeof a.path !== "string") throw new Error("Missing path");
  if (typeof a.title !== "string") throw new Error("Missing title");
  if (typeof a.spec !== "object") throw new Error("Missing spec object");
}
