import { createAttemptId, digestJson } from "./canonical.js";
import { ReviewFnError } from "./errors.js";
import { findingFingerprint } from "./identity.js";
import { buildReviewPrompt } from "./prompt.js";
import { collectSecrets, redactText } from "./redaction.js";
import { combineContextManifests } from "./repository-context.js";
import { renderMarkdownReport } from "./render.js";
import type {
  ArtifactStore,
  ContextAdapter,
  ContextManifest,
  ContextSource,
  ExecutionAdapter,
  HarnessAdapter,
  HarnessOutput,
  PreflightDiagnostic,
  PublishResult,
  ReportPublisher,
  ReviewReport,
  ReviewRunRequest,
  SourceControlAdapter,
} from "./types.js";
import { deriveVerdict, preflightPublishers, validateReport } from "./validator.js";

export interface CoordinatorDependencies {
  sourceControl: SourceControlAdapter;
  contexts: ContextAdapter[];
  harness: HarnessAdapter;
  execution: ExecutionAdapter;
  artifacts: ArtifactStore;
  publishers?: ReportPublisher[];
  now?: () => Date;
}

export interface ReviewRunResult {
  report: ReviewReport;
  rendered: string;
  publications: PublishResult[];
  validation: { warnings: string[] };
}

function failedContext(adapter: ContextAdapter, error: unknown, limits: ContextManifest["limits"], now: Date): Omit<ContextManifest, "digest"> {
  const message = error instanceof Error ? error.message : String(error);
  const source: ContextSource = { id: `${adapter.id}:failure`, type: "other", retrievedAt: now.toISOString(), digest: digestJson({ adapter: adapter.id, message }), status: "failed", error: message };
  return { version: 1, sources: [source], selection: { candidates: [], selected: [], rule: `${adapter.id} failed` }, limits, incompleteReasons: [`${adapter.id}: ${message}`] };
}

function terminalExecution(output: HarnessOutput): ReviewReport["execution"] {
  if (output.terminal === "completed") return "completed";
  if (output.terminal === "canceled") return "canceled";
  return "failed";
}

export class ReviewCoordinator {
  public constructor(private readonly dependencies: CoordinatorDependencies) {}

