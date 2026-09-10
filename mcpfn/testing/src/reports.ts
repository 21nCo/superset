import type { McpFnDiagnosticPhase } from "@mcpfn/client";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import type { McpFnTargetSuiteReport } from "./suite.js";

declare const __MCPFN_TESTING_VERSION__: string;

export const MCPFN_TESTING_VERSION = __MCPFN_TESTING_VERSION__;
export const MCPFN_REPORT_SCHEMA_VERSION = "1.0.0";

export type McpFnFailureLayer =
  | "mcpfn-preflight"
  | "authorization-server"
  | "resource-server"
  | "mcp-initialization"
  | "scenario"
  | "upstream-conformance";

export interface McpFnReportFailure {
  name: string;
  message: string;
  layer: McpFnFailureLayer;
  code?: string;
  phase?: string;
  details?: Record<string, unknown>;
}

export interface McpFnJunitOptions {
  /** Aggregate XML size cap after serialization. Defaults to 1 MiB. */
  maxBytes?: number;
}

export function normalizeMcpFnReportFailure(
  error: unknown,
  fallbackPhase?: McpFnDiagnosticPhase | "scenario" | "upstream-conformance",
): McpFnReportFailure {
  const redacted = redactOAuthValue(error, {
    maxDepth: 6,
    maxArrayEntries: 50,
    maxObjectEntries: 50,
    maxStringLength: 2_048,
  });
  const record = redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
  const phase = stringField(record.phase) ?? fallbackPhase;
  const details = record.details && typeof record.details === "object" &&
      !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : undefined;
  let message = stringField(record.message) ?? String(
    redactOAuthValue(error instanceof Error ? error.message : String(error)),
  );
  const cause = error && typeof error === "object"
    ? (error as { cause?: unknown }).cause
    : undefined;
  const redactedCause = cause === undefined
    ? undefined
    : redactOAuthValue(cause, {
      maxDepth: 4,
      maxArrayEntries: 20,
      maxObjectEntries: 20,
      maxStringLength: 1_024,
    });
  const causeRecord = redactedCause && typeof redactedCause === "object" &&
      !Array.isArray(redactedCause)
    ? redactedCause as Record<string, unknown>
    : undefined;
  const causeMessage = stringField(causeRecord?.message);
  if (causeMessage && !message.includes(causeMessage)) message = `${message}: ${causeMessage}`;
  const combinedDetails = causeRecord
    ? { ...(details ?? {}), cause: causeRecord }
    : details;
  return {
    name: stringField(record.name) ?? "Error",
    message,
    layer: failureLayer(phase),
    ...(stringField(record.code) ? { code: stringField(record.code)! } : {}),
    ...(phase ? { phase } : {}),
    ...(combinedDetails ? { details: combinedDetails } : {}),
  };
}

/** Serialize a redacted target-suite report as bounded JUnit XML. */
export function createMcpFnTargetSuiteJUnit(
  report: McpFnTargetSuiteReport,
  options: McpFnJunitOptions = {},
): string {
  const maxBytes = options.maxBytes ?? 1_048_576;
  validateArtifactCap(maxBytes);
  const safe = redactOAuthValue(report, {
    maxDepth: 10,
    maxArrayEntries: 1_000,
    maxObjectEntries: 200,
    maxStringLength: 4_096,
  }) as unknown as McpFnTargetSuiteReport;
  const cases = safe.results.map((result) => {
    const duration = Math.max(0, result.durationMs ?? 0) / 1_000;
    const failure = result.status === "passed"
      ? ""
      : junitFailure(
        result.error ?? `Scenario ${result.status}`,
        result.status === "failed" ? "scenario" : "incomplete",
      );
    return `    <testcase name="${xml(result.name)}" classname="mcpfn.scenario" time="${duration.toFixed(3)}">${failure}</testcase>`;
  });
  if (safe.failure) {
    cases.unshift(
      `    <testcase name="${xml(safe.failure.phase ?? "target")}" classname="mcpfn.${xml(safe.failure.layer)}" time="0.000">${junitFailure(safe.failure.message, safe.failure.code ?? safe.failure.layer)}</testcase>`,
    );
  }
  if (cases.length === 0) {
    cases.push(
      '    <testcase name="target-suite" classname="mcpfn.target" time="0.000"></testcase>',
    );
  }
  const failures = safe.failed + (safe.failure ? 1 : 0);
  let serialized = junitDocument(safe, cases, failures);
  if (bytes(serialized) <= maxBytes) return serialized;

  const boundedCases = [
    `    <testcase name="artifact-cap" classname="mcpfn.report" time="0.000">${junitFailure("JUnit content exceeded maxBytes and was truncated", "incomplete")}</testcase>`,
  ];
  serialized = junitDocument(safe, boundedCases, 1, true);
  if (bytes(serialized) > maxBytes) {
    throw new Error("The minimum McpFn JUnit report exceeds maxBytes");
  }
  return serialized;
}

function junitDocument(
  report: McpFnTargetSuiteReport,
  cases: string[],
  failures: number,
  truncated = false,
): string {
  const suiteName = String(redactOAuthValue(`mcpfn:${report.target.kind}`));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xml(suiteName)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0">`,
    "  <properties>",
    `    <property name="mcpfn.report.schema" value="${xml(MCPFN_REPORT_SCHEMA_VERSION)}"/>`,
    `    <property name="mcpfn.testing.version" value="${xml(MCPFN_TESTING_VERSION)}"/>`,
    `    <property name="node.version" value="${xml(report.runtime.node)}"/>`,
    `    <property name="artifact.truncated" value="${truncated}"/>`,
    "  </properties>",
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}

function junitFailure(message: string, type: string): string {
  const safe = String(redactOAuthValue(message, { maxStringLength: 4_096 }));
  return `<failure type="${xml(type)}" message="${xml(safe)}">${xml(safe)}</failure>`;
}

function failureLayer(phase: string | undefined): McpFnFailureLayer {
  if (phase === "resource-discovery" || phase === "transport-connect") {
    return "resource-server";
  }
  if (
    phase === "authorization-server-discovery" ||
    phase === "client-registration" ||
    phase === "authorization-request" ||
    phase === "authorization-callback" ||
    phase === "token-exchange" ||
    phase === "token-refresh" ||
    phase === "token-revocation"
  ) {
    return "authorization-server";
  }
  if (phase === "mcp-initialize" || phase === "capability-operation") {
    return "mcp-initialization";
  }
  if (phase === "scenario") return "scenario";
  if (phase === "upstream-conformance") return "upstream-conformance";
  return "mcpfn-preflight";
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function xml(value: string): string {
  return stripInvalidXmlControls(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripInvalidXmlControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function validateArtifactCap(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024) {
    throw new Error("maxBytes must be an integer of at least 1024");
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
