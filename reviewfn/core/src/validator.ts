import type { Assessment, Evidence, ReportPublisher, ReviewPolicy, ReviewReport, SourceControlAdapter, Verdict } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  verdict?: Verdict;
  coverage: "complete" | "incomplete";
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) seen.has(value) ? repeated.add(value) : seen.add(value);
  return [...repeated];
}

export function deriveVerdict(report: Pick<ReviewReport, "execution" | "coverage" | "requirements" | "assessments" | "findings">, policy: ReviewPolicy): Verdict | undefined {
  if (report.execution !== "completed") return undefined;
  if (report.coverage !== "complete") return "needs_verification";
  const mandatory = new Set(report.requirements.filter((requirement) => requirement.classification === "mandatory").map((requirement) => requirement.id));
  if (report.assessments.some((assessment) => mandatory.has(assessment.requirementId) && ["missing", "partial"].includes(assessment.status))) return "changes_requested";
  if (report.assessments.some((assessment) => mandatory.has(assessment.requirementId) && assessment.status === "unverified")) return "needs_verification";
  if (report.findings.some((finding) => policy.blockingSeverities.includes(finding.severity) && ["new", "still_valid"].includes(finding.lifecycle))) return "changes_requested";
  return "ready";
}

export async function validateReport(report: ReviewReport, policy: ReviewPolicy, sourceControl?: SourceControlAdapter, root?: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requirementIds = report.requirements.map((item) => item.id);
  const evidenceIds = report.evidence.map((item) => item.id);
  for (const id of duplicates(requirementIds)) errors.push(`Duplicate requirement id ${id}.`);
  for (const id of duplicates(evidenceIds)) errors.push(`Duplicate evidence id ${id}.`);

  const assessments = new Map<string, Assessment[]>();
  for (const assessment of report.assessments) assessments.set(assessment.requirementId, [...(assessments.get(assessment.requirementId) ?? []), assessment]);
  for (const requirement of report.requirements) {
    const matches = assessments.get(requirement.id) ?? [];
    if (matches.length !== 1) errors.push(`Requirement ${requirement.id} has ${matches.length} assessments; expected exactly one.`);
    if (requirement.sources.length === 0) errors.push(`Requirement ${requirement.id} has no authoritative source.`);
  }
  for (const requirementId of assessments.keys()) if (!requirementIds.includes(requirementId)) errors.push(`Assessment references unknown requirement ${requirementId}.`);

  const evidence = new Map<string, Evidence>(report.evidence.map((item) => [item.id, item]));
  for (const assessment of report.assessments) {
    if (assessment.confidence < 0 || assessment.confidence > 1) errors.push(`Assessment ${assessment.requirementId} has invalid confidence.`);
    if (assessment.status !== "not_applicable" && assessment.evidenceIds.length === 0) errors.push(`Assessment ${assessment.requirementId} has no evidence.`);
    if (assessment.status === "not_applicable" && !assessment.waiverReference) errors.push(`Assessment ${assessment.requirementId} is not_applicable without a waiver.`);
    for (const id of assessment.evidenceIds) if (!evidence.has(id)) errors.push(`Assessment ${assessment.requirementId} references unknown evidence ${id}.`);
  }
  for (const finding of report.findings) {
    if (!finding.trigger || !finding.impact || !finding.direction) errors.push(`Finding ${finding.fingerprint} is missing actionable detail.`);
    for (const id of finding.evidenceIds) if (!evidence.has(id)) errors.push(`Finding ${finding.fingerprint} references unknown evidence ${id}.`);
    for (const id of finding.requirementIds) if (!requirementIds.includes(id)) errors.push(`Finding ${finding.fingerprint} references unknown requirement ${id}.`);
  }

  if (sourceControl && root) {
    for (const item of report.evidence) {
      if (item.code && item.code.commit !== report.change.headCommit) errors.push(`Evidence ${item.id} does not reference reviewed head ${report.change.headCommit}.`);
      if (item.code && !(await sourceControl.verifyAnchor(root, item.code))) errors.push(`Evidence ${item.id} has an invalid code anchor.`);
    }
    for (const finding of report.findings) {
      if (finding.anchor && finding.anchor.commit !== report.change.headCommit) errors.push(`Finding ${finding.fingerprint} does not reference reviewed head.`);
      if (finding.anchor && !(await sourceControl.verifyAnchor(root, finding.anchor))) errors.push(`Finding ${finding.fingerprint} has an invalid code anchor.`);
    }
  }

  if (report.execution !== "completed" && report.verdict !== undefined) errors.push("A non-completed run cannot have a verdict.");
  if (report.coverage === "incomplete" && report.verdict === "ready") errors.push("Incomplete coverage cannot have a ready verdict.");
  if (report.coverage === "incomplete" && report.coverageReasons.length === 0) errors.push("Incomplete coverage requires at least one reason.");
  if (report.findings.length > policy.limits.maxFindings) errors.push(`Report exceeds maxFindings (${policy.limits.maxFindings}).`);
  const derived = deriveVerdict(report, policy);
  if (report.verdict !== derived) errors.push(`Verdict ${String(report.verdict)} does not match derived verdict ${String(derived)}.`);
  if (policy.mode === "advisory" && report.verdict === "ready") warnings.push("Ready is advisory and must not be presented as an authorized merge gate.");
  return { valid: errors.length === 0, errors, warnings, verdict: derived, coverage: errors.length === 0 ? report.coverage : "incomplete" };
}

export async function preflightPublishers(publishers: readonly ReportPublisher[]): Promise<string[]> {
  const errors: string[] = [];
  for (const publisher of publishers) {
    const result = await publisher.preflight();
    for (const diagnostic of result.diagnostics) if (diagnostic.level === "error") errors.push(`${publisher.id}: ${diagnostic.message}`);
  }
  return errors;
}
