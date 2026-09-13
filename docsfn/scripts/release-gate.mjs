#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectDocsContractStatus } from "./docs-contract-check.mjs";
import { collectMigrationCheckStatus } from "./migration-check.mjs";
import { collectReleasePreflightStatus } from "./release-preflight.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");
const cliBin = resolve(docsfnRoot, "cli", "dist", "index.js");
const gateTempRoot = resolve(docsfnRoot, ".tmp", "release-gate");
const gateSummaryPath = resolve(gateTempRoot, "summary.json");
const gateSummarySchemaPath = resolve(docsfnRoot, "scripts", "release-gate-summary.schema.json");
const migrationSummaryPath = resolve(docsfnRoot, ".tmp", "migration-check", "summary.json");

const fixtureRoots = {
  datafn: resolve(docsfnRoot, "test-fixtures", "repo", "datafn-docs"),
  searchfn: resolve(docsfnRoot, "test-fixtures", "repo", "searchfn-docs"),
};

const sharedSearchRuntimeBuildMatrix = [
  { name: "@searchfn/core", prefix: resolve(repoRoot, "searchfn", "core") },
  { name: "@searchfn/adapter-contracts", prefix: resolve(repoRoot, "searchfn", "adapter-contracts") },
  { name: "@searchfn/adapter-memory", prefix: resolve(repoRoot, "searchfn", "adapter-memory") },
  { name: "@searchfn/adapter-indexeddb", prefix: resolve(repoRoot, "searchfn", "adapter-indexeddb") },
  { name: "@searchfn/client", prefix: resolve(repoRoot, "searchfn", "client") },
];

const docsfnPackageBuildMatrix = [
  { name: "@mcpfn/core", prefix: resolve(repoRoot, "mcpfn", "core") },
  { name: "@superfunctions/admin", prefix: resolve(repoRoot, "packages", "admin") },
  { name: "@docsfn/core", prefix: resolve(docsfnRoot, "core") },
  { name: "@docsfn/provider-fs", prefix: resolve(docsfnRoot, "provider-fs") },
  { name: "@docsfn/react", prefix: resolve(docsfnRoot, "react") },
  { name: "@docsfn/svelte", prefix: resolve(docsfnRoot, "svelte") },
  { name: "@docsfn/next", prefix: resolve(docsfnRoot, "next") },
  { name: "@docsfn/sveltekit", prefix: resolve(docsfnRoot, "sveltekit") },
  { name: "@docsfn/cli", prefix: resolve(docsfnRoot, "cli") },
  { name: "@docsfn/admin", prefix: resolve(docsfnRoot, "admin") },
];

