import { describe, expect, it } from "vitest";
import { McpFnClientError } from "@mcpfn/client";

import {
  createMcpFnTargetSuiteJUnit,
  normalizeMcpFnReportFailure,
  type McpFnTargetSuiteReport,
} from "../src/index.js";

describe("McpFn machine-readable reports", () => {
  it("preserves structured failure fields while redacting sensitive details", () => {
    const failure = normalizeMcpFnReportFailure(new McpFnClientError(
      "MCPFN_CONNECT_FAILED",
      "authorization=Bearer report-secret",
      {
        phase: "mcp-initialize",
        details: {
          code: "nested-code",
          token: "report-secret",
          deployment: "role-3",
        },
      },
    ));

    expect(failure).toMatchObject({
      name: "McpFnClientError",
      code: "MCPFN_CONNECT_FAILED",
      phase: "mcp-initialize",
      layer: "mcp-initialization",
      details: {
        code: "nested-code",
        token: "[REDACTED]",
        deployment: "role-3",
      },
    });
    expect(JSON.stringify(failure)).not.toContain("report-secret");
  });

  it("redacts names and messages, removes invalid XML controls, and bounds JUnit", () => {
    const report = fixtureReport(Array.from({ length: 40 }, (_, index) => ({
      formatVersion: 1 as const,
      name: `case ${index} authorization=Bearer junit-secret`,
      operation: "tools.call",
      status: "failed" as const,
      sideEffect: "none" as const,
      durationMs: 1,
      error: `token=junit-secret\u0001 ${"x".repeat(100)}`,
    })));

    const xml = createMcpFnTargetSuiteJUnit(report, { maxBytes: 1_024 });
    expect(new TextEncoder().encode(xml).byteLength).toBeLessThanOrEqual(1_024);
    expect(xml).not.toContain("junit-secret");
    expect(xml).not.toContain("\u0001");
    expect(xml).toContain("artifact-cap");
    expect(xml).toContain("mcpfn.testing.version");
    expect(xml).toContain("mcpfn.report.schema");
  });
});

function fixtureReport(
  results: McpFnTargetSuiteReport["results"],
): McpFnTargetSuiteReport {
  return {
    formatVersion: 1,
    kind: "mcpfn.target-suite-report",
    status: "complete",
    runtime: {
      node: process.version,
      scenarioFormatVersion: 1,
      reportSchemaVersion: "1.0.0",
      packages: { testing: "0.0.0-test" },
    },
    ok: false,
    target: { kind: "external" },
    manifestChecked: false,
    total: results.length,
    passed: 0,
    failed: results.length,
    incomplete: 0,
    droppedResults: 0,
    droppedObservedEvents: 0,
    timeline: [],
    droppedTimelineEvents: 0,
    results,
  };
}
