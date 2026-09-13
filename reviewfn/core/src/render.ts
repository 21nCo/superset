import type { ReviewReport } from "./types.js";

function escapeCell(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }

export function renderMarkdownReport(report: ReviewReport): string {
  const verdict = report.verdict ?? "no valid assessment";
  const lines = [
    `# ReviewFn report`,
    "",
    `- Reviewed head: \`${report.change.headCommit}\``,
    `- Base: \`${report.change.baseCommit}\` (merge base \`${report.change.mergeBaseCommit}\`)`,
    `- Execution: **${report.execution}**`,
    `- Coverage: **${report.coverage}**`,
    `- Verdict: **${verdict}**${report.configuration.profile ? ` (${report.configuration.profile})` : ""}`,
    `- Harness: \`${report.configuration.harness.id}@${report.configuration.harness.version}\`; inference: \`${report.configuration.inference.provider}/${report.configuration.inference.model}\``,
    "",
  ];
  if (report.coverageReasons.length) lines.push("## Coverage limits", "", ...report.coverageReasons.map((reason) => `- ${reason}`), "");
  lines.push("## Requirements", "", "| Requirement | Source | Assessment | Evidence / gap |", "| --- | --- | --- | --- |");
  for (const requirement of report.requirements) {
    const assessment = report.assessments.find((item) => item.requirementId === requirement.id);
    const source = requirement.sources.map((item) => `${item.sourceId}#${item.anchor}`).join(", ");
    const detail = assessment ? [...assessment.evidenceIds, ...assessment.gaps.map((gap) => `gap: ${gap}`)].join("; ") : "missing assessment";
    lines.push(`| ${escapeCell(`${requirement.id}: ${requirement.statement}`)} | ${escapeCell(source)} | ${assessment?.status ?? "missing"} | ${escapeCell(detail)} |`);
  }
  lines.push("", "## Findings", "");
  if (!report.findings.length) lines.push("No findings were reported.");
  else for (const finding of report.findings) lines.push(`- **${finding.severity.toUpperCase()} — ${finding.title}**: ${finding.impact} (${finding.basis}; ${finding.lifecycle})`);
  lines.push("", "## Verification", "");
  if (!report.tests.length) lines.push("No tests were run.");
  else for (const receipt of report.tests) lines.push(`- \`${receipt.command.join(" ")}\`: ${receipt.exitCode === 0 && !receipt.timedOut && !receipt.canceled ? "passed" : "did not pass"} in ${receipt.runtimeMs} ms (receipt \`${receipt.id}\`)`);
  if (report.uninspected.length) lines.push("", "## Uninspected scope", "", ...report.uninspected.map((item) => `- ${item.scope}: ${item.reason}`));
  if (report.limitations.length) lines.push("", "## Limitations", "", ...report.limitations.map((item) => `- ${item}`));
  lines.push("", "_Advisory ReviewFn output; it cannot merge or push code._", "");
  return lines.join("\n");
}
