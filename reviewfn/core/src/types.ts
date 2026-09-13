export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RetrievalStatus = "available" | "truncated" | "permission_denied" | "deleted" | "unsupported" | "failed";
export type RequirementStatus = "implemented" | "partial" | "missing" | "unverified" | "not_applicable";
export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "superseded";
export type CoverageStatus = "complete" | "incomplete";
export type Verdict = "ready" | "changes_requested" | "needs_verification";
export type FindingLifecycle = "new" | "still_valid" | "resolved" | "superseded" | "needs_revalidation";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SourceReference {
  sourceId: string;
  anchor: string;
  excerpt?: string;
}

export interface ContextSource {
  id: string;
  type: "issue" | "comment" | "document" | "repository_markdown" | "other";
  canonicalUrl?: string;
  workspace?: string;
  retrievedAt: string;
  providerVersion?: string;
  updatedAt?: string;
  digest: string;
  status: RetrievalStatus;
  content?: string;
  parentId?: string;
  error?: string;
}

export interface ContextManifest {
  version: 1;
  sources: ContextSource[];
  selection: { candidates: string[]; selected: string[]; rule: string };
  limits: { maxSources: number; maxBytes: number; maxDepth: number };
  incompleteReasons: string[];
  digest: string;
}

export interface CodeAnchor {
  commit: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

export interface Evidence {
  id: string;
  kind: "source" | "code" | "diff" | "test" | "artifact";
  description: string;
  source?: SourceReference;
  code?: CodeAnchor;
  receiptId?: string;
  artifactDigest?: string;
}

export interface Requirement {
  id: string;
  statement: string;
  sources: SourceReference[];
  category: "behavior" | "architecture" | "compatibility" | "test" | "migration" | "documentation" | "non_goal" | "other";
  scope: string;
  classification: "mandatory" | "advisory";
  dependencies: string[];
  ambiguity?: string;
  extraction: { harness: string; promptDigest: string };
}

export interface Assessment {
  requirementId: string;
  status: RequirementStatus;
  evidenceIds: string[];
  reasoning: string;
  gaps: string[];
  confidence: number;
  waiverReference?: SourceReference;
}

export interface Finding {
  fingerprint: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  trigger: string;
  impact: string;
  direction: string;
  anchor?: CodeAnchor;
  evidenceIds: string[];
  basis: "reproduced" | "inferred";
  requirementIds: string[];
  lifecycle: FindingLifecycle;
}

export interface TestReceipt {
  id: string;
  command: string[];
  cwd: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  runtimeMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  stdoutDigest: string;
  stderrDigest: string;
  limitations: string[];
}

export interface ChangeSnapshot {
  repositoryId: string;
  host: string;
  pullRequest?: number;
  targetBranch: string;
  baseCommit: string;
  headCommit: string;
  mergeBaseCommit: string;
  diffDigest: string;
  changedPaths: string[];
  capturedAt: string;
}

export interface RunConfigurationProvenance {
  schemaVersion: 1;
  policyDigest: string;
  promptDigest: string;
  harness: { id: string; version: string };
  inference: { provider: string; model: string; auth: string };
  execution: { adapter: string; timeoutMs: number; maxOutputBytes: number };
  contextAdapters: string[];
  profile: string;
}

export interface ReviewReport {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  createdAt: string;
  change: ChangeSnapshot;
  contextManifestDigest: string;
  contextManifestArtifact: string;
  configuration: RunConfigurationProvenance;
  execution: ExecutionStatus;
  coverage: CoverageStatus;
  coverageReasons: string[];
  verdict?: Verdict;
  requirements: Requirement[];
  assessments: Assessment[];
  evidence: Evidence[];
  findings: Finding[];
  tests: TestReceipt[];
  inspectedPaths: string[];
  uninspected: Array<{ scope: string; reason: string }>;
  normalizedEventArtifact?: string;
  redactedTranscriptArtifact?: string;
  limitations: string[];
}

export interface ReviewPolicy {
  version: 1;
  mode: "advisory" | "gate";
  requiredCategories: Requirement["category"][];
  blockingSeverities: FindingSeverity[];
  allowRepositoryTightening: boolean;
  sourceAuthority: { acceptedTypes: ContextSource["type"][]; commentsMayClarify: boolean; waiverAuthorities: string[] };
  limits: {
    contextMaxSources: number;
    contextMaxBytes: number;
    contextMaxDepth: number;
    harnessTimeoutMs: number;
    testTimeoutMs: number;
    maxOutputBytes: number;
    maxFindings: number;
  };
  retention: { reportDays: number; transcriptDays: number; testLogDays: number };
}

export interface ReviewFnConfig {
  version: 1;
  profile: string;
  harness: { adapter: string; version: string; executable?: string };
  inference: { provider: string; model: string; auth: string; credentialEnv?: string };
  context: Array<{ adapter: string; account?: string; expectedWorkspace?: string; issue?: string; paths?: string[] }>;
  review: { categories: Requirement["category"][]; evidenceRequired: boolean };
  execution: { adapter: string; tests: string[][]; timeoutMs: number; maxOutputBytes: number };
  output: { destinations: Array<"local" | "github">; mode: "advisory" | "gate" };
  retention: ReviewPolicy["retention"];
  fallback: Array<{ harness: string; provider: string; model: string; auth: string }>;
}

export interface HarnessCapabilities {
  id: string;
  version: string;
  providers: string[];
  authModes: string[];
  structuredOutput: boolean;
  observableEvents: boolean;
  usageMetrics: boolean;
  cancellation: boolean;
  toolControls: boolean;
  sandboxModes: string[];
}

export interface PreflightDiagnostic {
  code: string;
  level: "error" | "warning" | "info";
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  resolved?: { provider: string; model: string; auth: string; harnessVersion: string };
  diagnostics: PreflightDiagnostic[];
}

export interface NormalizedRunEvent {
  sequence: number;
  at: string;
  type: "started" | "message" | "tool_started" | "tool_finished" | "usage" | "warning" | "error" | "completed" | "canceled";
  data: Record<string, JsonValue>;
}

export interface HarnessInput {
  runId: string;
  workspace: string;
  change: ChangeSnapshot;
  context: ContextManifest;
  policy: ReviewPolicy;
  configuration: ReviewFnConfig;
  testReceipts: TestReceipt[];
  prompt: string;
  signal?: AbortSignal;
}

export interface HarnessOutput {
  terminal: "completed" | "failed" | "canceled" | "quota_exhausted" | "timed_out" | "malformed";
  requirements: Requirement[];
  assessments: Assessment[];
  evidence: Evidence[];
  findings: Finding[];
  inspectedPaths: string[];
  uninspected: Array<{ scope: string; reason: string }>;
  events: NormalizedRunEvent[];
  transcript?: string;
  error?: string;
}

export interface ContextRequest {
  root: string;
  issue?: string;
  account?: string;
  expectedWorkspace?: string;
  paths?: string[];
  limits: ContextManifest["limits"];
  signal?: AbortSignal;
}

export interface ContextAdapter {
  readonly id: string;
  preflight(request: ContextRequest): Promise<PreflightResult>;
  fetch(request: ContextRequest): Promise<Omit<ContextManifest, "digest">>;
}

export interface SourceControlAdapter {
  readonly id: string;
  capture(root: string, base: string, head: string, pullRequest?: number): Promise<ChangeSnapshot>;
  currentHead(root: string, pullRequest?: number): Promise<string>;
  verifyAnchor(root: string, anchor: CodeAnchor): Promise<boolean>;
}

export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult>;
  run(input: HarnessInput): Promise<HarnessOutput>;
}

export interface ExecutionAdapter {
  readonly id: string;
  preflight(root: string): Promise<PreflightResult>;
  run(root: string, headCommit: string, commands: string[][], policy: ReviewPolicy, signal?: AbortSignal): Promise<TestReceipt[]>;
}

export interface ArtifactStore {
  put(kind: string, content: string | Uint8Array, retentionDays: number): Promise<{ digest: string; id: string }>;
  get(id: string): Promise<Uint8Array | undefined>;
  deleteExpired(now?: Date): Promise<{ deleted: string[]; errors: string[] }>;
}

export interface PublishRequest {
  report: ReviewReport;
  rendered: string;
  expectedHead: string;
  profile: string;
}

export interface PublishResult {
  status: "published" | "updated" | "unchanged" | "stale" | "failed";
  reference?: string;
  error?: string;
}

export interface ReportPublisher {
  readonly id: string;
  preflight(): Promise<PreflightResult>;
  publish(request: PublishRequest): Promise<PublishResult>;
}

export interface ReviewRunRequest {
  root: string;
  base: string;
  head: string;
  pullRequest?: number;
  config: ReviewFnConfig;
  policy: ReviewPolicy;
  issue?: string;
  attemptId?: string;
  signal?: AbortSignal;
}
