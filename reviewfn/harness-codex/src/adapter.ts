import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { harnessOutputSchema, redactText, type HarnessAdapter, type HarnessCapabilities, type HarnessInput, type HarnessOutput, type JsonValue, type NormalizedRunEvent, type PreflightResult, type ReviewFnConfig } from "@superfunctions/reviewfn-core";

export interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; canceled: boolean }
export type CommandRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let total = 0;
  let timedOut = false;
  let canceled = false;
  const terminate = (reason: "timeout" | "cancel") => {
    timedOut ||= reason === "timeout";
    canceled ||= reason === "cancel";
    try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid!, "SIGTERM"); } catch { /* already exited */ }
    setTimeout(() => { try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } }, 1_000).unref();
  };
  const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
  const onAbort = () => terminate("cancel");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    total += chunk.length;
    if (total > options.maxOutputBytes) { terminate("timeout"); return; }
    if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({ code, signal, stdout, stderr, timedOut, canceled });
  });
});

export interface CodexHarnessOptions {
  executable?: string;
  runner?: CommandRunner;
  environment?: NodeJS.ProcessEnv;
}

export class CodexHarnessAdapter implements HarnessAdapter {
  public readonly capabilities: HarnessCapabilities = {
    id: "codex",
    version: "1",
    providers: ["openai"],
    authModes: ["api-key", "chatgpt", "access-token", "workload-identity", "action-proxy"],
    structuredOutput: true,
    observableEvents: true,
    usageMetrics: true,
    cancellation: true,
    toolControls: true,
    sandboxModes: ["read-only"],
  };
  private readonly runner: CommandRunner;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(options: CodexHarnessOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.executable = options.executable ?? "codex";
    this.environment = options.environment ?? process.env;
  }

  public async preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult> {
    const diagnostics: PreflightResult["diagnostics"] = [];
    if (config.harness.adapter !== this.capabilities.id) diagnostics.push({ code: "REVIEWFN_HARNESS_MISMATCH", level: "error", message: `Configured harness ${config.harness.adapter} does not match codex.` });
    if (!this.capabilities.providers.includes(config.inference.provider)) diagnostics.push({ code: "REVIEWFN_PROVIDER_UNSUPPORTED", level: "error", message: `Provider ${config.inference.provider} is unsupported by this adapter.` });
    if (!this.capabilities.authModes.includes(config.inference.auth)) diagnostics.push({ code: "REVIEWFN_AUTH_UNSUPPORTED", level: "error", message: `Auth mode ${config.inference.auth} is unsupported by this adapter.` });
    const credential = config.inference.credentialEnv;
    if (config.inference.auth === "api-key" && (!credential || !this.environment[credential])) diagnostics.push({ code: "REVIEWFN_CREDENTIAL_MISSING", level: "error", message: "API-key auth requires a populated credentialEnv available only to the harness process." });
    if (config.inference.auth === "api-key") diagnostics.push({ code: "REVIEWFN_API_KEY_LOCAL_TRUST", level: "warning", message: "Raw API-key CLI execution is for trusted local workspaces only; CI should use the official Codex Action proxy." });
    if (config.inference.auth === "action-proxy" && !this.environment.OPENAI_BASE_URL && !this.environment.CODEX_API_BASE_URL) diagnostics.push({ code: "REVIEWFN_PROXY_REQUIRED", level: "error", message: "action-proxy auth requires OPENAI_BASE_URL or CODEX_API_BASE_URL." });
    const version = await this.runner(this.executableFor(config), ["--version"], { cwd: process.cwd(), env: minimalEnvironment(this.environment, config), timeoutMs: 10_000, maxOutputBytes: 64_000, signal }).catch((error) => ({ code: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, canceled: false }));
    if (version.code !== 0) diagnostics.push({ code: "REVIEWFN_CODEX_UNAVAILABLE", level: "error", message: `Codex executable is unavailable: ${version.stderr.trim() || `exit ${String(version.code)}`}.` });
    return { ok: diagnostics.every((item) => item.level !== "error"), resolved: diagnostics.some((item) => item.level === "error") ? undefined : { provider: config.inference.provider, model: config.inference.model, auth: config.inference.auth, harnessVersion: version.stdout.trim() || "unknown" }, diagnostics };
  }

