#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ComposioLinearContextAdapter } from "@superfunctions/reviewfn-context-composio";
import { FileArtifactStore, RepositoryMarkdownContextAdapter, ReviewCoordinator, ReviewFnError, renderMarkdownReport, validateConfig, validatePolicy, type ContextAdapter, type ReviewFnConfig, type ReviewPolicy, type ReviewReport } from "@superfunctions/reviewfn-core";
import { GitHubAdvisoryPublisher, GitHubApi, GitSourceControlAdapter } from "@superfunctions/reviewfn-github";
import { CodexHarnessAdapter } from "@superfunctions/reviewfn-harness-codex";
import { evaluate, type EvaluationCase, type EvaluationOutcome } from "@superfunctions/reviewfn-testing";

import { initializeConfiguration, loadConfig, loadPolicy, loadTrustedConfigFromBase, loadTrustedPolicyFromBase } from "./config.js";
import { LocalIsolatedExecutionAdapter } from "./execution.js";

interface Arguments { command?: string; flags: Map<string, string | true>; positionals: string[] }

function parseArguments(argv: string[]): Arguments {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags.set(name, rest[++index]);
    else flags.set(name, true);
  }
  return { command, flags, positionals };
}

function required(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
}

function optional(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function configuration(root: string, base: string, flags: Map<string, string | true>): Promise<{ config: ReviewFnConfig; policy: ReviewPolicy }> {
  const trusted = flags.has("trusted-config-from-base") || process.env.GITHUB_ACTIONS === "true";
  const configRelative = optional(flags, "config") ?? ".reviewfn/config.json";
  const policyRelative = optional(flags, "policy") ?? ".reviewfn/policy.json";
  const config = trusted ? await loadTrustedConfigFromBase(root, base, configRelative) : await loadConfig(path.resolve(root, configRelative));
  const policy = trusted ? await loadTrustedPolicyFromBase(root, base, policyRelative) : await loadPolicy(path.resolve(root, policyRelative));
  if (config.output.mode !== policy.mode) throw new Error(`Configuration output mode ${config.output.mode} does not match trusted policy mode ${policy.mode}.`);
  return { config: validateConfig(config), policy: validatePolicy(policy) };
}

function contextAdapters(config: ReviewFnConfig): ContextAdapter[] {
  const adapters = new Map<string, ContextAdapter>();
  for (const item of config.context) {
    if (item.adapter === "repository-markdown") adapters.set(item.adapter, new RepositoryMarkdownContextAdapter());
    else if (item.adapter === "composio-linear") adapters.set(item.adapter, new ComposioLinearContextAdapter());
  }
  return [...adapters.values()];
}

async function createCoordinator(root: string, config: ReviewFnConfig, pullRequest?: number) {
  let publisher: GitHubAdvisoryPublisher | undefined;
  if (config.output.destinations.includes("github")) {
    const repository = process.env.GITHUB_REPOSITORY?.split("/");
    const token = process.env.GITHUB_TOKEN;
    if (!repository || repository.length !== 2 || !token || pullRequest === undefined) throw new Error("GitHub output requires GITHUB_REPOSITORY, GITHUB_TOKEN, and --pull-request.");
    publisher = new GitHubAdvisoryPublisher({ api: new GitHubApi({ owner: repository[0], repository: repository[1], token }), pullRequest });
  }
  const sourceControl = new GitSourceControlAdapter({ currentPullRequestHead: publisher ? () => publisher!.currentHead() : undefined });
  return new ReviewCoordinator({
    sourceControl,
    contexts: contextAdapters(config),
    harness: new CodexHarnessAdapter({ executable: config.harness.executable }),
    execution: new LocalIsolatedExecutionAdapter(),
    artifacts: new FileArtifactStore(path.resolve(root, ".reviewfn/artifacts")),
    publishers: publisher ? [publisher] : [],
  });
}

async function run(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const root = path.resolve(optional(args.flags, "root") ?? process.cwd());
  if (!args.command || args.command === "help" || args.flags.has("help")) { process.stdout.write(help()); return 0; }
  if (args.command === "init") {
    const files = await initializeConfiguration(root);
    process.stdout.write(`${files.map((file) => path.relative(root, file)).join("\n")}\n`);
    return 0;
  }
  if (args.command === "render") {
    const input = path.resolve(root, required(args.flags, "input"));
    process.stdout.write(renderMarkdownReport(JSON.parse(await readFile(input, "utf8")) as ReviewReport));
    return 0;
  }
  if (args.command === "evaluate") {
    const input = JSON.parse(await readFile(path.resolve(root, required(args.flags, "input")), "utf8")) as { cases: EvaluationCase[]; outcomes: EvaluationOutcome[] };
    process.stdout.write(`${JSON.stringify(evaluate(input.cases, input.outcomes), null, 2)}\n`);
    return 0;
  }
  if (!["preflight", "review"].includes(args.command)) throw new Error(`Unknown command ${args.command}.`);
  const base = required(args.flags, "base");
  const head = required(args.flags, "head");
  const pullRequestText = optional(args.flags, "pull-request") ?? process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER;
  const pullRequest = pullRequestText === undefined ? undefined : Number(pullRequestText);
  if (pullRequestText !== undefined && (!Number.isInteger(pullRequest) || pullRequest! <= 0)) throw new Error("--pull-request must be a positive integer.");
  const { config, policy } = await configuration(root, base, args.flags);
  const coordinator = await createCoordinator(root, config, pullRequest);
  const request = { root, base, head, pullRequest, config, policy, issue: optional(args.flags, "issue") };
  if (args.command === "preflight") {
    const diagnostics = await coordinator.preflight(request);
    process.stdout.write(`${JSON.stringify({ ok: !diagnostics.some((item) => item.level === "error"), diagnostics }, null, 2)}\n`);
    return diagnostics.some((item) => item.level === "error") ? 1 : 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await coordinator.run({ ...request, signal: controller.signal });
    const outputDirectory = path.resolve(root, optional(args.flags, "output") ?? ".reviewfn/output");
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
      writeFile(path.join(outputDirectory, "report.md"), result.rendered),
    ]);
    process.stdout.write(`${result.rendered}\n`);
    return 0;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function help(): string {
  return `ReviewFn — evidence-backed pull request review\n\nUsage:\n  reviewfn init [--root PATH]\n  reviewfn preflight --base REF --head REF [--issue ID] [--trusted-config-from-base]\n  reviewfn review --base REF --head REF [--pull-request N] [--issue ID] [--output DIR]\n  reviewfn render --input report.json\n  reviewfn evaluate --input evaluation.json\n\nReview is advisory by default. Configuration and policy are loaded from .reviewfn/.\n`;
}

run().then((code) => { process.exitCode = code; }).catch((error) => {
  const payload = error instanceof ReviewFnError ? { error: error.code, message: error.message, details: error.details } : { error: "REVIEWFN_UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
