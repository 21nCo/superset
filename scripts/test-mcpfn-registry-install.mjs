#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = process.argv[2];
const packageVersion = process.argv[3];
const registry = process.argv[4] ?? process.env.npm_config_registry ?? "https://registry.npmjs.org";
if (!["@mcpfn/testing", "@mcpfn/cli"].includes(packageName) || !packageVersion) {
  throw new Error(
    "Usage: test-mcpfn-registry-install.mjs <@mcpfn/testing|@mcpfn/cli> <version> [registry]",
  );
}

const root = mkdtempSync(path.join(tmpdir(), "mcpfn-registry-consumer-"));
try {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    private: true,
    type: "module",
  }));
  installWithRetry([
    `${packageName}@${packageVersion}`,
    "@modelcontextprotocol/sdk@1.29.0",
  ]);
  copyFileSync(
    path.join(repoRoot, "mcpfn/examples/external-http-server.mjs"),
    path.join(root, "external-http-server.mjs"),
  );
  copyFileSync(
    path.join(repoRoot, "mcpfn/examples/external-scenarios.mjs"),
    path.join(root, "external-scenarios.mjs"),
  );
  writeFileSync(
    path.join(root, "verify.mjs"),
    packageName === "@mcpfn/testing"
      ? testingConsumerSource(packageVersion)
      : cliConsumerSource(packageVersion),
  );
  const verification = await runVerification(process.execPath, ["verify.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      MCPFN_EXTERNAL_API_KEY: "registry-consumer-secret",
    },
    encoding: "utf8",
    stdio: "pipe",
  });
  if (verification.status !== 0) {
    throw new Error(
      `Published consumer verification failed with ${verification.status}\n${verification.stdout}\n${verification.stderr}`,
    );
  }
  process.stdout.write(verification.stdout);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function installWithRetry(packages) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    last = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        registry,
        ...packages,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
    );
    if (last.status === 0) return;
    if (attempt < 5) spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 15000)"]);
  }
  throw new Error(`Unable to install released package\n${last?.stdout}\n${last?.stderr}`);
}

function testingConsumerSource(expectedVersion) {
  return String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { readFile } from "node:fs/promises";
import {
  MCPFN_TESTING_VERSION,
  authenticatedHttpTarget,
  runMcpFnTargetSuite,
} from "@mcpfn/testing";

assert.equal(MCPFN_TESTING_VERSION, ${JSON.stringify(expectedVersion)});
const server = spawn(process.execPath, ["external-http-server.mjs"], {
  env: process.env, stdio: ["ignore", "pipe", "pipe"]
});
try {
  const lines = readline.createInterface({ input: server.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture startup timeout")), 10000);
    lines.once("line", (line) => { clearTimeout(timer); resolve(line.trim()); });
    server.once("error", reject);
  });
  const scenarios = (await import("./external-scenarios.mjs")).default.scenarios;
  const report = await runMcpFnTargetSuite({
    target: authenticatedHttpTarget(url, {
      credential: { headers: { "x-api-key": process.env.MCPFN_EXTERNAL_API_KEY } },
    }),
    scenarios,
  });
  assert.equal(report.ok, true);
  assert.equal(report.passed, 2);
  process.stdout.write(JSON.stringify({ ok: true, package: "@mcpfn/testing", version: MCPFN_TESTING_VERSION }) + "\n");
} finally {
  server.kill("SIGTERM");
}
`;
}

function cliConsumerSource(expectedVersion) {
  return String.raw`
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
const cliPackage = JSON.parse(await readFile(new URL("./node_modules/@mcpfn/cli/package.json", import.meta.url)));
assert.equal(cliPackage.version, ${JSON.stringify(expectedVersion)});
const server = spawn(process.execPath, ["external-http-server.mjs"], {
  env: process.env, stdio: ["ignore", "pipe", "pipe"]
});
try {
  const lines = readline.createInterface({ input: server.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture startup timeout")), 10000);
    lines.once("line", (line) => { clearTimeout(timer); resolve(line.trim()); });
    server.once("error", reject);
  });
  const result = spawnSync(process.execPath, [
    "node_modules/@mcpfn/cli/dist/bin.js", "test-target", url,
    "external-scenarios.mjs", "--api-key-env", "MCPFN_EXTERNAL_API_KEY"
  ], { env: process.env, encoding: "utf8", stdio: "pipe", timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  process.stdout.write(JSON.stringify({ ok: true, package: "@mcpfn/cli", version: cliPackage.version }) + "\n");
} finally {
  server.kill("SIGTERM");
}
`;
}

// Supervise the complete verifier process group: its HTTP fixture must not
// survive a timeout. Registry installation itself does not run fixture servers.
async function runVerification(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-262144); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-262144); });
  const killTree = (signal) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  let timedOut = false;
  let forceTimer;
  const terminate = () => {
    killTree("SIGTERM");
    forceTimer ??= setTimeout(() => killTree("SIGKILL"), 3000);
  };
  const onSignal = () => { timedOut = true; terminate(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const timer = setTimeout(() => { timedOut = true; terminate(); }, 30000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { status: timedOut ? null : status, stdout, stderr };
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    // Also remove descendants that outlived a normally exiting verifier.
    killTree("SIGKILL");
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
