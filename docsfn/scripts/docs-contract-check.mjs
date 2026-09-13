#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");

const docTargets = [
  resolve(docsfnRoot, "README.md"),
  resolve(docsfnRoot, "next", "README.md"),
  resolve(docsfnRoot, "sveltekit", "README.md"),
  resolve(docsfnRoot, "examples", "README.md"),
  resolve(docsfnRoot, "docs", "content", "docs"),
];

const markdownExtensions = new Set([".md", ".mdx"]);

const docsRuleChecks = [
  {
    id: "machine-path",
    code: "DOCS_MACHINE_PATH",
    pattern: /\/Users\/[A-Za-z0-9._/-]+/g,
    message: "public docs must not contain machine-specific absolute paths",
  },
  {
    id: "absolute-path-placeholder",
    code: "DOCS_BUILD_COMMAND_INCONSISTENT",
    pattern: /\/absolute\/path\/to\/site/g,
    message: "public commands must use repo-relative paths or standard CLI examples",
  },
  {
    id: "internal-source-import",
    code: "DOCS_INTERNAL_SOURCE_IMPORT",
    pattern: /node_modules\/@docsfn\/[A-Za-z0-9_-]+\/src\b|@docsfn\/[A-Za-z0-9_-]+\/src\b/g,
    message: "public docs must not depend on internal /src package paths",
  },
  {
    id: "api-dir-docs-tree",
    code: "DOCS_API_MODEL_INCONSISTENT",
    pattern:
      /apiDir:\s*"content\/docs\/api"|content\.apiDir[^.\n]{0,80}(?:set to|point(?:ed|ing)? at|often)[^.\n]{0,80}content\/docs\/api/g,
    message: "content.apiDir must not point at the docs markdown tree in public guidance",
  },
  {
    id: "api-docs-scope-claim",
    code: "DOCS_API_MODEL_INCONSISTENT",
    pattern: /Hand-written\s+\*\*API reference\*\*.*content\/docs\/api.*search\s+\*\*docs\*\*\s+scope\./g,
    message: "hand-written API markdown under /docs/api must not be described as docs-scope-only content",
  },
  {
    id: "legacy-search-runtime-claim",
    code: "DOCS_SEARCH_MODEL_INCONSISTENT",
    pattern: /At query time, core wraps\s+\*\*`InMemorySearchFn`\*\*|artifact embeds a\s+\*\*searchfn\*\*\s+snapshot/gi,
    message: "search docs must describe the current artifact-to-memory-client runtime, not the legacy runtime wording",
  },
];

function compareText(left, right) {
  return left.localeCompare(right);
}

function getLineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

async function pathType(targetPath) {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isDirectory()) {
      return {
        exists: true,
        isDirectory: false,
        entries: null,
      };
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    return {
      exists: true,
      isDirectory: true,
      entries,
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      entries: null,
    };
  }
}

async function collectDocFiles(targetPath, files = []) {
  const descriptor = await pathType(targetPath);
  if (!descriptor.exists) {
    return files;
  }

  if (!descriptor.isDirectory) {
    files.push(targetPath);
    return files;
  }

  const entries = (await readdir(targetPath, { withFileTypes: true })).sort((left, right) =>
    compareText(left.name, right.name)
  );
  for (const entry of entries) {
    const absolutePath = resolve(targetPath, entry.name);
    if (entry.isDirectory()) {
      await collectDocFiles(absolutePath, files);
      continue;
    }
    if (markdownExtensions.has(extname(entry.name)) || entry.name === "README.md") {
      files.push(absolutePath);
    }
  }

  return files;
}

async function loadAllowedPublicImports() {
  const packageRoots = await readdir(docsfnRoot, { withFileTypes: true });
  const allowedImports = new Set();

  for (const entry of packageRoots.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJsonPath = resolve(docsfnRoot, entry.name, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@docsfn/")) {
        continue;
      }
      allowedImports.add(packageJson.name);
      const exportsField = packageJson.exports ?? {};
      for (const key of Object.keys(exportsField)) {
        if (key === ".") {
          allowedImports.add(packageJson.name);
          continue;
        }
        if (key.startsWith("./")) {
          allowedImports.add(`${packageJson.name}/${key.slice(2)}`);
        }
      }
    } catch {
      continue;
    }
  }

  return allowedImports;
}

function collectPublicImportViolations(content, filePath, allowedImports) {
  const violations = [];
  const matches = content.matchAll(/@docsfn\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_./-]+)?/g);

  for (const match of matches) {
    const specifier = match[0];
    if (allowedImports.has(specifier)) {
      continue;
    }

    const line = getLineNumber(content, match.index ?? 0);
    violations.push({
      code: "DOCS_PUBLIC_API_INVALID",
      file: filePath,
      line,
      message: `unsupported public import or package subpath: ${specifier}`,
      sortKey: `${filePath}:${String(line).padStart(6, "0")}:DOCS_PUBLIC_API_INVALID:${specifier}`,
    });
  }

  return violations;
}

function collectPatternViolations(content, filePath) {
  const violations = [];

  for (const rule of docsRuleChecks) {
    const matches = content.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags));
    for (const match of matches) {
      const line = getLineNumber(content, match.index ?? 0);
      violations.push({
        code: rule.code,
        file: filePath,
        line,
        message: rule.message,
        sortKey: `${filePath}:${String(line).padStart(6, "0")}:${rule.code}:${rule.id}`,
      });
    }
  }

  return violations;
}

export async function collectDocsContractStatus() {
  const allowedImports = await loadAllowedPublicImports();
  const docFiles = [];
  for (const target of docTargets) {
    await collectDocFiles(target, docFiles);
  }

  const uniqueFiles = Array.from(new Set(docFiles)).sort(compareText);
  const violations = [];

  for (const filePath of uniqueFiles) {
    const content = await readFile(filePath, "utf8");
    violations.push(...collectPatternViolations(content, filePath));
    violations.push(...collectPublicImportViolations(content, filePath, allowedImports));
  }

  violations.sort((left, right) => compareText(left.sortKey, right.sortKey));

  return {
    ok: violations.length === 0,
    code: violations.length === 0 ? "OK" : violations[0]?.code ?? "DOCS_CONTRACT_FAILED",
    checkedFiles: uniqueFiles,
    violations: violations.map(({ sortKey, ...violation }) => violation),
  };
}

function printStatus(status) {
  console.log(`[docs-contract] checked ${status.checkedFiles.length} public doc files`);
  if (status.ok) {
    console.log("[docs-contract] PASS: public docs align with the current published contract.");
    return;
  }

  for (const violation of status.violations) {
    console.log(`- ${violation.code} ${violation.file}:${violation.line} ${violation.message}`);
  }

  console.error(`\n[docs-contract] ${status.code}: ${status.violations.length} violation(s) detected.`);
}

async function main() {
  const status = await collectDocsContractStatus();
  printStatus(status);
  if (!status.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === scriptPath : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(
      `[docs-contract] DOCS_PUBLIC_API_INVALID: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
