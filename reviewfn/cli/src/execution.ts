import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256, type ExecutionAdapter, type PreflightResult, type ReviewPolicy, type TestReceipt } from "@superfunctions/reviewfn-core";

interface ProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; canceled: boolean; runtimeMs: number }

export class LocalIsolatedExecutionAdapter implements ExecutionAdapter {
  public readonly id = "local-isolated";

  public async preflight(root: string): Promise<PreflightResult> {
    const diagnostics: PreflightResult["diagnostics"] = [];
    if (Number(process.versions.node.split(".")[0]) < 22) diagnostics.push({ code: "REVIEWFN_NODE_VERSION", level: "error", message: `Node 22 or newer is required; found ${process.versions.node}.` });
    const git = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], root, 10_000, 64_000).catch((error) => ({ exitCode: null, stderr: error instanceof Error ? error.message : String(error) }));
    if (git.exitCode !== 0) diagnostics.push({ code: "REVIEWFN_GIT_REQUIRED", level: "error", message: `Git worktree is required: ${git.stderr}.` });
    if (process.platform === "win32") diagnostics.push({ code: "REVIEWFN_WINDOWS_ISOLATION", level: "warning", message: "Windows process-tree termination is best-effort; use an ephemeral CI runner or container for untrusted tests." });
    return { ok: diagnostics.every((item) => item.level !== "error"), diagnostics };
  }

  public async run(root: string, headCommit: string, commands: string[][], policy: ReviewPolicy, signal?: AbortSignal): Promise<TestReceipt[]> {
    if (!commands.length) return [];
    if (!/^[a-f0-9]{40,64}$/i.test(headCommit)) throw new Error("Execution requires an immutable commit hash.");
    const owned = await mkdtemp(path.join(tmpdir(), "reviewfn-execution-"));
    const checkout = path.join(owned, "checkout");
    const receipts: TestReceipt[] = [];
    try {
      const added = await runProcess("git", ["worktree", "add", "--detach", checkout, headCommit], root, 60_000, 1_000_000, signal);
      if (added.exitCode !== 0) throw new Error(`Unable to create isolated worktree: ${added.stderr}`);
      for (const [index, command] of commands.entries()) {
        if (signal?.aborted) break;
        if (!command.length || command.some((part) => part.includes("\0"))) throw new Error(`Invalid test command at index ${index}.`);
        const startedAt = new Date();
        const result = await runProcess(command[0], command.slice(1), checkout, Math.min(policy.limits.testTimeoutMs, policy.limits.harnessTimeoutMs), policy.limits.maxOutputBytes, signal, sanitizedTestEnvironment());
        const finishedAt = new Date(startedAt.getTime() + result.runtimeMs);
        receipts.push({
          id: `test-${index}-${sha256(JSON.stringify(command)).slice(0, 12)}`,
          command,
          cwd: ".",
          commit: headCommit,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          runtimeMs: result.runtimeMs,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          canceled: result.canceled,
          stdoutDigest: sha256(result.stdout),
          stderrDigest: sha256(result.stderr),
          limitations: result.timedOut ? ["Command exceeded its configured timeout."] : result.canceled ? ["Command was canceled."] : [],
        });
      }
      return receipts;
    } finally {
      const resolvedOwned = await realpath(owned).catch(() => owned);
      const resolvedCheckout = await realpath(checkout).catch(() => checkout);
      if (resolvedCheckout === path.join(resolvedOwned, "checkout") && resolvedOwned.startsWith(await realpath(tmpdir()))) {
        await runProcess("git", ["worktree", "remove", "--force", checkout], root, 60_000, 1_000_000).catch(() => undefined);
        await rm(owned, { recursive: true, force: true });
      }
    }
  }
}

function sanitizedTestEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CI", "NODE_OPTIONS"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let canceled = false;
    const terminate = (reason: "timeout" | "cancel") => {
      timedOut ||= reason === "timeout";
      canceled ||= reason === "cancel";
      try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 1_000).unref();
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const abort = () => terminate("cancel");
    signal?.addEventListener("abort", abort, { once: true });
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { terminate("timeout"); return; }
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ exitCode, signal: exitSignal, stdout, stderr, timedOut, canceled, runtimeMs: Date.now() - started });
    });
  });
}
