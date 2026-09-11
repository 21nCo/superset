#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import {
  discoverJsPackages,
  discoverPythonPackages,
  findNearestManifestDir,
  manifestExists,
} from "./ci-utils.mjs";

const repoRoot = process.cwd();

const JS_GLOBAL_PATTERNS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^turbo\.json$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^tsconfig(?:\..+)?\.json$/,
  /^\.github\/workflows\//,
  /^scripts\//,
];

const PYTHON_GLOBAL_PATTERNS = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-plan\.mjs$/,
  /^scripts\/ci-run-python-package\.mjs$/,
  /^scripts\/ci-utils\.mjs$/,
];

const MCPFN_PATTERNS = [
  /^mcpfn\//,
  /^datafn\/server\/src\/(?:executor|server|index)\.ts$/,
  /^datafn\/server\/src\/__tests__\/executor\.test\.ts$/,
  /^scripts\/(?:gate|test)-mcpfn.*\.mjs$/,
];

const MCPFN_SUPPORT_PATTERNS = [
  /^README\.md$/,
  /^release-packages\.json$/,
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function ensureRemoteBranch(branchName) {
  if (!branchName) {
    return false;
  }

  if (gitOk(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`])) {
    return true;
  }

  try {
    git([
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function loadGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return {};
  }

  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function isRealCommit(value) {
  return Boolean(value) && !/^0+$/.test(value);
}

function ensureCommit(commitish) {
  return isRealCommit(commitish) && gitOk(["cat-file", "-e", `${commitish}^{commit}`]);
}

function resolveDiffBase(event) {
  const eventName = process.env.GITHUB_EVENT_NAME || "local";
  const defaultBranch = event.repository?.default_branch || "dev";

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const baseSha = event.pull_request?.base?.sha;
    if (ensureCommit(baseSha)) {
      return baseSha;
    }

    const baseRef = event.pull_request?.base?.ref;
    if (ensureRemoteBranch(baseRef)) {
      return git(["merge-base", "HEAD", `refs/remotes/origin/${baseRef}`]);
    }
  }

  if (eventName === "push") {
    const before = event.before;
    if (ensureCommit(before)) {
      return before;
    }
  }

  if (ensureRemoteBranch(defaultBranch)) {
    return git(["merge-base", "HEAD", `refs/remotes/origin/${defaultBranch}`]);
  }

  if (gitOk(["rev-parse", "--verify", "HEAD^"])) {
    return git(["rev-parse", "HEAD^"]);
  }

  return git(["rev-parse", "HEAD"]);
}

function parseChangedEntries(baseRef) {
  let output = "";

  if (baseRef !== "HEAD") {
    const range = gitOk(["merge-base", baseRef, "HEAD"])
      ? `${baseRef}...HEAD`
      : `${baseRef}..HEAD`;

    output = execFileSync(
      "git",
      ["diff", "--name-status", "--find-renames", "-z", range],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  }

  const tokens = output.split("\0").filter(Boolean);
  const entries = [];

  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    index += 1;

    if (status.startsWith("R") || status.startsWith("C")) {
      const fromPath = tokens[index];
      const toPath = tokens[index + 1];
      index += 2;
      entries.push({ status, paths: [fromPath, toPath] });
      continue;
    }

    const filePath = tokens[index];
    index += 1;
    entries.push({ status, paths: [filePath] });
  }

  return entries;
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

function buildTurboFilters(packageDirs) {
  return [...packageDirs]
    .sort()
    .map((packageDir) => `--filter=..../${packageDir}`)
    .join(" ");
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(outputPath, `${name}<<__CI_EOF__\n${value}\n__CI_EOF__\n`);
}

function collectPythonDependents(seedNames, manifestsByName) {
  const dependents = new Map();

  for (const manifest of manifestsByName.values()) {
    for (const dependency of manifest.dependencies) {
      if (!manifestsByName.has(dependency)) {
        continue;
      }

      if (!dependents.has(dependency)) {
        dependents.set(dependency, new Set());
      }

      dependents.get(dependency).add(manifest.name);
    }
  }

  const selected = new Set(seedNames);
  const queue = [...seedNames];

  while (queue.length > 0) {
    const packageName = queue.shift();
    const directDependents = dependents.get(packageName);
    if (!directDependents) {
      continue;
    }

    for (const dependent of directDependents) {
      if (selected.has(dependent)) {
        continue;
      }

      selected.add(dependent);
      queue.push(dependent);
    }
  }

  return selected;
}

const event = loadGitHubEvent();
const baseRef = resolveDiffBase(event);
const changedEntries = parseChangedEntries(baseRef);
const changedPaths = [...new Set(changedEntries.flatMap((entry) => entry.paths))].sort();

const jsPackages = discoverJsPackages(repoRoot);
const pythonPackages = discoverPythonPackages(repoRoot).map((manifest) => ({
  ...manifest,
  name: manifest.name.toLowerCase(),
}));

const jsByDir = new Map(jsPackages.map((manifest) => [manifest.dir, manifest]));
const pythonByDir = new Map(pythonPackages.map((manifest) => [manifest.dir, manifest]));
const pythonByName = new Map(pythonPackages.map((manifest) => [manifest.name, manifest]));

const jsDirs = new Set(jsByDir.keys());
const pythonDirs = new Set(pythonByDir.keys());

let fullJs = false;
let fullPython = false;

const changedJsDirs = new Set();
const changedPythonNames = new Set();
const runMcpfn = changedPaths.some((changedPath) => matchesAny(MCPFN_PATTERNS, changedPath));

for (const entry of changedEntries) {
  for (const changedPath of entry.paths) {
    if (matchesAny(JS_GLOBAL_PATTERNS, changedPath)) {
      fullJs = true;
    }

    if (matchesAny(PYTHON_GLOBAL_PATTERNS, changedPath)) {
      fullPython = true;
    }

    const jsDir = findNearestManifestDir(changedPath, jsDirs);
    if (jsDir && jsByDir.has(jsDir)) {
      changedJsDirs.add(jsDir);
    }

    const pythonDir = findNearestManifestDir(changedPath, pythonDirs);
    if (pythonDir && pythonByDir.has(pythonDir)) {
      changedPythonNames.add(pythonByDir.get(pythonDir).name);
    }
  }

  if (entry.status.startsWith("D")) {
    const deletedPath = entry.paths[0];

    if (deletedPath.endsWith("/package.json") && !manifestExists(repoRoot, deletedPath)) {
      fullJs = true;
    }

    if (deletedPath.endsWith("/pyproject.toml") && !manifestExists(repoRoot, deletedPath)) {
      fullPython = true;
    }
  }
}

const mcpfnOnly =
  runMcpfn &&
  changedPaths.every((changedPath) =>
    matchesAny(MCPFN_PATTERNS, changedPath) ||
    matchesAny(MCPFN_SUPPORT_PATTERNS, changedPath));

const selectedJsPackages = fullJs
  ? jsPackages
  : [...changedJsDirs].map((dir) => jsByDir.get(dir)).filter(Boolean);

const selectedPythonPackages = fullPython
  ? pythonPackages
  : [...collectPythonDependents(changedPythonNames, pythonByName)]
      .map((packageName) => pythonByName.get(packageName))
      .filter(Boolean);

const jsBuildPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.build).map((manifest) => manifest.dir)
);
const jsTestPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.test).map((manifest) => manifest.dir)
);
const jsLintPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.lint).map((manifest) => manifest.dir)
);
const jsTypecheckPackages = new Set(
  selectedJsPackages.filter((manifest) => manifest.scripts.typecheck).map((manifest) => manifest.dir)
);

const pythonMatrix = selectedPythonPackages
  .map((manifest) => ({ name: manifest.name, path: manifest.dir }))
  .sort((left, right) => left.path.localeCompare(right.path));

const summary = {
  baseRef,
  changedFiles: changedPaths,
  fullJs,
  fullPython,
  runMcpfn,
  mcpfnOnly,
  jsPackages: selectedJsPackages.map((manifest) => manifest.name).sort(),
  pythonPackages: pythonMatrix,
};

console.log(JSON.stringify(summary, null, 2));

writeOutput("base_ref", baseRef);
writeOutput("changed_files_count", String(changedPaths.length));
writeOutput("run_js", String(fullJs || selectedJsPackages.length > 0));
writeOutput("full_js", String(fullJs));
writeOutput("has_js_build", String(fullJs || jsBuildPackages.size > 0));
writeOutput("has_js_test", String(fullJs || jsTestPackages.size > 0));
writeOutput("has_js_lint", String(fullJs || jsLintPackages.size > 0));
writeOutput("has_js_typecheck", String(fullJs || jsTypecheckPackages.size > 0));
writeOutput("js_build_filters", fullJs ? "" : buildTurboFilters(jsBuildPackages));
writeOutput("js_test_filters", fullJs ? "" : buildTurboFilters(jsTestPackages));
writeOutput("js_lint_filters", fullJs ? "" : buildTurboFilters(jsLintPackages));
writeOutput("js_typecheck_filters", fullJs ? "" : buildTurboFilters(jsTypecheckPackages));
writeOutput("run_python", String(fullPython || pythonMatrix.length > 0));
writeOutput("full_python", String(fullPython));
writeOutput("python_matrix", JSON.stringify(pythonMatrix));
writeOutput("run_mcpfn", String(runMcpfn));
writeOutput("mcpfn_only", String(mcpfnOnly));
