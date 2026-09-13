import { describe, expect, it } from "vitest";
import { authoritativeGfmCorpus, deterministicFuzzCorpus, compareSemanticTraces, representativeCorpus, runPreservationCorpus, runSecurityCorpus, runSemanticCorpus, traceState } from "./index";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector, parseMarkdown, serializeMarkdown } from "@mdfn/markdown";
import { renderHtml } from "@mdfn/render";
import { tests as commonmarkSpecTests } from "commonmark-spec";

/** End-to-end parse → serialize → render on the large-document fixture below. */
const LARGE_DOCUMENT_DEVELOPMENT_BUDGET_MS = 5_000;
/**
 * GHA shared runners are much slower than local dev; keep a separate CI ceiling.
 * Full-graph turbo CI (PR 133, ~310 tasks) observed ~12.1s here; scoped runs stay ~12s.
 */
const LARGE_DOCUMENT_CI_BUDGET_MS = 20_000;
const largeDocumentBudgetMs = process.env.CI ? LARGE_DOCUMENT_CI_BUDGET_MS : LARGE_DOCUMENT_DEVELOPMENT_BUDGET_MS;

describe("@mdfn/testing", () => {
  it("passes the representative no-edit corpus", () => {
    const result = runPreservationCorpus(representativeCorpus);
    expect(result).toMatchObject({ ok: true, failed: 0, passed: representativeCorpus.length });
  });

  it("detects executable render output and adapter divergence", () => {
    const safe = runSecurityCorpus({ type: "doc", schemaVersion: 1, content: [{ type: "opaque", attrs: { syntax: "html" }, text: "<script>bad()</script>" }] });
    expect(safe.ok).toBe(true);
    const reference = { schemaVersion: 1 as const, framework: "vanilla" as const, fixture: "basic", steps: [], finalMarkdown: "a", finalSelection: null, diagnostics: [], cleanup: { subscriptions: 0, mounted: false } };
    const result = compareSemanticTraces(reference, [{ ...reference, framework: "react", finalMarkdown: "b" }]);
    expect(result.ok).toBe(false);
    expect(compareSemanticTraces(reference, [{ ...reference, framework: "react", cleanup: { subscriptions: 1, mounted: true } }]).ok).toBe(false);
  });

  it("records selection and diagnostics in intermediate trace steps", () => {
    const controller = createEditor({ markdown: "[bad](javascript:alert(1))", projector: createMarkdownProjector() });
    const states = [controller.getState()];
    controller.dispatch(new Transaction().setSelection({ kind: "text", anchor: 1, head: 2 }));
    states.push(controller.getState());
    const trace = traceState("vanilla", "intermediate", states);
    expect(trace.steps[1].state).toMatchObject({
      selection: { kind: "text", anchor: 1, head: 2 },
      diagnostics: expect.arrayContaining(["MDFN_UNSAFE_URL"]),
    });
  });

  it("passes a reproducible malformed and Unicode fuzz corpus", () => {
    const corpus = deterministicFuzzCorpus(0x53464e20, 128);
    expect(runPreservationCorpus(corpus)).toMatchObject({ ok: true, passed: 128, failed: 0 });
  });

  it("parses and byte-preserves every official CommonMark 0.31.2 example", () => {
    const corpus = commonmarkSpecTests.map((example) => ({ id: `commonmark-${example.number}-${example.section}`, source: example.markdown, options: { dialect: "commonmark" as const } }));
    expect(corpus.length).toBeGreaterThan(600);
    expect(runPreservationCorpus(corpus)).toMatchObject({ ok: true, passed: corpus.length, failed: 0 });
  });

  it("matches the official CommonMark semantic output", () => {
    const corpus = commonmarkSpecTests.map((example) => ({ id: `commonmark-${example.number}-${example.section}`, source: example.markdown.replaceAll("→", "\t"), expectedHtml: example.html.replaceAll("→", "\t"), options: { dialect: "commonmark" as const, allowRawHtml: true } }));
    expect(runSemanticCorpus(corpus)).toMatchObject({ ok: true, passed: corpus.length, failed: 0 });
  });

  it("matches the authoritative GFM extension corpus", () => {
    expect(runSemanticCorpus(authoritativeGfmCorpus)).toMatchObject({ ok: true, passed: authoritativeGfmCorpus.length, failed: 0 });
  });

  it("stays within the documented large-document development budget", () => {
    const source = `${"## Heading\n\nParagraph with **bold**, [link](https://example.com), and 日本語.\n\n".repeat(3_200)}`;
    const started = performance.now();
    const parsed = parseMarkdown(source);
    const serialized = serializeMarkdown({ document: parsed.document, originalSource: source });
    const rendered = renderHtml(parsed.document);
    const elapsed = performance.now() - started;
    expect(source.length).toBeGreaterThan(200_000);
    expect(serialized.markdown).toBe(source);
    expect(rendered.html.length).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(largeDocumentBudgetMs);
  }, 30_000);
});
