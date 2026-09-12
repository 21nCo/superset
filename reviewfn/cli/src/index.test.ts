import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runReview } from "./index.js";
const exec = promisify(execFile);

describe("end-to-end review", () => {
  it("freezes a change and produces a validated report", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewfn-"));
    await exec("git", ["init", "-b", "main"], { cwd });
    await writeFile(join(cwd, "requirements.md"), "# Requirements\n- Return a traceable review result\n"); await writeFile(join(cwd, "code.ts"), "export const result = 'traceable';\n");
    await exec("git", ["add", "."], { cwd }); await exec("git", ["-c", "user.email=reviewfn@example.test", "-c", "user.name=ReviewFn", "commit", "-m", "fixture"], { cwd, env: { ...process.env, TEMBO_BYPASS_GIT_RESTRICTIONS: "1" } });
    const harness = join(cwd, "harness.mjs"); await writeFile(harness, `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({evidence:[{id:'E1',kind:'code',path:'code.ts',detail:'implementation'}],assessments:[{requirementId:'REQ-001',status:'implemented',evidence:['E1'],summary:'implemented',confidence:1}],findings:[],coverageGaps:[]})));`);
    const report = await runReview(cwd, { base: "HEAD", requirementsFile: "requirements.md", harness: { command: process.execPath, args: [harness], provider: "fixture", model: "fixture", auth: "fixture" }, tests: [{ command: process.execPath, args: ["--check", "code.ts"] }] });
    expect(report.verdict).toBe("ready"); expect(report.change.head).toMatch(/^[a-f0-9]{40}$/); expect(report.tests[0].commit).toBe(report.change.head);
  });

  it("cannot turn malformed harness output into a passing review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewfn-")); await exec("git", ["init", "-b", "main"], { cwd }); await writeFile(join(cwd, "requirements.md"), "- A mandatory requirement exists\n"); await exec("git", ["add", "."], { cwd }); await exec("git", ["-c", "user.email=reviewfn@example.test", "-c", "user.name=ReviewFn", "commit", "-m", "fixture"], { cwd, env: { ...process.env, TEMBO_BYPASS_GIT_RESTRICTIONS: "1" } });
    const report = await runReview(cwd, { base: "HEAD", requirementsFile: "requirements.md", harness: { command: process.execPath, args: ["-e", "console.log('not json')"], provider: "fixture", model: "fixture", auth: "fixture" } });
    expect(report.execution).toBe("failed"); expect(report.verdict).toBeUndefined(); expect(report.coverage).toBe("incomplete");
  });

  it("treats structurally invalid JSON as incomplete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reviewfn-")); await exec("git", ["init", "-b", "main"], { cwd }); await writeFile(join(cwd, "requirements.md"), "- A mandatory requirement exists\n"); await exec("git", ["add", "."], { cwd }); await exec("git", ["-c", "user.email=reviewfn@example.test", "-c", "user.name=ReviewFn", "commit", "-m", "fixture"], { cwd, env: { ...process.env, TEMBO_BYPASS_GIT_RESTRICTIONS: "1" } });
    const report = await runReview(cwd, { base: "HEAD", requirementsFile: "requirements.md", harness: { command: process.execPath, args: ["-e", "console.log(JSON.stringify({evidence:[null],assessments:[],findings:[]}))"], provider: "fixture", model: "fixture", auth: "fixture" } });
    expect(report.coverage).toBe("incomplete"); expect(report.verdict).toBe("needs_verification"); expect(report.coverageGaps).toContain("evidence contains a non-object value");
  });
});
