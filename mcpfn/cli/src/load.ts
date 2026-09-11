import { existsSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import {
  createManifest,
  validateManifest,
  type McpFnManifest,
  type McpFnRegistry,
  type McpFnServer,
  type McpFnServerInfo,
  type McpFnServerRuntimeOptions,
} from "@mcpfn/core";
import {
  validateMcpFnScenarios,
  type McpFnScenario,
  type RunMcpFnClientProfileContractsOptions,
} from "@mcpfn/testing";

async function loadModule(file: string, cwd: string): Promise<unknown> {
  const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (resolved.endsWith(".json")) {
    return JSON.parse(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(resolved, "utf8"),
      ),
    );
  }
  const jiti = createJiti(cwd, { moduleCache: false });
  const loaded = (await jiti.import(resolved)) as Record<string, unknown>;
  let value: unknown = loaded.default ?? loaded;
  if (typeof value === "function") value = await value();
  return value;
}

function isServerExport(value: unknown): value is McpFnServer<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { manifest?: unknown }).manifest === "function" &&
      typeof (value as { connect?: unknown }).connect === "function" &&
      typeof (value as { close?: unknown }).close === "function",
  );
}

function isRegistryExport(value: unknown): value is McpFnRegistry<unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { definitions?: unknown }).definitions === "function" &&
      typeof (value as { listTools?: unknown }).listTools === "function" &&
      typeof (value as { callTool?: unknown }).callTool === "function",
  );
}

function isDeclarationExport(value: unknown): value is {
  manifest(): McpFnManifest;
  createServer(
    runtime?: McpFnServerRuntimeOptions<unknown>,
  ): McpFnServer<unknown>;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { manifest?: unknown }).manifest === "function" &&
      typeof (value as { createServer?: unknown }).createServer === "function",
  );
}

export async function loadManifestSource(
  file: string,
  cwd = process.cwd(),
  info?: McpFnServerInfo,
  runtime?: McpFnServerRuntimeOptions<unknown>,
): Promise<{ manifest: McpFnManifest; server?: McpFnServer<unknown> }> {
  const value = await loadModule(file, cwd);
  // Use the public surface instead of instanceof: a global CLI and the target
  // project commonly load separate physical copies of @mcpfn/core.
  if (isServerExport(value)) {
    return { manifest: validateManifest(value.manifest()), server: value };
  }
  if (isDeclarationExport(value)) {
    const manifest = validateManifest(value.manifest());
    if (runtime === undefined) return { manifest };
    const server = value.createServer(runtime);
    if (!isServerExport(server)) {
      throw new Error(
        "McpFn declaration createServer() did not return a server",
      );
    }
    return { manifest, server };
  }
  if (isRegistryExport(value)) {
    if (!info) {
      throw new Error("A registry source requires --name and --version");
    }
    return { manifest: validateManifest(createManifest(info, value)) };
  }
  return { manifest: validateManifest(value) };
}

export async function loadScenarios(
  file: string,
  cwd = process.cwd(),
): Promise<McpFnScenario[]> {
  const value = await loadModule(file, cwd);
  return validateMcpFnScenarios(value) as McpFnScenario[];
}

export async function loadClientProfileContracts(
  file: string,
  cwd = process.cwd(),
): Promise<RunMcpFnClientProfileContractsOptions> {
  const value = await loadModule(file, cwd);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Client profile contract config must export an options object",
    );
  }
  const options = value as Partial<RunMcpFnClientProfileContractsOptions>;
  if (!Array.isArray(options.profiles) || options.profiles.length === 0) {
    throw new Error("Client profile contract config must define profiles");
  }
  if (options.maxReportBytes !== undefined && (!Number.isSafeInteger(options.maxReportBytes) || options.maxReportBytes < 2049)) {
    throw new Error("Client profile maxReportBytes must be an integer of at least 2049");
  }
  if (options.allowSideEffects !== undefined) {
    throw new Error("Client profile side effects require the explicit --allow-side-effects CLI flag; remove allowSideEffects from config");
  }
  return options as RunMcpFnClientProfileContractsOptions;
}