  public async run(input: HarnessInput): Promise<HarnessOutput> {
    if (input.change.pullRequest !== undefined && input.configuration.inference.auth === "api-key") {
      return emptyFailure("failed", "Raw API-key authentication is forbidden for pull-request review because untrusted repository content could expose the credential. Use action-proxy authentication.");
    }
    const forbiddenInstructionChanges = input.change.changedPaths.filter((changed) => /(^|\/)(AGENTS\.md|\.codex\/|\.agents\/|\.claude\/)/i.test(changed));
    if (forbiddenInstructionChanges.length) return emptyFailure("failed", `Review target changes auto-loaded instruction/configuration paths: ${forbiddenInstructionChanges.join(", ")}. Trusted policy refuses inference.`);
    const directory = await mkdtemp(path.join(tmpdir(), "reviewfn-codex-"));
    const schemaPath = path.join(directory, "schema.json");
    const outputPath = path.join(directory, "result.json");
    await writeFile(schemaPath, JSON.stringify(harnessOutputSchema, null, 2), { mode: 0o600 });
    const args = ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--output-schema", schemaPath, "--output-last-message", outputPath];
    if (input.configuration.inference.model !== "configured") args.push("--model", input.configuration.inference.model);
    args.push(input.prompt);
    try {
      const result = await this.runner(this.executableFor(input.configuration), args, { cwd: input.workspace, env: minimalEnvironment(this.environment, input.configuration), timeoutMs: input.policy.limits.harnessTimeoutMs, maxOutputBytes: input.policy.limits.maxOutputBytes, signal: input.signal });
      const secrets = input.configuration.inference.credentialEnv ? [this.environment[input.configuration.inference.credentialEnv] ?? ""] : [];
      const events = normalizeEvents(redactText(result.stdout, secrets));
      const stderr = redactText(result.stderr, secrets);
      if (result.canceled) return { ...emptyFailure("canceled", "Codex run was canceled."), events, transcript: `${result.stdout}\n${stderr}` };
      if (result.timedOut) return { ...emptyFailure("timed_out", "Codex run exceeded its configured bound."), events, transcript: `${result.stdout}\n${stderr}` };
      if (result.code !== 0) {
        const terminal = /quota|rate.?limit|usage.?limit/i.test(stderr) ? "quota_exhausted" as const : "failed" as const;
        return { ...emptyFailure(terminal, stderr.trim() || `Codex exited with ${String(result.code)}.`), events, transcript: `${result.stdout}\n${stderr}` };
      }
      const text = await readFile(outputPath, "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(text) as Omit<HarnessOutput, "terminal" | "events" | "transcript">;
        return { terminal: "completed", requirements: parsed.requirements, assessments: parsed.assessments, evidence: parsed.evidence, findings: parsed.findings, inspectedPaths: parsed.inspectedPaths, uninspected: parsed.uninspected, events, transcript: `${result.stdout}\n${stderr}` };
      } catch (error) {
        return { ...emptyFailure("malformed", `Codex output was not valid structured JSON: ${error instanceof Error ? error.message : String(error)}`), events, transcript: `${result.stdout}\n${stderr}` };
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private executableFor(config: ReviewFnConfig): string { return config.harness.executable ?? this.executable; }
}

function minimalEnvironment(source: NodeJS.ProcessEnv, config: ReviewFnConfig): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  if (["chatgpt", "access-token"].includes(config.inference.auth)) allowed.push("HOME", "CODEX_HOME");
  if (config.inference.auth === "workload-identity") allowed.push("OPENAI_WORKLOAD_IDENTITY_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL");
  if (config.inference.auth === "action-proxy") allowed.push("OPENAI_BASE_URL", "CODEX_API_BASE_URL");
  if (config.inference.credentialEnv) allowed.push(config.inference.credentialEnv);
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function emptyFailure(terminal: HarnessOutput["terminal"], error: string): HarnessOutput {
  return { terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error }], events: [], error };
}

function normalizeEvents(jsonl: string): NormalizedRunEvent[] {
  const events: NormalizedRunEvent[] = [];
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const rawType = typeof raw.type === "string" ? raw.type : "unknown";
      const type: NormalizedRunEvent["type"] = rawType.includes("error") || rawType.includes("failed") ? "error" : rawType.includes("completed") ? "completed" : rawType.includes("started") && rawType.includes("item") ? "tool_started" : rawType === "turn.started" || rawType === "thread.started" ? "started" : rawType.includes("message") ? "message" : "warning";
      events.push({ sequence: events.length, at: new Date().toISOString(), type, data: JSON.parse(JSON.stringify(raw)) as Record<string, JsonValue> });
    } catch {
      events.push({ sequence: events.length, at: new Date().toISOString(), type: "warning", data: { message: "Unparseable Codex event was discarded." } });
    }
  }
  return events;
}
