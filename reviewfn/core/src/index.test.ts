import { describe, expect, it } from "vitest";
import { deriveVerdict, validateReport, type ReviewReport } from "./index.js";

const base = (): ReviewReport => ({ schemaVersion: "1", run: { id: "r", attemptId: "a", policyDigest: "p", contextDigest: "c", harness: "fixture", provider: "fixture", model: "fixture", budget: {} }, change: { repository: "x", base: "b", head: "h", mergeBase: "b", diffDigest: "d" }, execution: "completed", coverage: "complete", coverageGaps: [], verdict: "ready", sources: [], requirements: [{ id: "R1", statement: "works", category: "behavior", mandatory: true, sources: [{ sourceId: "s", anchor: "L1" }] }], evidence: [{ id: "E1", kind: "code", commit: "h", path: "a.ts", detail: "implementation" }], assessments: [{ requirementId: "R1", status: "implemented", evidence: ["E1"], summary: "implemented", confidence: 1 }], findings: [], tests: [], events: [], createdAt: new Date(0).toISOString() });

describe("report validation", () => {
  it("accepts an evidence-backed ready report", () => expect(validateReport(base())).toEqual([]));
  it("rejects ready when mandatory evidence is missing", () => { const report = base(); report.assessments[0] = { requirementId: "R1", status: "missing", evidence: [], summary: "absent", confidence: .9, gap: "bounded search found no implementation" }; expect(validateReport(report)).toContain("ready verdict is not eligible"); });
  it("keeps incomplete execution separate from verdict", () => { const report = base(); report.coverage = "incomplete"; report.coverageGaps = ["issue unavailable"]; delete report.verdict; expect(deriveVerdict(report)).toBe("needs_verification"); });
  it("requires an authorized exclusion", () => { const report = base(); report.assessments[0] = { requirementId: "R1", status: "not_applicable", evidence: [], summary: "excluded", confidence: 1 }; delete report.verdict; expect(validateReport(report)).toContain("R1 requires an exclusion source"); });
});
