import { redactTargetCredentials } from "./remote-target.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpFnDiagnosticEvent,
  McpFnTarget,
  McpFnTargetDescriptor,
} from "@mcpfn/client";
import type { McpFnManifest } from "@mcpfn/core";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import { assertManifestContract, McpFnAssertionError, stableJson } from "./assertions.js";
import { McpFnTestClient, type McpFnTestClientOptions } from "./client.js";
import {
  MCPFN_REPORT_SCHEMA_VERSION,
  MCPFN_TESTING_VERSION,
  normalizeMcpFnReportFailure,
  type McpFnReportFailure,
} from "./reports.js";
import {
  runScenarios,
  type McpFnScenario,
  type McpFnScenarioResult,
} from "./scenarios.js";

export interface RunMcpFnTargetSuiteOptions {
  target: McpFnTarget;
  scenarios?: McpFnScenario[];
  manifest?: McpFnManifest;
  expectedToolNames?: readonly string[];
  clientInfo?: Implementation;
  client?: McpFnTestClientOptions;
  scenarioRun?: NonNullable<Parameters<typeof runScenarios>[2]>;
  /** Aggregate JSON size cap. Defaults to 1 MiB. */
  maxReportBytes?: number;
  /** Diagnostic timeline count cap. Defaults to 500. */
  maxTimelineEvents?: number;
}

export interface McpFnTargetSuiteReport {
  formatVersion: 1;
  kind: "mcpfn.target-suite-report";
  status: "complete" | "incomplete";
  runtime: {
    node: string;
    scenarioFormatVersion: 1;
    reportSchemaVersion: string;
    packages: { testing: string };
  };
  ok: boolean;
  target: McpFnTargetDescriptor;
  server?: Implementation;
  capabilities?: ServerCapabilities;
  manifestChecked: boolean;
  manifestHash?: string;
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  droppedResults: number;
  droppedObservedEvents: number;
  incompleteReason?: string;
  failure?: McpFnReportFailure;
  timeline: McpFnDiagnosticEvent[];
  droppedTimelineEvents: number;
  results: McpFnScenarioResult[];
}

