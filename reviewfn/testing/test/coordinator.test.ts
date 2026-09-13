import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, ReviewCoordinator, type HarnessOutput } from "@superfunctions/reviewfn-core";
import { FakeContextAdapter, FakeExecutionAdapter, FakeHarnessAdapter, FakePublisher, FakeSourceControlAdapter, MemoryArtifactStore } from "../src/index.js";

const manifest = { version: 1 as const, sources: [{ id: "issue:1", type: "issue" as const, retrievedAt: "2026-01-01T00:00:00.000Z", digest: "d".repeat(64), status: "available" as const, content: "must return value" }], selection: { candidates: ["ISS-1"], selected: ["issue:1"], rule: "explicit" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 2 }, incompleteReasons: [] };
const output: HarnessOutput = {
  terminal: "completed",
  requirements: [{ id: "R1", statement: "Return value", sources: [{ sourceId: "issue:1", anchor: "body" }], category: "behavior", scope: "api", classification: "mandatory", dependencies: [], extraction: { harness: "fake", promptDigest: "prompt" } }],
  assessments: [{ requirementId: "R1", status: "implemented", evidenceIds: ["E1"], reasoning: "present", gaps: [], confidence: 1 }],
  evidence: [{ id: "E1", kind: "code", description: "value", code: { commit: "b".repeat(40), path: "src/value.ts", startLine: 1 } }],
  findings: [], inspectedPaths: ["src/value.ts"], uninspected: [], events: [],
};
const config = { ...DEFAULT_CONFIG, harness: { adapter: "fake", version: "1" }, inference: { provider: "fake", model: "fixture", auth: "none" }, context: [{ adapter: "fixture", issue: "ISS-1" }], execution: { ...DEFAULT_CONFIG.execution, adapter: "fake-execution" } };

describe("ReviewCoordinator", () => {
  it("publishes a validated exact-head report", async () => {
    const publisher = new FakePublisher();
    const coordinator = new ReviewCoordinator({ sourceControl: new FakeSourceControlAdapter(), contexts: [new FakeContextAdapter("fixture", manifest)], harness: new FakeHarnessAdapter(output), execution: new FakeExecutionAdapter(), artifacts: new MemoryArtifactStore(), publishers: [publisher] });
    const result = await coordinator.run({ root: ".", base: "base", head: "head", config, policy: DEFAULT_POLICY, issue: "ISS-1" });
    expect(result.report.verdict).toBe("ready");
    expect(result.report.contextManifestArtifact).toMatch(/^context-manifest-/);
    expect(result.publications[0].status).toBe("published");
    expect(publisher.requests).toHaveLength(1);
  });
  it("does not publish when head changed", async () => {
    const source = new FakeSourceControlAdapter(); source.current = "c".repeat(40);
    const publisher = new FakePublisher();
    const coordinator = new ReviewCoordinator({ sourceControl: source, contexts: [new FakeContextAdapter("fixture", manifest)], harness: new FakeHarnessAdapter(output), execution: new FakeExecutionAdapter(), artifacts: new MemoryArtifactStore(), publishers: [publisher] });
    const result = await coordinator.run({ root: ".", base: "base", head: "head", config, policy: DEFAULT_POLICY });
    expect(result.publications[0].status).toBe("stale");
    expect(publisher.requests).toHaveLength(0);
  });
  it("cannot turn quota exhaustion into a verdict", async () => {
    const failed = { ...output, terminal: "quota_exhausted" as const, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: "quota" }], error: "quota" };
    const coordinator = new ReviewCoordinator({ sourceControl: new FakeSourceControlAdapter(), contexts: [new FakeContextAdapter("fixture", manifest)], harness: new FakeHarnessAdapter(failed), execution: new FakeExecutionAdapter(), artifacts: new MemoryArtifactStore() });
    const result = await coordinator.run({ root: ".", base: "base", head: "head", config, policy: DEFAULT_POLICY });
    expect(result.report.execution).toBe("failed");
    expect(result.report.coverage).toBe("incomplete");
    expect(result.report.verdict).toBeUndefined();
  });
});
