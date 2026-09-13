#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");
const fixturesRoot = resolve(docsfnRoot, "test-fixtures", "repo");
const tempRoot = resolve(docsfnRoot, ".tmp", "migration-check");
const summaryPath = resolve(tempRoot, "summary.json");
const cliPrefix = resolve(docsfnRoot, "cli");
const cliBin = resolve(cliPrefix, "dist", "index.js");
const proofRoutesPath = resolve(docsfnRoot, "examples", "proof-routes.json");

const sharedSearchRuntimeBuildMatrix = [
  { name: "@searchfn/core", prefix: resolve(repoRoot, "searchfn", "core") },
  { name: "@searchfn/adapter-contracts", prefix: resolve(repoRoot, "searchfn", "adapter-contracts") },
  { name: "@searchfn/adapter-memory", prefix: resolve(repoRoot, "searchfn", "adapter-memory") },
  { name: "@searchfn/adapter-indexeddb", prefix: resolve(repoRoot, "searchfn", "adapter-indexeddb") },
  { name: "@searchfn/client", prefix: resolve(repoRoot, "searchfn", "client") },
];

const fixtureSpecs = [
  {
    id: "datafn-docs",
    root: resolve(fixturesRoot, "datafn-docs"),
    title: "DataFn Docs",
    expectedRoutes: ["/docs", "/docs/documentation/server/routes"],
    expectedTopLabels: [
      "DataFn",
      "Documentation",
      "Concepts",
      "Client",
      "Server",
      "Sync",
      "Migrations",
      "Use Cases",
      "Storage",
      "Plugins",
    ],
    requireTabs: true,
    requireMermaid: true,
  },
  {
    id: "searchfn-docs",
    root: resolve(fixturesRoot, "searchfn-docs"),
    title: "SearchFn Docs",
    expectedRoutes: ["/docs", "/docs/reference/client"],
    expectedTopLabels: [
      "SearchFn",
      "Getting Started",
      "Architecture",
      "Reference",
      "Integrations",
      "Operations",
    ],
    requireTabs: false,
    requireMermaid: true,
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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

async function walkFiles(root, results = []) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absolutePath, results);
      continue;
    }
    results.push(absolutePath);
  }
  return results;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSummary(status) {
  await mkdir(tempRoot, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function verifyProofRoutes() {
  const raw = JSON.parse(await readFile(proofRoutesPath, "utf8"));
  assert(raw.version === 1, "proof-route inventory version must be 1");
  assert(Array.isArray(raw.routes), "proof-route inventory must define routes");

  const actualIds = raw.routes.map((route) => route.id);
  const expectedIds = [...actualIds].sort((left, right) => left.localeCompare(right));
  assert(
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `proof-route ids must be sorted deterministically (expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(actualIds)})`
  );

  const uniqueIds = new Set(actualIds);
  assert(uniqueIds.size === actualIds.length, "proof-route ids must be unique");

  const requiredSurfaces = ["api", "blog", "docs", "embedded"];
  const requiredFrameworks = ["next", "sveltekit"];
  for (const framework of requiredFrameworks) {
    for (const surface of requiredSurfaces) {
      assert(
        raw.routes.some((route) => route.framework === framework && route.surface === surface),
        `missing proof-route entry for ${framework}:${surface}`
      );
    }
  }

  const summary = [];
  for (const route of raw.routes) {
    assert(typeof route.routePattern === "string" && route.routePattern.startsWith("/"), `${route.id}: routePattern must start with /`);
    assert(Array.isArray(route.routeFiles) && route.routeFiles.length > 0, `${route.id}: routeFiles must be a non-empty array`);
    assert(
      Array.isArray(route.requiredMarkers) && route.requiredMarkers.length > 0,
      `${route.id}: requiredMarkers must be a non-empty array`
    );

    let combinedSource = "";
    for (const relativePath of route.routeFiles) {
      const absolutePath = resolve(repoRoot, relativePath);
      assert(await fileExists(absolutePath), `${route.id}: missing proof route file ${relativePath}`);
      const source = await readFile(absolutePath, "utf8");
      combinedSource += `\n${source}`;
    }

    for (const marker of route.requiredMarkers) {
      assert(combinedSource.includes(marker), `${route.id}: missing proof marker "${marker}"`);
    }

    summary.push({
      id: route.id,
      framework: route.framework,
      surface: route.surface,
      routePattern: route.routePattern,
      routeFiles: route.routeFiles,
      requiredMarkers: route.requiredMarkers,
    });
  }

  return summary;
}

async function gatherCompatibilitySignals(fixtureRoot) {
  const docsRoot = resolve(fixtureRoot, "content", "docs");
  const files = await walkFiles(docsRoot);
  const markdownFiles = files.filter((filePath) => filePath.endsWith(".md") || filePath.endsWith(".mdx"));
  const controlFiles = files.filter((filePath) => filePath.endsWith("meta.json"));

  let tabsCount = 0;
  let mermaidCount = 0;
  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, "utf8");
    tabsCount += (content.match(/<\s*Tabs\b/g) ?? []).length;
    tabsCount += (content.match(/<\s*Tab\b/g) ?? []).length;
    mermaidCount += (content.match(/```mermaid/g) ?? []).length;
  }

  return {
    controlFiles: controlFiles.length,
    tabsCount,
    mermaidCount,
  };
}

function createFixtureConfig(fixture) {
  return {
    schemaVersion: 1,
    site: {
      title: fixture.title,
      basePath: "/docs",
      canonicalUrl: "https://example.com",
    },
    compat: {
      preset: "fumadocs-v15",
    },
    content: {
      root: fixture.root,
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
    },
    search: {
      enabled: true,
      scopes: ["docs", "api", "blog"],
      bodyIndexing: "summary",
    },
    auth: {
      enabled: false,
      mode: "public",
    },
    analytics: {
      enabled: false,
      provider: "watchfn",
      respectDnt: true,
    },
  };
}

function extractSidebarTopLabels(manifest) {
  const items = manifest.sidebars?.default?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item && typeof item === "object" && typeof item.text === "string")
    .map((item) => item.text);
}

async function runFixtureCheck(fixture) {
  const fixtureOutDir = resolve(tempRoot, "out", fixture.id);
  const configPath = resolve(tempRoot, "config", `${fixture.id}.config.mjs`);

  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(fixtureOutDir, { recursive: true });

  const config = createFixtureConfig(fixture);
  await writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, "utf8");

  const buildCommand = [
    "node",
    cliBin,
    "build",
    "--root",
    fixture.root,
    "--config",
    configPath,
    "--out-dir",
    fixtureOutDir,
  ];
  await run(buildCommand[0], buildCommand.slice(1));

  const diagnostics = JSON.parse(await readFile(resolve(fixtureOutDir, "diagnostics.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(fixtureOutDir, "manifest.json"), "utf8"));
  const compatReport = JSON.parse(await readFile(resolve(fixtureOutDir, "compat-report.json"), "utf8"));
  const compatibilitySignals = await gatherCompatibilitySignals(fixture.root);

  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic?.severity === "error");

  assert(errorDiagnostics.length === 0, `${fixture.id}: expected zero error diagnostics`);
  assert(compatReport.preset === "fumadocs-v15", `${fixture.id}: compat preset must be fumadocs-v15`);
  assert(
    Array.isArray(compatReport.unsupportedSyntax) && compatReport.unsupportedSyntax.length === 0,
    `${fixture.id}: unsupported compatibility syntax remains`
  );

  for (const route of fixture.expectedRoutes) {
    assert(manifest.routes?.[route], `${fixture.id}: missing expected route ${route}`);
  }

  const topLabels = extractSidebarTopLabels(manifest);
  const expected = fixture.expectedTopLabels;
  const actualPrefix = topLabels.slice(0, expected.length);
  assert(
    JSON.stringify(actualPrefix) === JSON.stringify(expected),
    `${fixture.id}: sidebar top-level labels mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actualPrefix)})`
  );

  assert(compatibilitySignals.controlFiles > 0, `${fixture.id}: no meta.json control files found`);
  if (fixture.requireTabs) {
    assert(compatibilitySignals.tabsCount > 0, `${fixture.id}: expected Tabs/Tab compatibility syntax in fixture`);
  }
  if (fixture.requireMermaid) {
    assert(compatibilitySignals.mermaidCount > 0, `${fixture.id}: expected mermaid fences in fixture`);
  }

  return {
    fixture: fixture.id,
    commands: [commandToString(buildCommand[0], buildCommand.slice(1))],
    routes: fixture.expectedRoutes,
    topLabels: actualPrefix,
    compatibilitySignals,
    outputs: [
      toRepoRelativePath(resolve(fixtureOutDir, "manifest.json")),
      toRepoRelativePath(resolve(fixtureOutDir, "search.json")),
      toRepoRelativePath(resolve(fixtureOutDir, "diagnostics.json")),
      toRepoRelativePath(resolve(fixtureOutDir, "compat-report.json")),
    ],
  };
}

async function buildSharedSearchRuntimePackages() {
  const builds = [];
  for (const item of sharedSearchRuntimeBuildMatrix) {
    const args = ["--prefix", item.prefix, "run", "build"];
    await run("npm", args, { cwd: repoRoot });
    builds.push({
      name: item.name,
      command: commandToString("npm", args),
      prefix: toRepoRelativePath(item.prefix),
    });
  }
  return builds;
}

export async function collectMigrationCheckStatus() {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  const status = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summaryPath: toRepoRelativePath(summaryPath),
    status: "PENDING",
    code: "OK",
    proofRoutes: [],
    sharedSearchRuntimeBuilds: [],
    cliBuildCommand: commandToString("npm", ["--prefix", cliPrefix, "run", "build"]),
    fixtures: [],
  };

  try {
    status.proofRoutes = await verifyProofRoutes();
    status.sharedSearchRuntimeBuilds = await buildSharedSearchRuntimePackages();
    await run("npm", ["--prefix", cliPrefix, "run", "build"], { cwd: repoRoot });

    const fixtures = [];
    for (const fixture of fixtureSpecs) {
      fixtures.push(await runFixtureCheck(fixture));
    }
    status.fixtures = fixtures;
    status.status = "PASS";
    await writeSummary(status);
    return {
      ok: true,
      code: "OK",
      ...status,
    };
  } catch (error) {
    status.status = "FAIL";
    status.code = "DOCS_RELEASE_GATE_FAILED";
    status.error = error instanceof Error ? error.message : String(error);
    await writeSummary(status);
    return {
      ok: false,
      code: "DOCS_RELEASE_GATE_FAILED",
      ...status,
    };
  }
}

function printStatus(status) {
  console.log("[migration-check] verifying proof-route inventory");
  for (const route of status.proofRoutes) {
    console.log(`- ${route.id}: ${route.framework} ${route.surface} -> ${route.routePattern}`);
    console.log(`  files: ${route.routeFiles.join(", ")}`);
  }

  console.log("[migration-check] building shared search runtime packages");
  for (const build of status.sharedSearchRuntimeBuilds) {
    console.log(`- ${build.name}: ${build.command}`);
  }

  console.log(`[migration-check] ensuring docsfn CLI is built`);
  console.log(`- ${status.cliBuildCommand}`);

  if (!status.ok) {
    console.error(`\n[migration-check] ${status.code}: ${status.error}`);
    console.error(`[migration-check] summary: ${summaryPath}`);
    return;
  }

  console.log("\n[migration-check] parity checks passed for canonical fixtures:");
  for (const fixture of status.fixtures) {
    console.log(`- ${fixture.fixture}`);
    console.log(`  routes: ${fixture.routes.join(", ")}`);
    console.log(`  sidebar labels: ${fixture.topLabels.join(" | ")}`);
    console.log(
      `  compatibility signals: meta.json=${fixture.compatibilitySignals.controlFiles}, tabs=${fixture.compatibilitySignals.tabsCount}, mermaid=${fixture.compatibilitySignals.mermaidCount}`
    );
  }
  console.log(`[migration-check] summary: ${summaryPath}`);
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === scriptPath : false;

if (isDirectRun) {
  collectMigrationCheckStatus()
    .then((status) => {
      printStatus(status);
      if (!status.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`\n[migration-check] DOCS_RELEASE_GATE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
