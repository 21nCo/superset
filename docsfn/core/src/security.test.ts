import { describe, expect, it } from "vitest";
import {
  assertCompiledContentTrusted,
  assertDocsRouteAccess,
  assertSourceEntriesTrusted,
  isDocsContentProtected,
  redactSensitivePayload,
  resolveDocsAuthMode,
} from "./security";
import { findUnsafeHtml } from "./sanitize";
import type { DocsSourceEntry } from "./provider";

function createEntry(overrides: Partial<DocsSourceEntry> = {}): DocsSourceEntry {
  return {
    id: "docs:index.mdx",
    collection: "docs",
    relativePath: "index.mdx",
    entryType: "content",
    frontmatter: {},
    body: "# Hello",
    ...overrides,
  };
}

describe("security", () => {
  it("blocks unsafe html in source entries by default (TV-SEC-001)", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [
          createEntry({
            id: "docs:private.mdx",
            relativePath: "private.mdx",
            body: "# Unsafe\n\n<script>alert(1)</script>",
          }),
        ],
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("allows explicit unsafe-html allowlist matches", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [
          createEntry({
            id: "docs:legacy/unsafe.mdx",
            relativePath: "legacy/unsafe.mdx",
            body: "# Legacy\n\n<script>alert(1)</script>",
          }),
        ],
        policy: {
          allowUnsafeHtmlAllowlist: ["docs:legacy/unsafe.mdx"],
        },
      })
    ).not.toThrow();
  });

  it("blocks unsafe html in named dated collections", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [
          createEntry({
            id: "collection:changelog:release.mdx",
            collection: "collection:changelog",
            relativePath: "release.mdx",
            body: "# Release\n\n<script>alert(1)</script>",
          }),
        ],
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("ignores unsafe-looking html when it appears inside fenced code samples", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [
          createEntry({
            id: "docs:guide/code-sample.mdx",
            relativePath: "guide/code-sample.mdx",
            body: [
              "# Guide",
              "",
              "```html",
              "<script>alert(1)</script>",
              "```",
              "",
              "Use `onClick=` only inside examples.",
            ].join("\n"),
          }),
        ],
      })
    ).not.toThrow();
  });

  it("blocks entity-obfuscated javascript URLs in raw HTML", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [createEntry({ body: '<a href="j&#x61;vascript:alert(1)">open</a>' })],
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("does not treat fence markers inside raw HTML as code examples", () => {
    expect(() =>
      assertSourceEntriesTrusted({
        entries: [
          createEntry({ body: "<div>\n```\n<script>alert(1)</script>\n```\n</div>" }),
        ],
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("applies the same trust model for compiled content artifacts", () => {
    expect(() =>
      assertCompiledContentTrusted({
        source: "# Unsafe\n\n<script>alert(1)</script>",
        sourcePath: "content/docs/unsafe.mdx",
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("resolves canonical auth mode defaults", () => {
    expect(resolveDocsAuthMode({ auth: undefined })).toBe("public");
    expect(resolveDocsAuthMode({ auth: { enabled: true, mode: "private" } })).toBe(
      "private"
    );
    expect(resolveDocsAuthMode({ auth: { enabled: true, mode: "mixed" } })).toBe(
      "mixed"
    );
  });

  it("fails private routes with DOCS_AUTH_REQUIRED when no session is provided (TV-SEC-001)", async () => {
    await expect(
      assertDocsRouteAccess({
        config: {
          auth: {
            enabled: true,
            mode: "private",
          },
        },
        route: "/docs/private",
        session: null,
      })
    ).rejects.toThrowError(/DOCS_AUTH_REQUIRED|authentication is required/);
  });

  it("fails private routes with DOCS_AUTH_FORBIDDEN when authorization denies", async () => {
    await expect(
      assertDocsRouteAccess({
        config: {
          auth: {
            enabled: true,
            mode: "private",
          },
        },
        route: "/docs/private",
        session: { userId: "u_1" },
        authorize: () => false,
      })
    ).rejects.toThrowError(/DOCS_AUTH_FORBIDDEN|forbidden/);
  });

  it("treats mixed mode as private by default when route classifier is missing (fail-closed)", async () => {
    await expect(
      assertDocsRouteAccess({
        config: {
          auth: {
            enabled: true,
            mode: "mixed",
          },
        },
        route: "/docs/public",
        session: null,
      })
    ).rejects.toThrowError(/DOCS_AUTH_REQUIRED|authentication is required/);
  });

  it("allows mixed mode public routes when classifier returns false", async () => {
    await expect(
      assertDocsRouteAccess({
        config: {
          auth: {
            enabled: true,
            mode: "mixed",
          },
        },
        route: "/docs/public",
        session: null,
        isRoutePrivate: () => false,
      })
    ).resolves.toMatchObject({
      allowed: true,
      requiresAuth: false,
      mode: "mixed",
    });
  });

  it("redacts sensitive payload values and keys", () => {
    const redacted = redactSensitivePayload({
      route: "/docs",
      authorization: "Bearer abc.def.ghi",
      nested: {
        token: "sk_test_12345",
        regular: "safe-value",
      },
    });

    expect(redacted).toEqual({
      route: "/docs",
      authorization: "[REDACTED]",
      nested: {
        token: "[REDACTED]",
        regular: "safe-value",
      },
    });
  });

  it("treats mixed-mode private frontmatter and routes as protected", () => {
    const auth = { enabled: true as const, mode: "mixed" as const };
    expect(
      isDocsContentProtected({
        auth,
        frontmatter: { auth: "private" },
        route: "/docs/guide",
      })
    ).toBe(true);
    expect(
      isDocsContentProtected({
        auth,
        frontmatter: {},
        route: "/docs/private/guide",
      })
    ).toBe(true);
    expect(
      isDocsContentProtected({
        auth,
        frontmatter: {},
        route: "/docs/guide",
      })
    ).toBe(false);
  });

  it("blocks browser-permissive tags and keeps encoded literals as text", () => {
    expect(findUnsafeHtml("# Unsafe\n\n<script/src=x>")).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "blocked-tag:script" })])
    );
    expect(findUnsafeHtml("Use &lt;script&gt; in examples.")).toEqual([]);
    expect(findUnsafeHtml("# JavaScript: A Guide\n\nthe onclick= attribute is deprecated")).toEqual([]);
    expect(findUnsafeHtml("    <script>alert(1)</script>")).toEqual([]);
    expect(findUnsafeHtml(">     <script>alert(1)</script>")).toEqual([]);
    expect(findUnsafeHtml("- ```html\n  <script>alert(1)</script>\n  ```")).toEqual([]);
    expect(findUnsafeHtml("-     <script>alert(1)</script>")).toEqual([]);
    expect(findUnsafeHtml("- <script>alert(1)</script>")).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "blocked-tag:script" })])
    );
    expect(findUnsafeHtml("`<script>\nexample`")).toEqual([]);
  });
});

// Browsers accept slash-delimited attributes and strip ASCII URL whitespace.
it.each(['| X |\n| --- |\n| <svg/onload=alert(1)> |', '<a href="java&#x09;script:alert(1)">click</a>', '<a href="java&#10;script:alert(1)">click</a>'])("rejects browser executable HTML: %s", (source) => {
  expect(() => assertCompiledContentTrusted({ source })).toThrow();
});

it.each(['<!-->', '<!--->', '<!-- comment --!>'])('rejects executable attributes after browser-terminated comments: %s', prefix => {
  expect(() => assertCompiledContentTrusted({ source: `${prefix}<img src=x onerror=alert(1)>` })).toThrow();
  expect(() => assertCompiledContentTrusted({ source: `${prefix}<a href="javascript:alert(1)">go</a>` })).toThrow();
});
