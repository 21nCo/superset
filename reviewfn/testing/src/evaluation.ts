export interface EvaluationCase {
  id: string;
  sourceSnapshotDigest: string;
  changeSnapshotDigest: string;
  adjudicatedRequirementIds: string[];
  knownGapRequirementIds: string[];
  validFindingFingerprints: string[];
  acceptable: boolean;
  retrospective: boolean;
  limitations: string[];
}

export interface EvaluationOutcome {
  caseId: string;
  completed: boolean;
  extractedRequirementIds: string[];
  identifiedGapRequirementIds: string[];
  findingFingerprints: string[];
  blocked: boolean;
  evidenceReferences: number;
  validEvidenceReferences: number;
  runtimeMs?: number;
  observedTokens?: number;
  observedCostUsd?: number;
}

export interface Metric { numerator: number; denominator: number; value: number | null }
export interface EvaluationReport {
  version: 1;
  sampleSize: number;
  requirementExtractionRecall: Metric;
  gapDetectionRecall: Metric;
  findingPrecision: Metric;
  falseBlockRate: Metric;
  evidenceValidity: Metric;
  completionRate: Metric;
  runtimeMs: { observed: number; mean: number | null };
  tokens: { observedCases: number; total: number | null };
  costUsd: { observedCases: number; total: number | null };
  limitations: string[];
}

function metric(numerator: number, denominator: number): Metric { return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator }; }
function intersection(left: readonly string[], right: readonly string[]): number { const accepted = new Set(right); return new Set(left.filter((item) => accepted.has(item))).size; }

export function evaluate(cases: readonly EvaluationCase[], outcomes: readonly EvaluationOutcome[]): EvaluationReport {
  const outcomeByCase = new Map(outcomes.map((outcome) => [outcome.caseId, outcome]));
  let requirementHits = 0, requirements = 0, gapHits = 0, gaps = 0, validFindings = 0, findings = 0, falseBlocks = 0, acceptable = 0, validEvidence = 0, evidence = 0, completed = 0;
  const runtimes: number[] = [];
  const tokens: number[] = [];
  const costs: number[] = [];
  const limitations = new Set<string>();
  for (const testCase of cases) {
    testCase.limitations.forEach((item) => limitations.add(`${testCase.id}: ${item}`));
    if (testCase.retrospective) limitations.add(`${testCase.id}: historical source version was unavailable; case is retrospective.`);
    const outcome = outcomeByCase.get(testCase.id);
    requirements += testCase.adjudicatedRequirementIds.length;
    gaps += testCase.knownGapRequirementIds.length;
    if (testCase.acceptable) acceptable += 1;
    if (!outcome) { limitations.add(`${testCase.id}: no outcome.`); continue; }
    completed += outcome.completed ? 1 : 0;
    requirementHits += intersection(outcome.extractedRequirementIds, testCase.adjudicatedRequirementIds);
    gapHits += intersection(outcome.identifiedGapRequirementIds, testCase.knownGapRequirementIds);
    validFindings += intersection(outcome.findingFingerprints, testCase.validFindingFingerprints);
    findings += new Set(outcome.findingFingerprints).size;
    if (testCase.acceptable && outcome.blocked) falseBlocks += 1;
    validEvidence += outcome.validEvidenceReferences;
    evidence += outcome.evidenceReferences;
    if (outcome.runtimeMs !== undefined) runtimes.push(outcome.runtimeMs);
    if (outcome.observedTokens !== undefined) tokens.push(outcome.observedTokens);
    if (outcome.observedCostUsd !== undefined) costs.push(outcome.observedCostUsd);
  }
  for (const outcome of outcomes) if (!cases.some((item) => item.id === outcome.caseId)) limitations.add(`${outcome.caseId}: outcome has no matching case and was excluded.`);
  return {
    version: 1,
    sampleSize: cases.length,
    requirementExtractionRecall: metric(requirementHits, requirements),
    gapDetectionRecall: metric(gapHits, gaps),
    findingPrecision: metric(validFindings, findings),
    falseBlockRate: metric(falseBlocks, acceptable),
    evidenceValidity: metric(validEvidence, evidence),
    completionRate: metric(completed, cases.length),
    runtimeMs: { observed: runtimes.length, mean: runtimes.length ? runtimes.reduce((sum, value) => sum + value, 0) / runtimes.length : null },
    tokens: { observedCases: tokens.length, total: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null },
    costUsd: { observedCases: costs.length, total: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null },
    limitations: [...limitations],
  };
}

export interface ComparisonConfiguration { harness: string; harnessVersion: string; provider: string; model: string; promptDigest: string; contextDigest: string; budgetDigest: string }
export function comparisonConfounds(left: ComparisonConfiguration, right: ComparisonConfiguration): string[] {
  const result: string[] = [];
  for (const key of ["harness", "harnessVersion", "provider", "model", "promptDigest", "contextDigest", "budgetDigest"] as const) if (left[key] !== right[key]) result.push(key);
  return result;
}
