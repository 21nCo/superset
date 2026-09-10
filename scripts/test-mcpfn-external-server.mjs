#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSource = path.join(repoRoot, "mcpfn/examples/external-http-server.mjs");
const scenarioSource = path.join(repoRoot, "mcpfn/examples/external-scenarios.mjs");
const cli = path.join(repoRoot, "mcpfn/cli/dist/bin.js");
const configuredOutputRoot = process.env.MCPFN_ARTIFACT_DIR;
const outputRoot = configuredOutputRoot
  ? path.resolve(repoRoot, configuredOutputRoot)
  : await mkdtemp(path.join(tmpdir(), "mcpfn-external-"));
await mkdir(outputRoot, { recursive: true });
const jsonReport = path.join(outputRoot, "report.json");
const junitReport = path.join(outputRoot, "report.xml");
const apiKey = "mcpfn-external-fixture-secret";
const serverText = await readFile(serverSource, "utf8");
assert.doesNotMatch(serverText, /from\s+["']@mcpfn\//);

const server = spawn(process.execPath, [serverSource], {
  cwd: repoRoot,
  env: { ...process.env, MCPFN_EXTERNAL_API_KEY: apiKey },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverStderr = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverStderr += chunk; });

try {
  const url = await waitForUrl(server, serverStderr);
  const authenticated = spawnSync(process.execPath, [
    cli,
    "test-target",
    url,
    scenarioSource,
    "--api-key-env",
    "MCPFN_EXTERNAL_API_KEY",
    "--output",
    jsonReport,
    "--junit",
    junitReport,
    "--max-report-bytes",
    "1048576",
  ], {
    cwd: repoRoot,
    env: { ...process.env, MCPFN_EXTERNAL_API_KEY: apiKey },
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20_000,
  });
  assert.equal(
    authenticated.status,
    0,
    `Authenticated external fixture failed\n${authenticated.stdout}\n${authenticated.stderr}`,
  );
  const report = JSON.parse(await readFile(jsonReport, "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.passed, 2);
  assert.equal(report.target.kind, "authenticated-streamable-http");
  const junit = await readFile(junitReport, "utf8");
  assert.match(junit, /testsuite/);
  assert.doesNotMatch(junit, new RegExp(apiKey));

  const unauthenticated = spawnSync(process.execPath, [
    cli,
    "test-target",
    url,
    scenarioSource,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20_000,
  });
  assert.equal(
    unauthenticated.status,
    1,
    `Unauthenticated fixture must fail with runtime exit 1, got ${unauthenticated.status}\n${unauthenticated.stdout}\n${unauthenticated.stderr}`,
  );
  assert.equal(unauthenticated.error, undefined);
  const unauthenticatedReport = JSON.parse(unauthenticated.stdout);
  assert.equal(unauthenticatedReport.kind, "mcpfn.target-suite-report");
  assert.equal(unauthenticatedReport.ok, false);
  assert.ok(unauthenticatedReport.failure);

  const rejectedBeforeBody = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(1_048_577),
  });
  assert.equal(rejectedBeforeBody.status, 401);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: "official-sdk-only",
    authenticatedScenarios: report.passed,
    unauthenticatedExitCode: unauthenticated.status,
    artifacts: ["json", "junit"],
  })}\n`);
} finally {
  await stop(server);
  if (!configuredOutputRoot) {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

function waitForUrl(child, initialStderr) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      reject(new Error(`External MCP fixture did not start\n${initialStderr}`));
    }, 10_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(line.trim());
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`External MCP fixture exited with ${code}\n${initialStderr}`));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 3_000, "timeout");
  });
  try {
    if (await Promise.race([exited, timeout]) === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
  } finally {
    clearTimeout(timer);
  }
}
