import { describe, expect, it } from "vitest";
import { CONFORMANCE_FIXTURES, comparisonConfounds, evaluate } from "../src/index.js";

describe("evaluation", () => {
  it("reports every metric with denominators and includes failed runs", () => {
    const report = evaluate([
      { id: "a", sourceSnapshotDigest: "s", changeSnapshotDigest: "c", adjudicatedRequirementIds: ["R1", "R2"], knownGapRequirementIds: ["R2"], validFindingFingerprints: ["F1"], acceptable: false, retrospective: false, limitations: [] },
      { id: "b", sourceSnapshotDigest: "s2", changeSnapshotDigest: "c2", adjudicatedRequirementIds: ["R3"], knownGapRequirementIds: [], validFindingFingerprints: [], acceptable: true, retrospective: true, limitations: [] },
    ], [{ caseId: "a", completed: true, extractedRequirementIds: ["R1"], identifiedGapRequirementIds: ["R2"], findingFingerprints: ["F1", "bad"], blocked: true, evidenceReferences: 2, validEvidenceReferences: 1 }]);
    expect(report.requirementExtractionRecall).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(report.findingPrecision.value).toBe(0.5);
    expect(report.completionRate.denominator).toBe(2);
    expect(report.limitations.some((item) => item.includes("retrospective"))).toBe(true);
  });
  it("names comparison confounds", () => {
    const common = { harness: "codex", harnessVersion: "1", provider: "openai", model: "a", promptDigest: "p", contextDigest: "c", budgetDigest: "b" };
    expect(comparisonConfounds(common, { ...common, model: "b", contextDigest: "d" })).toEqual(["model", "contextDigest"]);
  });
});

describe("fixture matrix", () => {
  it("covers every required failure and portability category with unique ids", () => {
    expect(new Set(CONFORMANCE_FIXTURES.map((fixture) => fixture.id)).size).toBe(CONFORMANCE_FIXTURES.length);
    expect(new Set(CONFORMANCE_FIXTURES.map((fixture) => fixture.category))).toEqual(new Set(["context", "requirements", "code", "tests", "harness", "security", "publishing", "operations", "portability"]));
    expect(CONFORMANCE_FIXTURES.length).toBeGreaterThanOrEqual(50);
  });
});
