import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { cac } from "cac";
import { diagnoseMcpAuthorization } from "@mcpfn/auth";
import {
  stdioTarget,
  streamableHttpTarget,
  McpFnClientError,
  type McpFnTarget,
} from "@mcpfn/client";
import {
  diffManifests,
  validateManifest,
  type McpFnManifest,
} from "@mcpfn/core";
import { McpFnInspector } from "@mcpfn/inspector";
import {
  McpFnTestClient,
  McpFnAssertionError,
  assertManifestContract,
  authenticatedHttpTarget,
  beginTargetCredentialRedaction,
  redactTargetCredentials,
  createMcpFnTargetSuiteJUnit,
  runAuthenticatedOfficialConformance,
  runOfficialConformance,
  runMcpFnTargetSuite,
  runScenarios,
  createMcpFnScenarioReport,
  type McpFnRemoteCredential,
} from "@mcpfn/testing";

import { loadManifestSource, loadScenarios } from "./load.js";

export { loadManifestSource, loadScenarios };

export interface CliRunOptions {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

declare const __MCPFN_CLI_VERSION__: string;

export const MCPFN_CLI_EXIT_SUCCESS = 0;
export const MCPFN_CLI_EXIT_TEST_FAILURE = 1;
export const MCPFN_CLI_EXIT_USAGE = 2;
export const MCPFN_CLI_VERSION = __MCPFN_CLI_VERSION__;

interface RemoteAuthCliOptions {
  bearerTokenEnv?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: string;
}

export async function runCli(
  argv = process.argv.slice(2),
  runOptions: CliRunOptions = {},
): Promise<number> {
  const cwd = runOptions.cwd ?? process.cwd();
  const stdout = runOptions.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = runOptions.stderr ?? ((text: string) => process.stderr.write(text));
  let exitCode = 0;
  const cli = cac("mcpfn");

  cli.command("manifest <source>", "Generate a canonical manifest from a server or registry module")
    .option("--output <path>", "Write the manifest to a file")
    .option("--name <name>", "Server name when source exports a registry")
    .option("--version <version>", "Server version when source exports a registry")
    .action(async (source: string, options: { output?: string; name?: string; version?: string }) => {
      const info = options.name && options.version
        ? { name: options.name, version: options.version }
        : undefined;
      const { manifest } = await loadManifestSource(source, cwd, info);
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
      if (options.output) {
        const outputPath = path.resolve(cwd, options.output);
        await writeFile(outputPath, serialized, "utf8");
        stdout(`Wrote ${outputPath}\n`);
      } else {
        stdout(serialized);
      }
    });

  cli.command("validate <manifest>", "Validate a canonical McpFn manifest and its hash")
    .action(async (manifestPath: string) => {
      const parsed = JSON.parse(await readFile(path.resolve(cwd, manifestPath), "utf8"));
      const manifest = validateManifest(parsed);
      stdout(`Valid McpFn manifest ${manifest.server.name}@${manifest.server.version} (${manifest.hash})\n`);
    });

  cli.command("diff <before> <after>", "Classify MCP contract changes")
    .option("--json", "Print machine-readable JSON")
    .option("--fail-on-behavioral", "Fail when descriptions, titles, or annotations change")
    .action(async (
      beforePath: string,
      afterPath: string,
      options: { json?: boolean; failOnBehavioral?: boolean },
    ) => {
      const read = async (file: string): Promise<McpFnManifest> =>
        validateManifest(JSON.parse(await readFile(path.resolve(cwd, file), "utf8")));
      const result = diffManifests(await read(beforePath), await read(afterPath));
      if (options.json) {
        stdout(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout(`breaking=${result.summary.breaking} additive=${result.summary.additive} behavioral=${result.summary.behavioral}\n`);
        for (const change of result.changes) {
          stdout(`${change.severity.toUpperCase()} ${change.code} ${change.path}: ${change.message}\n`);
        }
      }
      if (!result.compatible || (options.failOnBehavioral && result.summary.behavioral > 0)) {
        exitCode = 1;
      }
    });

  cli.command("test <server> <scenarios>", "Run protocol-level semantic regression scenarios")
    .option("--output <path>", "Write a JSON report")
    .option("--max-report-bytes <bytes>", "Maximum aggregate JSON report size")
    .option(
      "--visible-tools <names>",
      "Comma-separated tool names expected for a request-filtered server",
    )
    .action(async (
      serverPath: string,
      scenariosPath: string,
      options: { output?: string; visibleTools?: string; maxReportBytes?: string },
    ) => {
      const loaded = await loadManifestSource(serverPath, cwd, undefined, {
        taskStore: new InMemoryTaskStore(),
      });
      if (!loaded.server) {
        throw new Error("The test command requires a module exporting McpFnServer");
      }
      const client = await McpFnTestClient.connect(loaded.server);
      try {
        await assertManifestContract(client, loaded.manifest, {
          expectedToolNames: options.visibleTools
            ?.split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        });
        const results = await runScenarios(client, await loadScenarios(scenariosPath, cwd));
        const outputMaxBytes = parsePositiveInteger(
          options.maxReportBytes,
          "--max-report-bytes",
        );
        if (outputMaxBytes !== undefined && outputMaxBytes < 1_025) {
          throw new Error("--max-report-bytes must be an integer of at least 1025");
        }
        const report = createMcpFnScenarioReport(results, {
          manifestHash: loaded.manifest.hash,
          maxBytes: outputMaxBytes === undefined ? undefined : outputMaxBytes - 1,
        });
        const serialized = outputMaxBytes === undefined
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${JSON.stringify(report)}\n`;
        if (options.output) {
          await writeFile(path.resolve(cwd, options.output), serialized, "utf8");
        }
        stdout(serialized);
        if (report.failed > 0 || report.status === "incomplete") exitCode = 1;
      } finally {
        await client.close();
      }
    });

  cli.command("conformance <url>", "Run the official MCP conformance package against a server")
    .option("--suite <suite>", "active, all, or pending")
    .option("--scenario <scenario>", "Run one official scenario")
    .option("--expected-failures <path>", "Expected-failures baseline")
    .option("--output-dir <path>", "Directory for official conformance artifacts")
    .option("--spec-version <version>", "MCP specification version")
    .option("--bearer-token-env <name>", "Read an OAuth Bearer token from an environment variable")
    .option("--api-key-env <name>", "Read an API key from an environment variable")
    .option("--api-key-header <name>", "API-key header name (default: x-api-key)")
    .option("--report <path>", "Write the redacted McpFn conformance report")
    .option("--max-report-bytes <bytes>", "Maximum aggregate McpFn report size")
    .option("--verbose", "Show official runner diagnostics")
    .action(async (url: string, options: {
      suite?: "active" | "all" | "pending";
      scenario?: string;
      expectedFailures?: string;
      outputDir?: string;
      specVersion?: string;
      report?: string;
      maxReportBytes?: string;
      verbose?: boolean;
    } & RemoteAuthCliOptions) => {
      const maxBytes = parseCliReportCap(options.maxReportBytes);
      if (options.maxReportBytes !== undefined && !options.report) {
        throw new Error("--max-report-bytes requires --report for conformance");
      }
      const auth = readRemoteCredential(options);
      const conformanceOptions = {
        url,
        suite: options.suite,
        scenario: options.scenario,
        expectedFailures: options.expectedFailures
          ? path.resolve(cwd, options.expectedFailures)
          : undefined,
        outputDir: options.outputDir ? path.resolve(cwd, options.outputDir) : undefined,
        specVersion: options.specVersion,
        verbose: options.verbose,
        cwd,
        stdio: "pipe",
        ...(auth ? { sensitiveEnvironmentVariables: [auth.environmentName] } : {}),
      } as const;
      const result = auth
        ? await runAuthenticatedOfficialConformance({
          ...conformanceOptions,
          credential: auth.credential,
        })
        : await runOfficialConformance(conformanceOptions);
      if (result.stdout) stdout(result.stdout);
      if (result.stderr) stderr(result.stderr);
      if (options.report) {
        await writeFile(
          path.resolve(cwd, options.report),
          serializeBoundedReport(result, maxBytes),
          "utf8",
        );
      }
      exitCode = result.exitCode;
    });

  cli.command("inspect <target>", "Inventory an HTTP or stdio MCP target")
    .option("--stdio", "Treat target as an executable instead of an HTTP URL")
    .option("--args <json>", "JSON array of stdio executable arguments")
    .option("--output <path>", "Write the redacted JSON snapshot")
    .option("--bearer-token-env <name>", "Read an OAuth Bearer token from an environment variable")
    .option("--api-key-env <name>", "Read an API key from an environment variable")
    .option("--api-key-header <name>", "API-key header name (default: x-api-key)")
    .action(async (targetValue: string, options: {
      stdio?: boolean;
      args?: string;
      output?: string;
    } & RemoteAuthCliOptions) => {
      const target = parseTarget(targetValue, options, cwd);
      const inspector = McpFnInspector.create({ target });
      const finishRedaction = beginTargetCredentialRedaction(target);
      try {
        await inspector.connect();
        const serialized = `${JSON.stringify(redactTargetCredentials(target, await inspector.snapshot()), null, 2)}\n`;
        if (options.output) {
          await writeFile(path.resolve(cwd, options.output), serialized, "utf8");
        }
        stdout(serialized);
      } finally {
        try { await inspector.close(); } finally { finishRedaction(); }
      }
    });

  cli.command("test-target <target> <scenarios>", "Run scenarios against an HTTP or stdio MCP target")
    .option("--stdio", "Treat target as an executable instead of an HTTP URL")
    .option("--args <json>", "JSON array of stdio executable arguments")
    .option("--output <path>", "Write the JSON report")
    .option("--junit <path>", "Write a bounded, redacted JUnit report")
    .option("--manifest <path>", "Validate an optional explicit manifest against live inventory")
    .option("--max-report-bytes <bytes>", "Maximum aggregate JSON/JUnit report size")
    .option(
      "--visible-tools <names>",
      "Comma-separated tool names expected for a request-filtered server",
    )
    .option("--bearer-token-env <name>", "Read an OAuth Bearer token from an environment variable")
    .option("--api-key-env <name>", "Read an API key from an environment variable")
    .option("--api-key-header <name>", "API-key header name (default: x-api-key)")
    .action(async (targetValue: string, scenariosPath: string, options: {
      stdio?: boolean;
      args?: string;
      output?: string;
      junit?: string;
      manifest?: string;
      maxReportBytes?: string;
      visibleTools?: string;
    } & RemoteAuthCliOptions) => {
      const maxReportBytes = parseCliReportCap(options.maxReportBytes);
      const manifest = options.manifest
        ? validateManifest(JSON.parse(
          await readFile(path.resolve(cwd, options.manifest), "utf8"),
        ))
        : undefined;
      const report = await runMcpFnTargetSuite({
        target: parseTarget(targetValue, options, cwd),
        scenarios: await loadScenarios(scenariosPath, cwd),
        manifest,
        expectedToolNames: options.visibleTools
          ?.split(",")
          .map((name) => name.trim())
          .filter(Boolean),
        maxReportBytes: (maxReportBytes ?? 1_048_576) - 1,
      });
      const serialized = serializeBoundedReport(report, maxReportBytes);
      if (options.output) {
        await writeFile(path.resolve(cwd, options.output), serialized, "utf8");
      }
      if (options.junit) {
        await writeFile(
          path.resolve(cwd, options.junit),
          createMcpFnTargetSuiteJUnit(report, {
            maxBytes: maxReportBytes === undefined ? undefined : maxReportBytes - 1,
          }),
          "utf8",
        );
      }
      stdout(serialized);
      if (!report.ok) exitCode = 1;
    });

  cli.command("auth-diagnose <url>", "Probe OAuth discovery without opening a browser")
    .option("--timeout <milliseconds>", "Per-request timeout in milliseconds")
    .option("--output <path>", "Write the redacted JSON report")
    .action(async (url: string, options: { timeout?: string; output?: string }) => {
      const timeoutMs = options.timeout === undefined
        ? undefined
        : parsePositiveInteger(options.timeout, "--timeout");
      const report = await diagnoseMcpAuthorization(url, { timeoutMs });
      const serialized = `${JSON.stringify(report, null, 2)}\n`;
      if (options.output) {
        await writeFile(path.resolve(cwd, options.output), serialized, "utf8");
      }
      stdout(serialized);
      if (!report.ok) exitCode = 1;
    });

  cli.help();
  cli.version(MCPFN_CLI_VERSION);
  try {
    const parsed = cli.parse(["node", "mcpfn", ...argv], { run: false });
    if (!cli.matchedCommand) {
      if (parsed.options.help || parsed.options.version) return 0;
      stderr(argv.length ? `Unknown command: ${argv[0]}\n` : "A command is required\n");
      return 2;
    }
    await cli.runMatchedCommand();
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof McpFnAssertionError || error instanceof McpFnClientError) {
      return MCPFN_CLI_EXIT_TEST_FAILURE;
    }
    return MCPFN_CLI_EXIT_USAGE;
  }
  return exitCode;
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseCliReportCap(value: string | undefined): number | undefined {
  const parsed = parsePositiveInteger(value, "--max-report-bytes");
  if (parsed !== undefined && parsed < 1_025) {
    throw new Error("--max-report-bytes must be an integer of at least 1025");
  }
  return parsed;
}

function serializeBoundedReport(value: unknown, maxBytes?: number): string {
  const serialize = (candidate: unknown) => `${JSON.stringify(candidate, null, 2)}\n`;
  let serialized = serialize(value);
  if (maxBytes === undefined || new TextEncoder().encode(serialized).byteLength <= maxBytes) {
    return serialized;
  }
  if (
    value && typeof value === "object" &&
    (value as { kind?: unknown }).kind === "mcpfn.official-conformance-report"
  ) {
    const bounded = structuredClone(value) as {
      stdout?: string;
      stderr?: string;
      failure?: { message?: string; details?: unknown };
    };
    bounded.stdout = bounded.stdout ? "[TRUNCATED]" : "";
    bounded.stderr = bounded.stderr ? "[TRUNCATED]" : "";
    if (bounded.failure) {
      bounded.failure.message = bounded.failure.message ? Array.from(bounded.failure.message).slice(0, 64).join("") : undefined;
      bounded.failure.details = undefined;
    }
    serialized = serialize(bounded);
    if (new TextEncoder().encode(serialized).byteLength <= maxBytes) return serialized;
  }
  throw new Error("Serialized report exceeds --max-report-bytes");
}

function readRemoteCredential(
  options: RemoteAuthCliOptions,
): { credential: McpFnRemoteCredential; environmentName: string } | undefined {
  if (options.bearerTokenEnv && options.apiKeyEnv) {
    throw new Error("Use only one of --bearer-token-env or --api-key-env");
  }
  if (options.apiKeyHeader && !options.apiKeyEnv) {
    throw new Error("--api-key-header requires --api-key-env");
  }
  const environmentName = options.bearerTokenEnv ?? options.apiKeyEnv;
  if (!environmentName) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    throw new Error("Credential environment variable names must be portable identifiers");
  }
  const value = process.env[environmentName];
  if (value === undefined || value.length === 0) {
    throw new Error(`Credential environment variable ${environmentName} is missing or empty`);
  }
  if (options.bearerTokenEnv) {
    return {
      environmentName,
      credential: {
        kind: "oauth",
        headers: { authorization: `Bearer ${value}` },
      },
    };
  }
  const headerName = options.apiKeyHeader ?? "x-api-key";
  try {
    new Headers({ [headerName]: value });
  } catch {
    throw new Error("--api-key-header must be a valid HTTP header name");
  }
  return {
    environmentName,
    credential: { kind: "api-key", headers: { [headerName]: value } },
  };
}

function parseTarget(
  targetValue: string,
  options: { stdio?: boolean; args?: string } & RemoteAuthCliOptions,
  cwd: string,
): McpFnTarget {
  if (!options.stdio) {
    if (options.args) throw new Error("--args requires --stdio");
    const auth = readRemoteCredential(options);
    return auth
      ? authenticatedHttpTarget(targetValue, { credential: auth.credential })
      : streamableHttpTarget(targetValue);
  }
  if (options.bearerTokenEnv || options.apiKeyEnv || options.apiKeyHeader) {
    throw new Error("Credential options require an HTTP target");
  }
  let args: string[] | undefined;
  if (options.args) {
    const parsed = JSON.parse(options.args) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("--args must be a JSON array of strings");
    }
    args = parsed;
  }
  return stdioTarget({ command: targetValue, args, cwd });
}
