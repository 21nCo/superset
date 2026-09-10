import type { McpFnManifest, McpFnObjectSchema } from "@mcpfn/core";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import { McpFnAssertionError } from "./assertions.js";
import type { McpFnTestClient } from "./client.js";

export interface McpFnClientProfileFixture {
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect?: "none" | "idempotent" | "non-idempotent";
}

export interface McpFnClientProfileContract {
  id: string;
  version: string;
  client: McpFnTestClient;
  expectedToolNames?: readonly string[];
  fixtures?: McpFnClientProfileFixture[];
}

export interface McpFnClientProfileCompatibilityReport {
  formatVersion: 1;
  kind: "mcpfn.client-profile-report";
  manifestHash: string;
  status: "complete" | "incomplete";
  results: Array<{ profile: string; status: "passed" | "failed"; tools: string[]; error?: string }>;
  droppedResults: number;
}

/** Exercises the actual list/call connection; callers supply safe, explicit fixtures. */
export async function runClientProfileCompatibilitySuite(
  manifest: McpFnManifest,
  profiles: readonly McpFnClientProfileContract[],
  options: { maxBytes?: number } = {},
): Promise<McpFnClientProfileCompatibilityReport> {
  const results: McpFnClientProfileCompatibilityReport["results"] = [];
  for (const profile of profiles) {
    try {
      const tools = await profile.client.listTools();
      for (const tool of tools) assertPortableSchema(tool.inputSchema as McpFnObjectSchema, tool.name);
      const names = new Set(tools.map((tool) => tool.name));
      if (profile.expectedToolNames && JSON.stringify([...names].sort()) !== JSON.stringify([...profile.expectedToolNames].sort())) {
        throw new McpFnAssertionError(`Profile ${profile.id}@${profile.version} effective catalog differs from its reviewed snapshot`);
      }
      for (const fixture of profile.fixtures ?? []) {
        if (!names.has(fixture.tool)) throw new McpFnAssertionError(`Profile ${profile.id}@${profile.version} fixture targets hidden tool ${fixture.tool}`);
        if (fixture.sideEffect === "non-idempotent") continue;
        if ((await profile.client.callTool(fixture.tool, fixture.arguments)).isError) throw new McpFnAssertionError(`Profile ${profile.id}@${profile.version} fixture failed for ${fixture.tool}`);
      }
      results.push({ profile: `${profile.id}@${profile.version}`, status: "passed", tools: [...names].sort() });
    } catch (error) {
      results.push({ profile: `${profile.id}@${profile.version}`, status: "failed", tools: [], error: String(redactOAuthValue(error instanceof Error ? error.message : String(error))) });
    }
  }
  const report: McpFnClientProfileCompatibilityReport = { formatVersion: 1, kind: "mcpfn.client-profile-report", manifestHash: manifest.hash, status: "complete", results, droppedResults: 0 };
  const maxBytes = options.maxBytes ?? 1_048_576;
  while (new TextEncoder().encode(JSON.stringify(report)).byteLength > maxBytes && report.results.length) {
    report.results.pop(); report.droppedResults += 1; report.status = "incomplete";
  }
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > maxBytes) throw new Error("The minimum client-profile report exceeds maxBytes");
  return report;
}

function assertPortableSchema(schema: McpFnObjectSchema, tool: string): void {
  if (!schema || schema.type !== "object" || Array.isArray(schema)) throw new McpFnAssertionError(`Profile tool ${tool} has a non-object input schema`);
}
