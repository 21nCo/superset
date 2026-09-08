import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { ClientCapabilities, Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpFnTarget } from "@mcpfn/client";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import { McpFnTestClient, type McpFnTestClientOptions } from "./client.js";

export interface McpFnClientProfileFixture {
  id: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** A captured and consumer-redacted production payload. Never put secrets here. */
  source?: "minimal-valid" | "redacted-regression";
  expectError?: boolean;
}

export interface McpFnClientProfileContractProfile {
  id: string;
  version?: string;
  target: McpFnTarget | (() => McpFnTarget | Promise<McpFnTarget>);
  clientInfo?: Implementation;
  capabilities?: ClientCapabilities;
  client?: Omit<McpFnTestClientOptions, "capabilities">;
  fixtures?: McpFnClientProfileFixture[];
  /** Explicitly reviewed hash of the effective tools/list catalog. */
  expectedCatalogHash?: string;
}

export interface McpFnProfileCompatibilityIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface McpFnClientProfileEvidence {
  id: string;
  version?: string;
  ok: boolean;
  catalogHash?: string;
  toolNames: string[];
  issues: McpFnProfileCompatibilityIssue[];
  fixtures: Array<{ id: string; tool: string; source: string; ok: boolean; error?: unknown }>;
}

export interface McpFnClientProfileContractReport {
  formatVersion: 1;
  kind: "mcpfn.client-profile-compatibility";
  ok: boolean;
  profiles: McpFnClientProfileEvidence[];
}

/** Deterministically exercises real targets through tools/list and tools/call. */
export async function runMcpFnClientProfileContract(
  profiles: McpFnClientProfileContractProfile[],
  options: { maxReportBytes?: number } = {},
): Promise<McpFnClientProfileContractReport> {
  const evidence: McpFnClientProfileEvidence[] = [];
  for (const definition of profiles) {
    const current: McpFnClientProfileEvidence = {
      id: definition.id,
      ...(definition.version ? { version: definition.version } : {}),
      ok: true,
      toolNames: [],
      issues: [],
      fixtures: [],
    };
    const target = typeof definition.target === "function"
      ? await definition.target()
      : definition.target;
    const client = await McpFnTestClient.connectTarget(
      target,
      definition.clientInfo ?? { name: `mcpfn-profile:${definition.id}`, version: "1.0.0" },
      { ...definition.client, capabilities: definition.capabilities },
    );
    try {
      const tools = await client.listTools();
      current.toolNames = tools.map(({ name }) => name).sort();
      current.catalogHash = catalogHash(tools);
      for (const [index, tool] of tools.entries()) {
        try {
          new Ajv({ strict: false }).compile(tool.inputSchema);
        } catch (error) {
          current.issues.push({
            severity: "error",
            code: "invalid-input-schema",
            path: `tools.${index}.inputSchema`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        current.issues.push(...checkPortableSchema(tool, index));
      }
      if (definition.expectedCatalogHash && definition.expectedCatalogHash !== current.catalogHash) {
        current.issues.push({
          severity: "error",
          code: "catalog-snapshot-mismatch",
          path: "tools",
          message: `Expected ${definition.expectedCatalogHash}, received ${current.catalogHash}`,
        });
      }
      const advertised = new Set(tools.map(({ name }) => name));
      for (const fixture of definition.fixtures ?? []) {
        let error: unknown;
        let gotError = false;
        try {
          const result = await client.callTool(fixture.tool, fixture.arguments ?? {});
          gotError = result.isError === true;
          if (gotError) error = result.structuredContent ?? result.content;
        } catch (caught) {
          gotError = true;
          error = caught;
        }
        const ok = advertised.has(fixture.tool) && gotError === Boolean(fixture.expectError);
        current.fixtures.push({
          id: fixture.id,
          tool: fixture.tool,
          source: fixture.source ?? "minimal-valid",
          ok,
          ...(error === undefined ? {} : { error: evidenceError(error) }),
        });
      }
    } catch (error) {
      current.issues.push({
        severity: "error",
        code: "profile-execution-failed",
        path: "profile",
        message: "Profile catalog or call execution failed; inspect protected runtime diagnostics",
      });
    } finally {
      await client.close();
    }
    current.ok = !current.issues.some(({ severity }) => severity === "error") &&
      current.fixtures.every(({ ok }) => ok);
    evidence.push(current);
  }
  const report: McpFnClientProfileContractReport = {
    formatVersion: 1,
    kind: "mcpfn.client-profile-compatibility",
    ok: evidence.every(({ ok }) => ok),
    profiles: evidence,
  };
  const maxBytes = options.maxReportBytes ?? 1_048_576;
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024) {
    throw new Error("maxReportBytes must be an integer of at least 1024");
  }
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > maxBytes) {
    throw new Error("Client-profile compatibility evidence exceeded maxReportBytes");
  }
  return report;
}

function evidenceError(error: unknown): unknown {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const structured = candidate.structuredContent && typeof candidate.structuredContent === "object"
    ? candidate.structuredContent as Record<string, unknown>
    : undefined;
  const envelope = structured?.error && typeof structured.error === "object"
    ? structured.error as Record<string, unknown>
    : candidate;
  const details = envelope.details && typeof envelope.details === "object"
    ? envelope.details as Record<string, unknown>
    : undefined;
  const safe = {
    ...(typeof envelope.code === "string" ? { code: envelope.code } : {}),
    ...(Array.isArray(details?.issues) ? { issues: details.issues } : {}),
  };
  return redactOAuthValue(safe);
}

export function catalogHash(tools: Tool[]): string {
  const canonical = canonicalize([...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function checkPortableSchema(tool: Tool, index: number): McpFnProfileCompatibilityIssue[] {
  const issues: McpFnProfileCompatibilityIssue[] = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((entry, i) => visit(entry, `${path}.${i}`));
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const child = `${path}.${key}`;
      if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#")) {
        issues.push({ severity: "error", code: "remote-schema-reference", path: child, message: "Remote $ref values are not portable" });
      }
      if (["unevaluatedProperties", "dependentSchemas", "$dynamicRef"].includes(key)) {
        issues.push({ severity: "warning", code: "limited-client-schema-keyword", path: child, message: `${key} has limited client support` });
      }
      visit(entry, child);
    }
  };
  visit(tool.inputSchema, `tools.${index}.inputSchema`);
  return issues;
}
