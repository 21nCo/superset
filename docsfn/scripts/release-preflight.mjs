#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");
const repoPackageJsonPath = resolve(repoRoot, "package.json");
const repoNodeModulesPath = resolve(repoRoot, "node_modules");
const repoBinPath = resolve(repoNodeModulesPath, ".bin");

const requiredLocalBins = [
  {
    name: "tsup",
    reason: "required by @docsfn/core, @docsfn/provider-fs, @docsfn/react, @docsfn/svelte, @docsfn/next, @docsfn/sveltekit, and @docsfn/cli build scripts",
  },
  {
    name: "vite",
    reason: "required by @docsfn/docs and @docsfn/example-sveltekit-docs-site build scripts",
  },
  {
    name: "vitest",
    reason: "required by the release-gate test matrix",
  },
  {
    name: "next",
    reason: "required by @docsfn/example-next-docs-site build script",
  },
];

const requiredPaths = [
  {
    id: "repo-package-json",
    label: "repo package.json",
    path: repoPackageJsonPath,
  },
  {
    id: "repo-node-modules",
    label: "repo node_modules",
    path: repoNodeModulesPath,
  },
  {
    id: "docsfn-cli-bin",
    label: "docsfn CLI source entrypoint",
    path: resolve(docsfnRoot, "cli", "src", "index.ts"),
  },
  {
    id: "canonical-fixture-datafn",
    label: "datafn canonical fixture root",
    path: resolve(docsfnRoot, "test-fixtures", "repo", "datafn-docs"),
  },
  {
    id: "canonical-fixture-searchfn",
    label: "searchfn canonical fixture root",
    path: resolve(docsfnRoot, "test-fixtures", "repo", "searchfn-docs"),
  },
];

function parseVersionString(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return match.slice(1).map((part) => Number(part));
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCapture(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${String(code)}${
            stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""
          }`
        )
      );
    });
  });
}

function createCheck(id, ok, detail, fix = null) {
  return {
    id,
    ok,
    detail,
    fix,
  };
}

export async function collectReleasePreflightStatus() {
  const checks = [];
  const repoPackageJson = JSON.parse(await readFile(repoPackageJsonPath, "utf8"));
  const expectedNodeVersion = parseVersionString(String(repoPackageJson.engines?.node ?? ">=18.0.0").replace(/^>=/, ""));
  const expectedNpmVersion = parseVersionString(String(repoPackageJson.packageManager ?? "npm@10.2.0").split("@")[1] ?? "10.2.0");

  const actualNodeVersion = parseVersionString(process.version);
  if (!actualNodeVersion || !expectedNodeVersion) {
    checks.push(
      createCheck(
        "node-version",
        false,
        `could not parse Node version (actual=${process.version}, expected=${String(repoPackageJson.engines?.node ?? ">=18.0.0")})`,
        "Use Node 18 or newer before running docsfn verification commands."
      )
    );
  } else {
    const nodeVersionOk = compareVersions(actualNodeVersion, expectedNodeVersion) >= 0;
    checks.push(
      createCheck(
        "node-version",
        nodeVersionOk,
        `node ${process.version} ${nodeVersionOk ? "satisfies" : "does not satisfy"} ${String(repoPackageJson.engines?.node ?? ">=18.0.0")}`,
        nodeVersionOk ? null : "Install a Node version that satisfies the repo engines field, then rerun `npm ci`."
      )
    );
  }

  try {
    const npmVersionOutput = await runCapture("npm", ["--version"]);
    const actualNpmVersion = parseVersionString(npmVersionOutput.stdout);
    if (!actualNpmVersion || !expectedNpmVersion) {
      checks.push(
        createCheck(
          "npm-version",
          false,
          `could not parse npm version (actual=${npmVersionOutput.stdout}, expected=${String(repoPackageJson.packageManager ?? "npm@10.2.0")})`,
          "Install the npm version declared in repo packageManager."
        )
      );
    } else {
      const npmVersionOk = compareVersions(actualNpmVersion, expectedNpmVersion) >= 0;
      checks.push(
        createCheck(
          "npm-version",
          npmVersionOk,
          `npm ${npmVersionOutput.stdout} ${npmVersionOk ? "satisfies" : "does not satisfy"} ${String(repoPackageJson.packageManager ?? "npm@10.2.0")}`,
          npmVersionOk ? null : "Upgrade npm to the version declared in repo packageManager."
        )
      );
    }
  } catch (error) {
    checks.push(
      createCheck(
        "npm-version",
        false,
        `failed to determine npm version: ${error instanceof Error ? error.message : String(error)}`,
        "Install npm and ensure it is on PATH."
      )
    );
  }

  for (const item of requiredPaths) {
    const exists = await pathExists(item.path);
    checks.push(
      createCheck(
        item.id,
        exists,
        `${item.label} ${exists ? "found" : "missing"} at ${item.path}`,
        exists ? null : "Run `npm ci` from the repo root and verify the docsfn fixtures are present."
      )
    );
  }

  for (const item of requiredLocalBins) {
    const binaryPath = resolve(repoBinPath, item.name);
    const exists = await pathExists(binaryPath);
    checks.push(
      createCheck(
        `bin:${item.name}`,
        exists,
        `${item.name} ${exists ? "found" : "missing"} at ${binaryPath} (${item.reason})`,
        exists ? null : "Run `npm ci` from the repo root so workspace binaries are available under node_modules/.bin."
      )
    );
  }

  const ok = checks.every((check) => check.ok);

  return {
    ok,
    code: ok ? "OK" : "DOCS_RELEASE_ENV_INVALID",
    repoRoot,
    docsfnRoot,
    checks,
    suggestedBootstrap: "npm ci",
    cleanCheckoutCommands: [
      "npm ci",
      "node docsfn/scripts/release-preflight.mjs",
      "node docsfn/scripts/release-gate.mjs",
    ],
  };
}

function printStatus(status) {
  console.log("[release-preflight] bootstrap contract");
  for (const check of status.checks) {
    const state = check.ok ? "PASS" : "FAIL";
    console.log(`- ${state} ${check.id}: ${check.detail}`);
    if (!check.ok && check.fix) {
      console.log(`  fix: ${check.fix}`);
    }
  }

  if (status.ok) {
    console.log("\n[release-preflight] PASS: local bootstrap prerequisites are present.");
    return;
  }

  console.error(`\n[release-preflight] ${status.code}: run \`${status.suggestedBootstrap}\` from ${repoRoot} and rerun the gate.`);
}

async function main() {
  const status = await collectReleasePreflightStatus();
  printStatus(status);
  if (!status.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === scriptPath : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(
      `[release-preflight] DOCS_RELEASE_ENV_INVALID: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
