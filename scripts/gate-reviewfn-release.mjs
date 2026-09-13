#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packages = ["core", "context-composio", "harness-codex", "github", "testing", "cli"];
const packageName = (name) => `@superfunctions/reviewfn-${name}`;
const results = [];

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(JSON.stringify({ ok: false, error: `Node 22 or newer is required; found ${process.versions.node}.` }));
  process.exit(1);
}

function run(name, command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) }, encoding: "utf8", stdio: "pipe", shell: false, maxBuffer: 50 * 1024 * 1024 });
  const record = { name, command: [command, ...args].join(" "), ok: result.status === 0, status: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
  results.push(record);
  if (!record.ok) throw new Error(`${name} failed\n${record.stdout}\n${record.stderr}`);
  return record;
}

function npm(name, args, cwd = root) { return run(name, process.platform === "win32" ? "npm.cmd" : "npm", args, cwd); }

function verifyDocs() {
  const required = ["reviewfn/README.md", "reviewfn/ADR-0001-FIRST-RELEASE.md", "reviewfn/docs/configuration.md", "reviewfn/docs/security.md", "reviewfn/docs/github-action.md", "reviewfn/docs/report-schema.md", "reviewfn/docs/evaluation.md", "reviewfn/github/action.yml", "reviewfn/evaluation/data6-pr153.json", "reviewfn/evaluation/data6-pr153-metrics.json", "reviewfn/evaluation/data6-pr153-baseline.md"];
  const problems = [];
  for (const file of required) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/.test(text)) problems.push(`${file}: machine-specific path`);
    if (/\b(?:TODO|FIXME|placeholder|coming soon)\b/i.test(text)) problems.push(`${file}: deferred content`);
  }
  const evaluation = JSON.parse(readFileSync(path.join(root, "reviewfn/evaluation/data6-pr153.json"), "utf8"));
  const metrics = JSON.parse(readFileSync(path.join(root, "reviewfn/evaluation/data6-pr153-metrics.json"), "utf8"));
  const action = readFileSync(path.join(root, "reviewfn/github/action.yml"), "utf8");
  const historicalCase = evaluation.cases?.[0];
  if (!historicalCase?.retrospective || !/^[a-f0-9]{40}$/.test(evaluation.pullRequest?.base ?? "") || !/^[a-f0-9]{40}$/.test(evaluation.pullRequest?.head ?? "")) problems.push("historical evaluation: exact retrospective snapshot metadata is required");
  if (metrics.sampleSize !== evaluation.cases?.length || !Array.isArray(metrics.limitations) || metrics.limitations.length === 0) problems.push("historical evaluation: metrics and limitations are required");
  if (action.includes("openai-api-key") || action.includes("CODEX_API_KEY") || !action.includes("codex-api-base-url")) problems.push("GitHub Action: raw model keys are forbidden and a credential-isolating proxy input is required");
  if (problems.length) throw new Error(`Documentation validation failed: ${problems.join(", ")}`);
  results.push({ name: "documentation", command: "internal documentation validation", ok: true, status: 0, stdout: required.join("\n"), stderr: "" });
}

const temporary = mkdtempSync(path.join(tmpdir(), "reviewfn-release-"));
try {
  for (const name of packages) npm(`build:${name}`, ["run", "build", "--workspace", packageName(name)]);
  for (const name of packages) npm(`typecheck:${name}`, ["run", "typecheck", "--workspace", packageName(name)]);
  for (const name of packages) npm(`test:${name}`, ["run", "test", "--workspace", packageName(name)]);
  verifyDocs();
  const tarballs = [];
  for (const name of packages) {
    const packageRoot = path.join(root, "reviewfn", name);
    const dryRun = JSON.parse(npm(`pack-dry-run:${name}`, ["pack", "--dry-run", "--json"], packageRoot).stdout)[0];
    const files = new Set(dryRun.files.map((entry) => entry.path));
    for (const expected of ["README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) if (!files.has(expected)) throw new Error(`${packageName(name)} tarball is missing ${expected}.`);
    if (name === "cli" && !files.has("dist/main.js")) throw new Error("@superfunctions/reviewfn-cli tarball is missing its executable.");
    const packed = JSON.parse(npm(`pack:${name}`, ["pack", "--json", "--pack-destination", temporary], packageRoot).stdout)[0];
    tarballs.push(path.join(temporary, packed.filename));
  }
  const consumer = path.join(temporary, "consumer");
  run("consumer-mkdir", process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1],{recursive:true})", consumer]);
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm("consumer-install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumer);
  run("consumer-import", process.execPath, ["--input-type=module", "-e", "const core=await import('@superfunctions/reviewfn-core'); if(typeof core.ReviewCoordinator!=='function')process.exit(1)"], consumer);
  run("consumer-cli", path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "reviewfn.cmd" : "reviewfn"), ["help"], consumer);
  console.log(JSON.stringify({ ok: true, node: process.versions.node, packages, results: results.map(({ name, ok, status }) => ({ name, ok, status })) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results }, null, 2));
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