/** Runs local, stdio, HTTP, or custom targets through the production session engine. */
export async function runMcpFnTargetSuite(
  options: RunMcpFnTargetSuiteOptions,
): Promise<McpFnTargetSuiteReport> {
  const timeline: McpFnDiagnosticEvent[] = [];
  let droppedTimelineEvents = 0;
  const maxTimelineEvents = options.maxTimelineEvents ?? 500;
  if (!Number.isInteger(maxTimelineEvents) || maxTimelineEvents < 1) {
    throw new Error("maxTimelineEvents must be a positive integer");
  }
  const maxReportBytes = options.maxReportBytes ?? 1_048_576;
  validateReportCap(maxReportBytes);
  const consumerDiagnostic = options.client?.diagnostics;
  let client: McpFnTestClient | undefined;
  let manifestChecked = false;
  let failure: McpFnReportFailure | undefined;
  let cleanupFailure: McpFnReportFailure | undefined;
  let execution: {
    results: McpFnScenarioResult[];
    server?: Implementation;
    capabilities?: ServerCapabilities;
  } = { results: [] };
  try {
    client = await McpFnTestClient.connectTarget(
      options.target,
      options.clientInfo ?? { name: "mcpfn-suite", version: "0.0.1" },
      {
        ...options.client,
        diagnostics: async (event) => {
          if (event.phase === "transport-close" && event.outcome === "failed") {
            cleanupFailure = normalizeMcpFnReportFailure({
              name: "CleanupError", message: "Target cleanup failed",
              code: event.code, phase: event.phase,
            });
          }
          timeline.push(redactTargetCredentials(options.target, redactOAuthValue(event)) as unknown as McpFnDiagnosticEvent);
          if (timeline.length > maxTimelineEvents) {
            timeline.shift();
            droppedTimelineEvents += 1;
          }
          await consumerDiagnostic?.(redactTargetCredentials(options.target, event));
        },
      },
    );
    if (options.manifest) {
      manifestChecked = true;
      await assertManifestContract(client, options.manifest, {
        expectedToolNames: options.expectedToolNames,
      });
    }
    if (!options.manifest && options.expectedToolNames) {
      const actual = (await client.listTools()).map((tool) => tool.name).sort();
      const expected = [...options.expectedToolNames].sort();
      if (stableJson(actual) !== stableJson(expected)) {
        throw new McpFnAssertionError(`Tool inventory mismatch: expected ${stableJson(expected)}, actual ${stableJson(actual)}`);
      }
    }
    execution = {
      results: await runScenarios(
        client,
        options.scenarios ?? [],
        options.scenarioRun,
      ),
      server: client.session.getServerVersion(),
      capabilities: client.session.getServerCapabilities(),
    };
  } catch (error) {
    failure = normalizeMcpFnReportFailure(error);
  } finally {
    try {
      await client?.close();
    } catch (error) {
      cleanupFailure = normalizeMcpFnReportFailure({ name: "CleanupError", message: "Target cleanup failed", code: "MCPFN_TARGET_CLEANUP_FAILED", phase: "transport-close" });
      if (!failure) failure = cleanupFailure;
    }
  }
  failure ??= cleanupFailure;
  const results = execution.results;
  const failed = results.filter((result) => result.status === "failed").length;
  const incomplete = results.filter((result) => result.status === "incomplete").length;
  const droppedObservedEvents = results.reduce(
    (total, result) => total + (result.droppedObservedEvents ?? 0),
    0,
  );
  const artifactIncomplete = Boolean(failure) || incomplete > 0 ||
    droppedTimelineEvents > 0 ||
    droppedObservedEvents > 0;
  const report: McpFnTargetSuiteReport = {
    formatVersion: 1,
    kind: "mcpfn.target-suite-report",
    status: artifactIncomplete ? "incomplete" : "complete",
    runtime: {
      node: process.version,
      scenarioFormatVersion: 1,
      reportSchemaVersion: MCPFN_REPORT_SCHEMA_VERSION,
      packages: { testing: MCPFN_TESTING_VERSION },
    },
    ok: failed === 0 && !artifactIncomplete,
    target: redactOAuthValue(
      options.target.describe(),
    ) as unknown as McpFnTargetDescriptor,
    server: execution.server,
    capabilities: execution.capabilities,
    manifestChecked,
    ...(options.manifest ? { manifestHash: options.manifest.hash } : {}),
    total: results.length,
    passed: results.length - failed - incomplete,
    failed,
    incomplete,
    droppedResults: 0,
    droppedObservedEvents,
    ...(failure || droppedTimelineEvents > 0 || droppedObservedEvents > 0
      ? {
        incompleteReason: [
          ...(failure ? [`${failure.layer}: ${failure.message}`] : []),
          ...(cleanupFailure ? [`Cleanup: ${cleanupFailure.message}`] : []),
          ...(droppedTimelineEvents > 0
            ? ["Diagnostic timeline exceeded maxTimelineEvents"]
            : []),
          ...(droppedObservedEvents > 0
            ? ["Observed client events exceeded maxObservedEvents"]
            : []),
        ].join("; "),
      }
      : {}),
    ...(failure ? { failure } : {}),
    timeline,
    droppedTimelineEvents,
    results,
  };
  return enforceReportCap(redactTargetCredentials(options.target, report), maxReportBytes);
}

function enforceReportCap(
  report: McpFnTargetSuiteReport,
  maxBytes: number,
): McpFnTargetSuiteReport {
  validateReportCap(maxBytes);
  const bounded = structuredClone(report);
  if (jsonBytes(bounded) > maxBytes) {
    bounded.ok = false;
    bounded.status = "incomplete";
    bounded.incompleteReason = "Report content exceeded maxReportBytes and was truncated";
  }
  while (jsonBytes(bounded) > maxBytes && bounded.results.length > 0) {
    bounded.results.pop();
    bounded.droppedResults += 1;
  }
  if (jsonBytes(bounded) > maxBytes) {
    bounded.target = { kind: report.target.kind };
    bounded.server = undefined;
    bounded.capabilities = undefined;
    bounded.timeline = [];
    bounded.droppedTimelineEvents += report.timeline.length;
    if (bounded.failure) bounded.failure.details = undefined;
  }
  if (bounded.droppedResults > 0 || jsonBytes(bounded) > maxBytes) {
    bounded.ok = false;
    bounded.status = "incomplete";
    bounded.incompleteReason = "Report content exceeded maxReportBytes and was truncated";
  }
  if (jsonBytes(bounded) > maxBytes) {
    throw new Error("The minimum target suite report exceeds maxReportBytes");
  }
  return bounded;
}

function validateReportCap(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024) {
    throw new Error("maxReportBytes must be an integer of at least 1024");
  }
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
}
