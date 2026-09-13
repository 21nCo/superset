import { createHash } from "node:crypto";

export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "superseded";
export type CoverageStatus = "complete" | "incomplete";
export type Verdict = "ready" | "changes_requested" | "needs_verification";
export type AssessmentStatus = "implemented" | "partial" | "missing" | "unverified" | "not_applicable";

export interface SourceReference { sourceId: string; url?: string; anchor: string; excerpt?: string }
export interface SourceRecord { id: string; type: "issue" | "comment" | "document" | "repository"; title: string; body?: string; canonicalUrl?: string; digest: string; retrievedAt: string; status: "available" | "missing" | "denied" | "truncated" | "failed"; error?: string }
export interface ChangeSnapshot { repository: string; base: string; head: string; mergeBase: string; diffDigest: string }
export interface Requirement { id: string; statement: string; category: string; mandatory: boolean; sources: SourceReference[]; ambiguity?: string }
export interface EvidenceReference { id: string; kind: "code" | "test" | "source" | "search"; commit?: string; path?: string; line?: number; detail: string }
export interface Assessment { requirementId: string; status: AssessmentStatus; evidence: string[]; summary: string; confidence: number; gap?: string; exclusion?: SourceReference }
export interface Finding { fingerprint: string; severity: "critical" | "high" | "medium" | "low"; title: string; trigger: string; impact: string; evidence: string[]; requirementIds: string[] }
export interface RunEvent { sequence: number; at: string; type: "status" | "message" | "tool" | "error"; stage: string; detail: string; redacted?: boolean }
export interface TestReceipt { id: string; command: string; commit: string; cwd: string; startedAt: string; finishedAt: string; exitCode: number | null; signal: string | null; outputDigest: string; limitation?: string }
export interface RunIdentity { id: string; attemptId: string; policyDigest: string; contextDigest: string; harness: string; provider: string; model: string; budget: Record<string, number> }
export interface ReviewReport { schemaVersion: "1"; run: RunIdentity; change: ChangeSnapshot; execution: ExecutionStatus; coverage: CoverageStatus; coverageGaps: string[]; verdict?: Verdict; sources: SourceRecord[]; requirements: Requirement[]; evidence: EvidenceReference[]; assessments: Assessment[]; findings: Finding[]; tests: TestReceipt[]; events: RunEvent[]; createdAt: string }

export interface HarnessCapabilities { providers: string[]; auth: string[]; structuredOutput: boolean; cancellation: boolean; events: boolean }
export interface HarnessRequest { prompt: string; cwd: string; signal?: AbortSignal }
export interface HarnessResult { terminal: "completed" | "failed" | "canceled"; output?: unknown; events: RunEvent[]; error?: string }
export interface HarnessAdapter { readonly name: string; readonly version: string; capabilities(): Promise<HarnessCapabilities>; run(request: HarnessRequest): Promise<HarnessResult> }

export function digest(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}` }
export function stableFingerprint(value: unknown): string { return digest(JSON.stringify(value)).slice(7, 23) }

export function preflightHarness(capabilities: HarnessCapabilities, requested: { provider: string; auth: string }): string[] {
  const errors: string[] = [];
  if (!capabilities.providers.includes(requested.provider)) errors.push(`unsupported provider: ${requested.provider}`);
  if (!capabilities.auth.includes(requested.auth)) errors.push(`unsupported auth: ${requested.auth}`);
  if (!capabilities.structuredOutput) errors.push("harness does not support structured output");
  if (!capabilities.cancellation) errors.push("harness does not support cancellation");
  return errors;
}

export function validateReport(report: ReviewReport): string[] {
  const errors: string[] = [];
  const requirementIds = new Set(report.requirements.map((item) => item.id));
  const evidenceIds = new Set(report.evidence.map((item) => item.id));
  const counts = new Map<string, number>();
  for (const assessment of report.assessments) {
    counts.set(assessment.requirementId, (counts.get(assessment.requirementId) ?? 0) + 1);
    if (!requirementIds.has(assessment.requirementId)) errors.push(`assessment references unknown requirement ${assessment.requirementId}`);
    if (assessment.confidence < 0 || assessment.confidence > 1) errors.push(`invalid confidence for ${assessment.requirementId}`);
    for (const id of assessment.evidence) if (!evidenceIds.has(id)) errors.push(`assessment references unknown evidence ${id}`);
    if (assessment.status === "not_applicable" && !assessment.exclusion) errors.push(`${assessment.requirementId} requires an exclusion source`);
    if ((assessment.status === "missing" || assessment.status === "unverified") && !assessment.gap) errors.push(`${assessment.requirementId} requires an evidence gap`);
  }
  for (const requirement of report.requirements) if (counts.get(requirement.id) !== 1) errors.push(`${requirement.id} must have exactly one assessment`);
  for (const evidence of report.evidence) if (evidence.kind === "code" && evidence.commit !== report.change.head) errors.push(`${evidence.id} is not anchored to reviewed head`);
  for (const finding of report.findings) {
    for (const id of finding.evidence) if (!evidenceIds.has(id)) errors.push(`finding references unknown evidence ${id}`);
    for (const id of finding.requirementIds) if (!requirementIds.has(id)) errors.push(`finding references unknown requirement ${id}`);
  }
  const mandatoryGap = report.assessments.some((a) => report.requirements.find((r) => r.id === a.requirementId)?.mandatory && a.status !== "implemented" && a.status !== "not_applicable");
  if (report.verdict === "ready" && (report.execution !== "completed" || report.coverage !== "complete" || mandatoryGap || errors.length > 0)) errors.push("ready verdict is not eligible");
  if (report.execution !== "completed" && report.verdict) errors.push("failed, canceled, queued, running, or superseded runs cannot have a verdict");
  if (report.coverage === "incomplete" && report.coverageGaps.length === 0) errors.push("incomplete coverage requires reasons");
  return [...new Set(errors)];
}

export function deriveVerdict(report: Omit<ReviewReport, "verdict">): Verdict | undefined {
  if (report.execution !== "completed") return undefined;
  if (report.coverage === "incomplete") return "needs_verification";
  const mandatoryGap = report.assessments.some((a) => report.requirements.find((r) => r.id === a.requirementId)?.mandatory && a.status !== "implemented" && a.status !== "not_applicable");
  if (mandatoryGap || report.findings.some((f) => f.severity === "critical" || f.severity === "high")) return "changes_requested";
  if (report.assessments.some((a) => a.status === "unverified")) return "needs_verification";
  return "ready";
}

export function renderMarkdown(report: ReviewReport): string {
  const lines = [`# ReviewFn`, ``, `Reviewed \`${report.change.head}\` · **${report.verdict ?? report.execution}** · coverage **${report.coverage}**`, ``];
  if (report.coverageGaps.length) lines.push(`## Incomplete scope`, ...report.coverageGaps.map((gap) => `- ${gap}`), ``);
  lines.push(`## Requirements`, ``, `| Requirement | Assessment | Evidence |`, `| --- | --- | --- |`);
  for (const requirement of report.requirements) {
    const assessment = report.assessments.find((item) => item.requirementId === requirement.id)!;
    lines.push(`| ${requirement.statement.replaceAll("|", "\\|")} | ${assessment.status} | ${assessment.evidence.join(", ") || assessment.gap || "none"} |`);
  }
  lines.push(``, `## Validation`, ...report.tests.map((test) => `- \`${test.command}\`: ${test.exitCode === 0 ? "passed" : "not passed"} (${test.outputDigest})`));
  return `${lines.join("\n")}\n`;
}
