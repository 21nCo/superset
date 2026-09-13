import { describe, expect, it } from "vitest";
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  buildLlmsTxtArtifacts,
  type BuildLlmsFullTxtOptions,
} from "./llms";
import type { DocsManifest } from "./types";

function createManifest(overrides: Partial<DocsManifest> = {}): DocsManifest {
  return {
    site: { title: "Site Title", description: "Site description" },
    pages: {
      "docs/getting-started": {
        kind: "page",
        id: "docs/getting-started",
        slug: "getting-started",
        path: "/docs/getting-started",
        title: "Getting Started",
        description: "Install and run the demo",
        body: "## Install\nDo X.",
        headings: [],
        frontmatter: { description: "Install and run the demo" },
      },
      "docs/concepts/architecture": {
        kind: "page",
        id: "docs/concepts/architecture",
        slug: "concepts/architecture",
        path: "/docs/concepts/architecture",
        title: "Architecture",
        body: "Body of architecture page.",
        headings: [],
        frontmatter: {},
      },
    },
    posts: {},
    apis: {},
    sidebars: {},
    routes: {},
    ...overrides,
  };
}

describe("buildLlmsTxt", () => {
  it("builds a short index", () => {
    const manifest = createManifest();
    const text = buildLlmsTxt(manifest, { canonicalUrl: "https://docs.example.com" });
    expect(text).toContain("# Site Title");
    expect(text).toContain("> Site description");
    expect(text).toContain("- [Getting Started](https://docs.example.com/docs/getting-started)");
    expect(text).toContain(
      "- [Architecture](https://docs.example.com/docs/concepts/architecture) — Architecture"
    );
  });

  it("respects includePages globs", () => {
    const manifest = createManifest();
    const text = buildLlmsTxt(manifest, { includePages: ["docs/concepts/**"] });
    expect(text).toContain("Architecture");
    expect(text).not.toContain("Getting Started");
  });

  it("respects excludePages globs", () => {
    const manifest = createManifest();
    const text = buildLlmsTxt(manifest, { excludePages: ["docs/getting-started"] });
    expect(text).not.toContain("Getting Started");
    expect(text).toContain("Architecture");
  });

  it("appends OpenAPI summaries", () => {
    const manifest = createManifest({
      apis: {
        "api/example": {
          kind: "api",
          id: "api/example",
          slug: "example",
          path: "/docs/api",
          title: "Example API",
          frontmatter: {},
          spec: {
            spec: {
              paths: {
                "/things": {
                  servers: [{ url: "https://example.com" }],
                  "x-extension": { summary: "Not an operation" },
                  get: { summary: "List things" },
                  post: { summary: "Create thing" },
                },
              },
            },
          },
        },
      },
    });
    const text = buildLlmsTxt(manifest);
    expect(text).toContain("## API Reference");
    expect(text).toContain("- GET /things — List things");
    expect(text).toContain("- POST /things — Create thing");
    expect(text).not.toContain("SERVERS /things");
    expect(text).not.toContain("X-EXTENSION /things");
    expect(buildLlmsFullTxt(manifest)).not.toContain("SERVERS /things");
  });

  it("omits blog when includeBlog is false", () => {
    const manifest = createManifest({
      posts: {
        "post/first": {
          kind: "post",
          id: "post/first",
          slug: "first",
          path: "/blog/first",
          title: "First post",
          date: "2025-01-01",
          summary: "Hello world",
          tags: [],
          body: "post body",
          frontmatter: {},
        },
      },
    });
    expect(buildLlmsTxt(manifest, { includeBlog: false })).not.toContain("## Blog");
    expect(buildLlmsTxt(manifest, { includeBlog: true })).toContain("First post");
  });
});

describe("buildLlmsFullTxt", () => {
  it("concatenates page bodies", () => {
    const manifest = createManifest();
    const text = buildLlmsFullTxt(manifest);
    expect(text).toContain("# Getting Started");
    expect(text).toContain("Do X.");
    expect(text).toContain("Body of architecture page.");
  });

  it("embeds OpenAPI spec when requested", () => {
    const manifest = createManifest({
      apis: {
        "api/example": {
          kind: "api",
          id: "api/example",
          slug: "example",
          path: "/docs/api",
          title: "Example API",
          frontmatter: {},
          spec: { spec: { paths: { "/things": { get: { summary: "List things" } } } } },
        },
      },
    });

    const options: BuildLlmsFullTxtOptions = { embedOpenApiSpec: true };
    const text = buildLlmsFullTxt(manifest, options);
    expect(text).toContain("```json");
    expect(text).toContain('"/things"');
  });
});

describe("buildLlmsTxtArtifacts", () => {
  it("returns both files", () => {
    const manifest = createManifest();
    const artifacts = buildLlmsTxtArtifacts(manifest);
    expect(artifacts.llmsTxt).toContain("# Site Title");
    expect(artifacts.llmsFullTxt).toContain("# Getting Started");
  });

  it("omits private pages from public LLM artifacts", () => {
    const manifest = createManifest({
      pages: {
        "docs/public": {
          kind: "page",
          id: "docs/public",
          slug: "public",
          path: "/docs/public",
          title: "Public",
          body: "public body",
          headings: [],
          frontmatter: {},
        },
        "docs/secret": {
          kind: "page",
          id: "docs/secret",
          slug: "secret",
          path: "/docs/secret",
          title: "Secret",
          body: "secret body",
          headings: [],
          frontmatter: { private: true },
        },
      },
    });
    const artifacts = buildLlmsTxtArtifacts(manifest, {
      auth: { enabled: true, mode: "mixed" },
    });
    expect(artifacts.llmsTxt).toContain("Public");
    expect(artifacts.llmsTxt).not.toContain("Secret");
    expect(artifacts.llmsFullTxt).not.toContain("secret body");
  });
});

it("matches recursive source globs with canonical provider IDs", () => {
  const manifest = createManifest();
  const page = Object.values(manifest.pages)[0];
  page.id = "docs:deep/nested/start.md";
  const txt = buildLlmsFullTxt(manifest, { includePages: ["docs/**/*.md"] });
  expect(txt).toContain(page.body);
  expect(txt).not.toContain(manifest.pages["docs/concepts/architecture"].body);
  expect(buildLlmsFullTxt(manifest, { includePages: ["docs/**/*.md"], excludePages: ["docs/deep/**"] })).not.toContain(page.body);
});
