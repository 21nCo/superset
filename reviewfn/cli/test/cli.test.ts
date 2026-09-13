import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@superfunctions/reviewfn-core";
import { initializeConfiguration, loadConfig } from "../src/config.js";
import { LocalIsolatedExecutionAdapter } from "../src/execution.js";

const execFileAsync = promisify(execFile);

describe("configuration", () => {
  it("initializes complete versioned defaults without overwriting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reviewfn-config-test-"));
    const files = await initializeConfiguration(root);
    expect(files).toHaveLength(2);
    expect((await loadConfig(path.join(root, ".reviewfn/config.json"))).version).toBe(1);
    await expect(initializeConfiguration(root)).rejects.toThrow(/overwrite/);
  });
  it("times out the process group and removes its owned checkout", async () => {
    const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).stdout.trim();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const bounded = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, testTimeoutMs: 100 } };
    const receipts = await new LocalIsolatedExecutionAdapter().run(root, head, [[process.execPath, "-e", "setInterval(() => {}, 1000)"]], bounded);
    expect(receipts[0].timedOut).toBe(true);
    const worktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout;
    expect(worktrees).not.toContain("reviewfn-execution-");
  });
});

describe("isolated execution", () => {
  it("runs an argv command at the exact commit with a secret-free environment", async () => {
    const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).stdout.trim();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    process.env.REVIEWFN_TEST_SECRET = "do-not-copy";
    const receipts = await new LocalIsolatedExecutionAdapter().run(root, head, [[process.execPath, "-e", "if(process.env.REVIEWFN_TEST_SECRET)process.exit(8)"]], DEFAULT_POLICY);
    expect(receipts[0].exitCode).toBe(0);
    expect(receipts[0].commit).toBe(head);
  });
  it("records failures instead of calling them passes", async () => {
    const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })).stdout.trim();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const receipts = await new LocalIsolatedExecutionAdapter().run(root, head, [[process.execPath, "-e", "process.exit(7)"]], DEFAULT_POLICY);
    expect(receipts[0].exitCode).toBe(7);
  });
});