  public async preflight(request: ReviewRunRequest): Promise<PreflightDiagnostic[]> {
    const diagnostics: PreflightDiagnostic[] = [];
    const contextById = new Map(this.dependencies.contexts.map((adapter) => [adapter.id, adapter]));
    for (const item of request.config.context) {
      const adapter = contextById.get(item.adapter);
      if (!adapter) { diagnostics.push({ code: "REVIEWFN_CONTEXT_ADAPTER_MISSING", level: "error", message: `Context adapter ${item.adapter} is not installed.` }); continue; }
      const result = await adapter.preflight({ root: request.root, issue: item.issue ?? request.issue, account: item.account, expectedWorkspace: item.expectedWorkspace, paths: item.paths, limits: this.contextLimits(request), signal: request.signal });
      diagnostics.push(...result.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${adapter.id}: ${diagnostic.message}` })));
    }
    const harness = await this.dependencies.harness.preflight(request.config, request.signal);
    diagnostics.push(...harness.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${this.dependencies.harness.capabilities.id}: ${diagnostic.message}` })));
    const execution = await this.dependencies.execution.preflight(request.root);
    diagnostics.push(...execution.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${this.dependencies.execution.id}: ${diagnostic.message}` })));
    for (const message of await preflightPublishers(this.dependencies.publishers ?? [])) diagnostics.push({ code: "REVIEWFN_PUBLISHER_PREFLIGHT", level: "error", message });
    if (request.config.fallback.length) diagnostics.push({ code: "REVIEWFN_FALLBACK_EXPLICIT", level: "info", message: "Fallbacks are declared but are never selected silently; an operator must rerun with the chosen compatible configuration." });
    return diagnostics;
  }

  public async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    if (request.signal?.aborted) throw new ReviewFnError("REVIEWFN_CANCELED", "Review canceled before preflight.");
    const diagnostics = await this.preflight(request);
    const preflightErrors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (preflightErrors.length) throw new ReviewFnError("REVIEWFN_PREFLIGHT_FAILED", "Review preflight failed.", { diagnostics: preflightErrors });
    const now = this.dependencies.now ?? (() => new Date());
    const change = await this.dependencies.sourceControl.capture(request.root, request.base, request.head, request.pullRequest);
    const limits = this.contextLimits(request);
    const contextById = new Map(this.dependencies.contexts.map((adapter) => [adapter.id, adapter]));
    const manifests: Array<Omit<ContextManifest, "digest">> = [];
    for (const item of request.config.context) {
      const adapter = contextById.get(item.adapter) as ContextAdapter;
      try {
        manifests.push(await adapter.fetch({ root: request.root, issue: item.issue ?? request.issue, account: item.account, expectedWorkspace: item.expectedWorkspace, paths: item.paths, limits, signal: request.signal }));
      } catch (error) {
        manifests.push(failedContext(adapter, error, limits, now()));
      }
    }
    const context = combineContextManifests(manifests, limits);
    const contextArtifact = await this.dependencies.artifacts.put("context-manifest", JSON.stringify(context, null, 2), request.policy.retention.reportDays);

    const executionPolicy = { ...request.policy, limits: { ...request.policy.limits, testTimeoutMs: Math.min(request.policy.limits.testTimeoutMs, request.config.execution.timeoutMs), maxOutputBytes: Math.min(request.policy.limits.maxOutputBytes, request.config.execution.maxOutputBytes) } };
    const tests = await this.dependencies.execution.run(request.root, change.headCommit, request.config.execution.tests, executionPolicy, request.signal);
    const prompt = buildReviewPrompt({ change, context, config: request.config, policy: request.policy, tests });
    const runId = digestJson({ change, contextDigest: context.digest, policy: request.policy, config: request.config, promptDigest: prompt.digest });
    const attemptId = request.attemptId ?? createAttemptId();
    let output: HarnessOutput;
    try {
      output = await this.dependencies.harness.run({ runId, workspace: request.root, change, context, policy: request.policy, configuration: request.config, testReceipts: tests, prompt: prompt.prompt, signal: request.signal });
    } catch (error) {
      output = { terminal: request.signal?.aborted ? "canceled" : "failed", requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error instanceof Error ? error.message : String(error) }], events: [], error: error instanceof Error ? error.message : String(error) };
    }
    output.findings = output.findings.map((finding) => ({ ...finding, fingerprint: findingFingerprint(finding) }));
    const sourceIds = new Set(context.sources.map((source) => source.id));
    const unknownSources = [
      ...output.requirements.flatMap((requirement) => requirement.sources.map((source) => source.sourceId)),
      ...output.evidence.flatMap((evidence) => evidence.source ? [evidence.source.sourceId] : []),
    ].filter((sourceId) => !sourceIds.has(sourceId));
    if (unknownSources.length) throw new ReviewFnError("REVIEWFN_REPORT_INVALID", "Harness output references unknown context sources.", { sourceIds: [...new Set(unknownSources)] });

    const secrets = collectSecrets(process.env);
    const eventArtifact = await this.dependencies.artifacts.put("normalized-events", redactText(JSON.stringify(output.events, null, 2), secrets), request.policy.retention.reportDays);
    const transcriptArtifact = output.transcript ? await this.dependencies.artifacts.put("redacted-transcript", redactText(output.transcript, secrets), request.policy.retention.transcriptDays) : undefined;
    const coverageReasons = [
      ...context.incompleteReasons,
      ...(output.terminal === "completed" ? [] : [`Harness terminal outcome: ${output.terminal}${output.error ? ` (${output.error})` : ""}.`]),
      ...output.uninspected.map((item) => `Uninspected ${item.scope}: ${item.reason}`),
      ...tests.filter((receipt) => receipt.timedOut || receipt.canceled).map((receipt) => `Test ${receipt.id} did not complete.`),
    ];
    const report: ReviewReport = {
      schemaVersion: 1,
      runId,
      attemptId,
      createdAt: now().toISOString(),
      change,
      contextManifestDigest: context.digest,
      contextManifestArtifact: contextArtifact.id,
      configuration: {
        schemaVersion: 1,
        policyDigest: digestJson(request.policy),
        promptDigest: prompt.digest,
        harness: { id: this.dependencies.harness.capabilities.id, version: this.dependencies.harness.capabilities.version },
        inference: { provider: request.config.inference.provider, model: request.config.inference.model, auth: request.config.inference.auth },
        execution: { adapter: this.dependencies.execution.id, timeoutMs: request.config.execution.timeoutMs, maxOutputBytes: request.config.execution.maxOutputBytes },
        contextAdapters: request.config.context.map((item) => item.adapter),
        profile: request.config.profile,
      },
      execution: terminalExecution(output),
      coverage: coverageReasons.length ? "incomplete" : "complete",
      coverageReasons,
      requirements: output.requirements,
      assessments: output.assessments,
      evidence: output.evidence,
      findings: output.findings,
      tests,
      inspectedPaths: output.inspectedPaths,
      uninspected: output.uninspected,
      normalizedEventArtifact: eventArtifact.id,
      redactedTranscriptArtifact: transcriptArtifact?.id,
      limitations: diagnostics.filter((diagnostic) => diagnostic.level === "warning").map((diagnostic) => diagnostic.message),
    };
    report.verdict = deriveVerdict(report, request.policy);
    const validation = await validateReport(report, request.policy, this.dependencies.sourceControl, request.root);
    if (!validation.valid) throw new ReviewFnError("REVIEWFN_REPORT_INVALID", "Harness output failed report validation.", { errors: validation.errors });
    await this.dependencies.artifacts.put("review-report", JSON.stringify(report, null, 2), request.policy.retention.reportDays);
    const rendered = renderMarkdownReport(report);
    const publications: PublishResult[] = [];
    if ((this.dependencies.publishers?.length ?? 0) > 0) {
      const currentHead = await this.dependencies.sourceControl.currentHead(request.root, request.pullRequest);
      if (currentHead !== change.headCommit) publications.push({ status: "stale", error: `Current head ${currentHead} differs from reviewed head ${change.headCommit}.` });
      else for (const publisher of this.dependencies.publishers ?? []) publications.push(await publisher.publish({ report, rendered, expectedHead: change.headCommit, profile: request.config.profile }));
    }
    return { report, rendered, publications, validation: { warnings: validation.warnings } };
  }

  private contextLimits(request: ReviewRunRequest): ContextManifest["limits"] {
    return { maxSources: request.policy.limits.contextMaxSources, maxBytes: request.policy.limits.contextMaxBytes, maxDepth: request.policy.limits.contextMaxDepth };
  }
}