const stepOrder = [
  "preflight",
  "docs-contract",
  "shared-search-runtime-builds",
  "package-builds",
  "package-metadata",
  "tests",
  "dogfood-site",
  "fixture-builds",
  "example-tests",
  "example-builds",
  "migration-check",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class ReleaseGateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toRepoRelativePath(targetPath) {
  const rel = relative(repoRoot, targetPath);
  return rel.length === 0 ? "." : rel;
}

function commandToString(command, args) {
  return [command, ...args].join(" ");
}

async function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(" ")} failed with exit code ${String(code)}`)
      );
    });
  });
}

async function runCapture(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createSummary() {
  return {
    schemaVersion: 1,
    schemaPath: toRepoRelativePath(gateSummarySchemaPath),
    generatedAt: new Date().toISOString(),
    docsfnRoot: toRepoRelativePath(docsfnRoot),
    repoRoot: ".",
    status: "PENDING",
    code: "OK",
    bootstrap: {
      cleanCheckoutCommands: [
        "npm ci",
        "node docsfn/scripts/release-preflight.mjs",
        "node docsfn/scripts/release-gate.mjs",
      ],
    },
    artifacts: {
      summaryPath: toRepoRelativePath(gateSummaryPath),
      migrationSummaryPath: toRepoRelativePath(migrationSummaryPath),
    },
    steps: stepOrder.map((id) => ({
      id,
      status: "PENDING",
      code: null,
      detail: null,
      commands: [],
    })),
    checks: {
      preflight: null,
      docsContract: null,
      sharedSearchRuntimeBuilds: [],
      packageBuilds: [],
      packageMetadata: null,
      tests: [],
      dogfoodSite: [],
      fixtureBuilds: [],
      exampleTests: [],
      exampleBuilds: [],
      migrationCheck: null,
    },
  };
}

function assertReleaseGateSummary(summary) {
  assert(summary && typeof summary === "object", "release summary must be an object");
  assert(summary.schemaVersion === 1, "release summary schemaVersion must be 1");
  assert(typeof summary.schemaPath === "string" && summary.schemaPath.length > 0, "release summary schemaPath is required");
  assert(typeof summary.generatedAt === "string" && summary.generatedAt.length > 0, "release summary generatedAt is required");
  assert(Array.isArray(summary.steps), "release summary steps must be an array");
  assert(summary.steps.length === stepOrder.length, "release summary must contain every gate step");
  for (const expectedId of stepOrder) {
    const step = summary.steps.find((entry) => entry.id === expectedId);
    assert(step, `release summary missing step ${expectedId}`);
    assert(typeof step.status === "string", `release summary step ${expectedId} is missing status`);
    assert(Array.isArray(step.commands), `release summary step ${expectedId} commands must be an array`);
  }
}

function updateStep(summary, id, patch) {
  const step = summary.steps.find((entry) => entry.id === id);
  if (!step) {
    throw new Error(`unknown release-gate step ${id}`);
  }
  Object.assign(step, patch);
}

function markPendingStepsSkipped(summary) {
  for (const step of summary.steps) {
    if (step.status === "PENDING") {
      step.status = "SKIPPED";
      step.detail = "not reached because an earlier step failed";
    }
  }
}

async function writeSummary(summary) {
  assertReleaseGateSummary(summary);
  await mkdir(gateTempRoot, { recursive: true });
  await writeFile(gateSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function normalizeFieldPath(pkgRoot, value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.startsWith("./") ? value.slice(2) : value;
  return resolve(pkgRoot, trimmed);
}

function parsePeerRangeTokens(range) {
  return String(range)
    .split("||")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function collectExportTargets(exportsField, targets = new Set()) {
  if (typeof exportsField === "string") {
    targets.add(exportsField);
    return targets;
  }

  if (!exportsField || typeof exportsField !== "object") {
    return targets;
  }

  for (const value of Object.values(exportsField)) {
    collectExportTargets(value, targets);
  }
  return targets;
}

async function verifyPackageMetadataAndArtifacts() {
  const packageJsons = {};
  const verifiedPackages = [];

  for (const item of docsfnPackageBuildMatrix) {
    const packageJsonPath = resolve(item.prefix, "package.json");
    const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(packageJsonPath, "utf8"));
    packageJsons[item.name] = {
      path: packageJsonPath,
      root: item.prefix,
      json: packageJson,
    };

    for (const field of ["main", "module", "types"]) {
      const outputPath = normalizeFieldPath(item.prefix, packageJson[field]);
      if (outputPath) {
        assert(await fileExists(outputPath), `${item.name}: missing ${field} output at ${outputPath}`);
      }
    }

    const exportTargets = [...collectExportTargets(packageJson.exports)];
    for (const target of exportTargets) {
      const outputPath = normalizeFieldPath(item.prefix, target);
      if (outputPath) {
        assert(await fileExists(outputPath), `${item.name}: missing export target at ${outputPath}`);
      }
    }

    const binTargets = Object.values(
      typeof packageJson.bin === "string"
        ? { [packageJson.name]: packageJson.bin }
        : packageJson.bin ?? {}
    ).filter((value) => typeof value === "string");
    for (const target of binTargets) {
      const outputPath = normalizeFieldPath(item.prefix, target);
      assert(await fileExists(outputPath), `${item.name}: missing bin target at ${outputPath}`);
    }

    const packOutput = await runCapture(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: item.prefix }
    );
    const packResult = JSON.parse(packOutput.stdout)[0];
    const packedFiles = new Set(
      (packResult?.files ?? []).map((file) => String(file.path).replace(/^\.\//, ""))
    );
    for (const target of [...exportTargets, ...binTargets]) {
      const normalizedTarget = String(target).replace(/^\.\//, "");
      assert(packedFiles.has(normalizedTarget), `${item.name}: ${target} is missing from npm pack output`);
    }

    verifiedPackages.push({
      name: item.name,
      path: toRepoRelativePath(packageJsonPath),
      verifiedExports: exportTargets.sort((left, right) => left.localeCompare(right)),
      verifiedBins: binTargets.sort((left, right) => left.localeCompare(right)),
    });
  }

  const reactPeers = packageJsons["@docsfn/react"].json.peerDependencies ?? {};
  const reactRangeTokens = parsePeerRangeTokens(reactPeers.react ?? "");
  const reactDomRangeTokens = parsePeerRangeTokens(reactPeers["react-dom"] ?? "");
  assert(
    reactRangeTokens.includes("^18.3.0") && reactRangeTokens.includes("^19.0.0"),
    "@docsfn/react peerDependencies.react must include ^18.3.0 and ^19.0.0"
  );
  assert(
    reactDomRangeTokens.includes("^18.3.0") && reactDomRangeTokens.includes("^19.0.0"),
    "@docsfn/react peerDependencies.react-dom must include ^18.3.0 and ^19.0.0"
  );

  const nextPeers = packageJsons["@docsfn/next"].json.peerDependencies ?? {};
  assert(
    String(nextPeers.next ?? "").includes("^15.0.0"),
    "@docsfn/next peerDependencies.next must include ^15.0.0"
  );

  const sveltePeers = packageJsons["@docsfn/svelte"].json.peerDependencies ?? {};
  const svelteRangeTokens = parsePeerRangeTokens(sveltePeers.svelte ?? "");
  assert(
    sveltePeers.svelte === ">=5.20.0 <6",
    "@docsfn/svelte peerDependencies.svelte must be >=5.20.0 <6"
  );

  const svelteKitPeers = packageJsons["@docsfn/sveltekit"].json.peerDependencies ?? {};
  assert(
    String(svelteKitPeers["@sveltejs/kit"] ?? "").includes("^2.0.0"),
    "@docsfn/sveltekit peerDependencies.@sveltejs/kit must include ^2.0.0"
  );

  return {
    verifiedPackages,
  };
}

async function runSharedSearchRuntimeBuilds() {
  const builds = [];
  for (const item of sharedSearchRuntimeBuildMatrix) {
    const args = ["--prefix", item.prefix, "run", "build"];
    await run("npm", args, { cwd: repoRoot });
    builds.push({
      name: item.name,
      prefix: toRepoRelativePath(item.prefix),
      command: commandToString("npm", args),
    });
  }
  return builds;
}

async function runDocsfnPackageBuilds() {
  const builds = [];
  for (const item of docsfnPackageBuildMatrix) {
    const args = ["--prefix", item.prefix, "run", "build"];
    await run("npm", args, { cwd: repoRoot });
    builds.push({
      name: item.name,
      prefix: toRepoRelativePath(item.prefix),
      command: commandToString("npm", args),
    });
  }
  return builds;
}

async function runNamedCommands(commands) {
  const results = [];
  for (const item of commands) {
    await run(item.command, item.args, {
      cwd: item.cwd ?? repoRoot,
      env: item.env,
    });
    results.push({
      id: item.id,
      command: commandToString(item.command, item.args),
    });
  }
  return results;
}

async function runTestMatrix() {
  return await runNamedCommands([
    {
      id: "core",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "core"), "run", "test", "--", "--run"],
    },
    {
      id: "provider-fs",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "provider-fs"), "run", "test", "--", "--run"],
    },
    {
      id: "admin",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "admin"), "run", "test", "--", "--run"],
    },
    {
      id: "react-parity",
      command: "npm",
      args: [
        "--prefix",
        resolve(docsfnRoot, "react"),
        "run",
        "test",
        "--",
        "--run",
        "src/DocsContent.test.tsx",
        "src/DocsSearch.test.tsx",
        "src/Pagination.test.tsx",
        "src/ApiReferenceRenderer.test.tsx",
      ],
    },
    {
      id: "svelte-parity",
      command: "npm",
      args: [
        "exec",
        "--",
        "vitest",
        "run",
        "docsfn/svelte/src/DocsContent.test.ts",
        "docsfn/svelte/src/ApiReferenceRenderer.test.ts",
      ],
    },
    {
      id: "sveltekit-route-helpers",
      command: "npm",
      args: [
        "exec",
        "--",
        "vitest",
        "--config",
        "docsfn/sveltekit/vitest.config.ts",
        "run",
        "src/route-helpers.test.ts",
      ],
    },
    {
      id: "searchfn-client",
      command: "npm",
      args: [
        "--prefix",
        resolve(repoRoot, "searchfn", "client"),
        "run",
        "test",
        "--",
        "--run",
        "__tests__/in-memory-search.test.ts",
        "__tests__/constructors.test.ts",
        "__tests__/legacy-guard.test.ts",
      ],
    },
  ]);
}

async function runDogfoodSiteChecks() {
  return await runNamedCommands([
    {
      id: "docs-test",
      command: "npm",
      args: [
        "--prefix",
        resolve(docsfnRoot, "docs"),
        "run",
        "test",
        "--",
        "--run",
        "src/lib/server/docs-site-source.test.ts",
      ],
    },
    {
      id: "docs-build",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "docs"), "run", "build"],
    },
  ]);
}

async function runFixtureBuilds() {
  await mkdir(gateTempRoot, { recursive: true });

  const commands = [
    {
      id: "validate-datafn",
      command: "node",
      args: [cliBin, "validate", "--root", fixtureRoots.datafn],
    },
    {
      id: "validate-searchfn",
      command: "node",
      args: [cliBin, "validate", "--root", fixtureRoots.searchfn],
    },
    {
      id: "build-datafn",
      command: "node",
      args: [
        cliBin,
        "build",
        "--root",
        fixtureRoots.datafn,
        "--out-dir",
        resolve(gateTempRoot, "datafn-default"),
      ],
    },
    {
      id: "build-searchfn",
      command: "node",
      args: [
        cliBin,
        "build",
        "--root",
        fixtureRoots.searchfn,
        "--out-dir",
        resolve(gateTempRoot, "searchfn-default"),
      ],
    },
  ];

  const results = await runNamedCommands(commands);
  return results.map((result) => ({
    ...result,
    outputs:
      result.id === "build-datafn"
        ? [
            toRepoRelativePath(resolve(gateTempRoot, "datafn-default", "manifest.json")),
            toRepoRelativePath(resolve(gateTempRoot, "datafn-default", "search.json")),
            toRepoRelativePath(resolve(gateTempRoot, "datafn-default", "diagnostics.json")),
            toRepoRelativePath(resolve(gateTempRoot, "datafn-default", "compat-report.json")),
          ]
        : result.id === "build-searchfn"
          ? [
              toRepoRelativePath(resolve(gateTempRoot, "searchfn-default", "manifest.json")),
              toRepoRelativePath(resolve(gateTempRoot, "searchfn-default", "search.json")),
              toRepoRelativePath(resolve(gateTempRoot, "searchfn-default", "diagnostics.json")),
              toRepoRelativePath(resolve(gateTempRoot, "searchfn-default", "compat-report.json")),
            ]
          : [],
  }));
}

async function runExampleProofTests() {
  return await runNamedCommands([
    {
      id: "next-proof-tests",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "examples", "next-docs-site"), "run", "test", "--", "--run"],
    },
    {
      id: "sveltekit-proof-tests",
      command: "npm",
      args: ["--prefix", resolve(docsfnRoot, "examples", "sveltekit-docs-site"), "run", "test", "--", "--run"],
    },
  ]);
}

async function runExampleBuilds() {
  const nextExamplePrefix = resolve(docsfnRoot, "examples", "next-docs-site");
  const svelteExamplePrefix = resolve(docsfnRoot, "examples", "sveltekit-docs-site");

  return await runNamedCommands([
    {
      id: "next-searchfn",
      command: "npm",
      args: ["--prefix", nextExamplePrefix, "run", "build"],
      env: {
        ...process.env,
        DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/searchfn-docs",
      },
    },
    {
      id: "next-datafn",
      command: "npm",
      args: ["--prefix", nextExamplePrefix, "run", "build"],
      env: {
        ...process.env,
        DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/datafn-docs",
      },
    },
    {
      id: "sveltekit-searchfn",
      command: "npm",
      args: ["--prefix", svelteExamplePrefix, "run", "build"],
      env: {
        ...process.env,
        DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/searchfn-docs",
      },
    },
    {
      id: "sveltekit-datafn",
      command: "npm",
      args: ["--prefix", svelteExamplePrefix, "run", "build"],
      env: {
        ...process.env,
        DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/datafn-docs",
      },
    },
  ]);
}

async function main() {
  await rm(gateTempRoot, { recursive: true, force: true });
  const summary = createSummary();

  try {
    const preflight = await collectReleasePreflightStatus();
    summary.bootstrap.cleanCheckoutCommands = preflight.cleanCheckoutCommands ?? summary.bootstrap.cleanCheckoutCommands;
    summary.checks.preflight = {
      code: preflight.code,
      suggestedBootstrap: preflight.suggestedBootstrap,
      checks: preflight.checks,
    };
    updateStep(summary, "preflight", {
      status: preflight.ok ? "PASS" : "FAIL",
      code: preflight.code,
      detail: `${preflight.checks.filter((check) => !check.ok).length} failing bootstrap checks`,
      commands: ["node docsfn/scripts/release-preflight.mjs"],
    });
    await writeSummary(summary);
    if (!preflight.ok) {
      throw new ReleaseGateError(
        "DOCS_RELEASE_ENV_INVALID",
        "release preflight failed before package builds; see docsfn/.tmp/release-gate/summary.json"
      );
    }

    const docsContract = await collectDocsContractStatus();
    summary.checks.docsContract = {
      code: docsContract.code,
      checkedFiles: docsContract.checkedFiles.map((filePath) => toRepoRelativePath(filePath)),
      violations: docsContract.violations.map((violation) => ({
        ...violation,
        file: toRepoRelativePath(violation.file),
      })),
    };
    updateStep(summary, "docs-contract", {
      status: docsContract.ok ? "PASS" : "FAIL",
      code: docsContract.code,
      detail: `${docsContract.violations.length} docs contract violation(s)`,
      commands: ["node docsfn/scripts/docs-contract-check.mjs"],
    });
    await writeSummary(summary);
    if (!docsContract.ok) {
      throw new ReleaseGateError(
        "DOCS_RELEASE_GATE_FAILED",
        "docs contract failed before package builds; see docsfn/.tmp/release-gate/summary.json"
      );
    }

    const sharedSearchRuntimeBuilds = await runSharedSearchRuntimeBuilds();
    summary.checks.sharedSearchRuntimeBuilds = sharedSearchRuntimeBuilds;
    updateStep(summary, "shared-search-runtime-builds", {
      status: "PASS",
      detail: `built ${sharedSearchRuntimeBuilds.length} shared search runtime packages`,
      commands: sharedSearchRuntimeBuilds.map((build) => build.command),
    });
    await writeSummary(summary);

    const packageBuilds = await runDocsfnPackageBuilds();
    summary.checks.packageBuilds = packageBuilds;
    updateStep(summary, "package-builds", {
      status: "PASS",
      detail: `built ${packageBuilds.length} docsfn packages`,
      commands: packageBuilds.map((build) => build.command),
    });
    await writeSummary(summary);

    const packageMetadata = await verifyPackageMetadataAndArtifacts();
    summary.checks.packageMetadata = packageMetadata;
    updateStep(summary, "package-metadata", {
      status: "PASS",
      detail: "package metadata and built artifacts verified",
      commands: [],
    });
    await writeSummary(summary);

    const tests = await runTestMatrix();
    summary.checks.tests = tests;
    updateStep(summary, "tests", {
      status: "PASS",
      detail: `executed ${tests.length} parity and runtime test commands`,
      commands: tests.map((entry) => entry.command),
    });
    await writeSummary(summary);

    const dogfoodSite = await runDogfoodSiteChecks();
    summary.checks.dogfoodSite = dogfoodSite;
    updateStep(summary, "dogfood-site", {
      status: "PASS",
      detail: "dogfood site tests and build passed",
      commands: dogfoodSite.map((entry) => entry.command),
    });
    await writeSummary(summary);

    const fixtureBuilds = await runFixtureBuilds();
    summary.checks.fixtureBuilds = fixtureBuilds;
    updateStep(summary, "fixture-builds", {
      status: "PASS",
      detail: "canonical fixtures validated and built",
      commands: fixtureBuilds.map((entry) => entry.command),
    });
    await writeSummary(summary);

    const exampleTests = await runExampleProofTests();
    summary.checks.exampleTests = exampleTests;
    updateStep(summary, "example-tests", {
      status: "PASS",
      detail: "example proof-route test suites passed",
      commands: exampleTests.map((entry) => entry.command),
    });
    await writeSummary(summary);

    const exampleBuilds = await runExampleBuilds();
    summary.checks.exampleBuilds = exampleBuilds;
    updateStep(summary, "example-builds", {
      status: "PASS",
      detail: "Next and SvelteKit example builds passed for both canonical fixtures",
      commands: exampleBuilds.map((entry) => entry.command),
    });
    await writeSummary(summary);

    const migrationCheck = await collectMigrationCheckStatus();
    summary.checks.migrationCheck = migrationCheck;
    updateStep(summary, "migration-check", {
      status: migrationCheck.ok ? "PASS" : "FAIL",
      code: migrationCheck.code,
      detail: migrationCheck.ok
        ? `verified ${migrationCheck.proofRoutes.length} proof routes across ${migrationCheck.fixtures.length} fixtures`
        : migrationCheck.error ?? "migration parity failed",
      commands: [
        "node docsfn/scripts/migration-check.mjs",
      ],
    });
    await writeSummary(summary);
    if (!migrationCheck.ok) {
      throw new ReleaseGateError(
        "DOCS_RELEASE_GATE_FAILED",
        "migration parity failed; see docsfn/.tmp/release-gate/summary.json"
      );
    }

    summary.status = "PASS";
    summary.code = "OK";
    await writeSummary(summary);

    console.log("\n[release-gate] PASS: release matrix, dogfood, examples, fixtures, and migration parity all succeeded.");
    console.log(`[release-gate] summary: ${gateSummaryPath}`);
  } catch (error) {
    const code =
      error instanceof ReleaseGateError
        ? error.code
        : "DOCS_RELEASE_GATE_FAILED";

    const failingStep = summary.steps.find((step) => step.status === "FAIL");
    if (!failingStep) {
      const currentPending = summary.steps.find((step) => step.status === "PENDING");
      if (currentPending) {
        currentPending.status = "FAIL";
        currentPending.detail = error instanceof Error ? error.message : String(error);
        currentPending.code = code;
      }
    }

    markPendingStepsSkipped(summary);
    summary.status = "FAIL";
    summary.code = code;
    await writeSummary(summary);

    console.error(`\n[release-gate] ${code}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[release-gate] summary: ${gateSummaryPath}`);
    process.exitCode = 1;
  }
}

await main();
