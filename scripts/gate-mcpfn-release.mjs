#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor < 22) {
  console.error(
    JSON.stringify({
      ok: false,
      error: `npm run gate:mcpfn-release requires Node.js 22 or newer for the official conformance runner; current runtime is ${process.versions.node}`,
    }),
  );
  process.exit(1);
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mcpfn-release-"));
const candidateManifest = path.join(temporaryRoot, "calculator.manifest.json");
const scenarioReport = path.join(temporaryRoot, "calculator.report.json");
const results = [];

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
  const record = {
    name,
    command: [command, ...args].join(" "),
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
  results.push(record);
  if (!record.ok) {
    throw new Error(
      `${name} failed with ${record.status}\n${record.stdout}\n${record.stderr}`,
    );
  }
  return record;
}

function npmStep(name, args, options) {
  return run(name, process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function packageVersion(packagePath) {
  return JSON.parse(
    readFileSync(path.join(repoRoot, packagePath, "package.json"), "utf8"),
  ).version;
}

function verifyMcpSdkSecurityPolicy() {
  const expectedVersion = "1.29.0";
  const expectedOverrides = {
    "fast-uri": "3.1.5",
    nanoid: "3.3.18",
  };
  const packagePaths = [
    "mcpfn/core",
    "mcpfn/client",
    "mcpfn/auth",
    "mcpfn/testing",
    "mcpfn/inspector",
    "mcpfn/cli",
  ];
  const resolvedVersions = Object.fromEntries(
    packagePaths.map((packagePath) => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, packagePath, "package.json"), "utf8"),
      );
      return [packagePath, manifest.dependencies?.["@modelcontextprotocol/sdk"]];
    }),
  );
  const mismatches = Object.entries(resolvedVersions).filter(
    ([, version]) => version !== expectedVersion,
  );
  const rootManifest = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const resolvedOverrides = Object.fromEntries(
    Object.keys(expectedOverrides).map((name) => [name, rootManifest.overrides?.[name]]),
  );
  const overrideMismatches = Object.entries(expectedOverrides).filter(
    ([name, version]) => resolvedOverrides[name] !== version,
  );
  const ok = mismatches.length === 0 && overrideMismatches.length === 0;
  results.push({
    name: "dependencies:mcp-sdk-security-policy",
    command: "internal MCP SDK security version check",
    ok,
    status: ok ? 0 : 1,
    stdout: JSON.stringify({
      expectedVersion,
      resolvedVersions,
      expectedOverrides,
      resolvedOverrides,
    }),
    stderr: "",
  });
  if (!ok) {
    throw new Error(
      `McpFn dependency security policy failed: ${JSON.stringify({ mismatches, overrideMismatches })}`,
    );
  }
}

function verifyDocumentation() {
  const files = [
    "mcpfn/README.md",
    "mcpfn/ARCHITECTURE.md",
    "mcpfn/ADOPTION.md",
    "mcpfn/TESTING.md",
    "mcpfn/MIGRATION.md",
    "mcpfn/REQUIREMENTS.md",
    "mcpfn/TEST_VECTORS.md",
    "mcpfn/ADR-0001-COMPATIBILITY.md",
    "mcpfn/core/README.md",
    "mcpfn/client/README.md",
    "mcpfn/auth/README.md",
    "mcpfn/testing/README.md",
    "mcpfn/inspector/README.md",
    "mcpfn/datafn/README.md",
    "mcpfn/cli/README.md",
  ];
  const missing = [];
  const absolutePaths = [];
  const placeholderFiles = [];
  let gateMentions = 0;
  for (const file of files) {
    let source;
    try {
      source = readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      missing.push(file);
      continue;
    }
    if (/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/.test(source)) {
      absolutePaths.push(file);
    }
    if (/\b(?:TODO|FIXME|coming soon|placeholder|scaffold)\b/i.test(source)) {
      placeholderFiles.push(file);
    }
    if (source.includes("npm run gate:mcpfn-release")) gateMentions += 1;
  }
  const ok =
    missing.length === 0 &&
    absolutePaths.length === 0 &&
    placeholderFiles.length === 0 &&
    gateMentions >= 2;
  results.push({
    name: "documentation",
    command: "internal documentation inventory",
    ok,
    status: ok ? 0 : 1,
    stdout: JSON.stringify({ files, missing, absolutePaths, placeholderFiles, gateMentions }),
    stderr: "",
  });
  if (!ok) throw new Error("McpFn documentation inventory failed");
}

function verifyNamedConsumerParity() {
  const source = readFileSync(path.join(repoRoot, "mcpfn/datafn/src/adapter.ts"), "utf8");
  const queryCalls = (source.match(/options\.executor\.query\(/g) ?? []).length;
  const mutationCalls = (source.match(/options\.executor\.mutate\(/g) ?? []).length;
  const alternateNetworkWriter = /\bfetch\s*\(|https?:\/\//.test(source);
  const ok = queryCalls >= 2 && mutationCalls >= 1 && !alternateNetworkWriter;
  results.push({
    name: "named-consumer:datafn-single-writer",
    command: "internal DataFn adapter ownership check",
    ok,
    status: ok ? 0 : 1,
    stdout: JSON.stringify({
      consumer: "@mcpfn/datafn",
      queryCalls,
      mutationCalls,
      alternateNetworkWriter,
    }),
    stderr: "",
  });
  if (!ok) throw new Error("Named DataFn consumer has an unverified writer path");
}

function verifyPackage(packagePath) {
  const result = npmStep(
    `pack:${packagePath}`,
    ["pack", "--dry-run", "--json"],
    { cwd: path.join(repoRoot, packagePath) },
  );
  const packed = JSON.parse(result.stdout)[0];
  const files = new Set(packed.files.map((entry) => entry.path));
  const requiredFiles = [
    "README.md",
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
  ];
  if (packagePath === "mcpfn/testing") {
    requiredFiles.push(
      "dist/auth.js",
      "dist/auth.cjs",
      "dist/auth.d.ts",
      "dist/auth.d.cts",
      "dist/playwright.js",
      "dist/playwright.cjs",
      "dist/playwright.d.ts",
      "dist/playwright.d.cts",
    );
  }
  if (packagePath === "mcpfn/cli") requiredFiles.push("dist/bin.js");
  for (const required of requiredFiles) {
    if (!files.has(required)) {
      throw new Error(`${packagePath} package is missing ${required}`);
    }
  }
  if (packagePath === "mcpfn/cli") {
    const bin = packed.files.find((entry) => entry.path === "dist/bin.js");
    if (!bin || (bin.mode & 0o111) === 0) {
      throw new Error("mcpfn/cli package bin is not executable");
    }
  }
}

function verifyPackedConsumer() {
  const consumerRoot = path.join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const packagePaths = [
    "packages/auth",
    "packages/observability",
    "packages/db",
    "packages/http",
    "packages/oauth-storage",
    "packages/oauth-core",
    "datafn/core",
    "datafn/server",
    "mcpfn/core",
    "mcpfn/client",
    "mcpfn/auth",
    "mcpfn/testing",
    "mcpfn/inspector",
    "mcpfn/datafn",
    "mcpfn/cli",
  ];
  const tarballs = packagePaths.map((packagePath) => {
    const packed = npmStep(
      `consumer:pack:${packagePath}`,
      ["pack", "--json", "--pack-destination", temporaryRoot],
      { cwd: path.join(repoRoot, packagePath) },
    );
    return path.join(temporaryRoot, JSON.parse(packed.stdout)[0].filename);
  });
  npmStep(
    "consumer:install",
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ],
    { cwd: consumerRoot },
  );
  const packageNames = [
    "@superfunctions/oauth-core",
    "@mcpfn/core",
    "@mcpfn/client",
    "@mcpfn/auth",
    "@mcpfn/testing",
    "@mcpfn/inspector",
    "@mcpfn/datafn",
    "@mcpfn/cli",
  ];
  run("consumer:esm-import", process.execPath, [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(packageNames)}) { const loaded = await import(name); if (!Object.keys(loaded).length) throw new Error(name + " has no exports"); }`,
  ], { cwd: consumerRoot });
  run("consumer:cjs-require", process.execPath, [
    "-e",
    `for (const name of ${JSON.stringify(packageNames)}) { const loaded = require(name); if (!Object.keys(loaded).length) throw new Error(name + " has no exports"); }`,
  ], { cwd: consumerRoot });
  run("consumer:external-harness-exports", process.execPath, [
    "--input-type=module",
    "-e",
    `const testing = await import("@mcpfn/testing"); for (const name of ["authenticatedHttpTarget", "runMcpFnTargetSuite", "createMcpFnTargetSuiteJUnit", "runAuthenticatedOfficialConformance", "createHostedAuthorizationFixtures"]) { if (typeof testing[name] !== "function") throw new Error("missing export " + name); }`,
  ], { cwd: consumerRoot });

  const stdioServer = path.join(consumerRoot, "stdio-server.mjs");
  const roundtrip = path.join(consumerRoot, "roundtrip.mjs");
  writeFileSync(stdioServer, `
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";
const server = createMcpFnServer({
  info: { name: "packed-stdio", version: "1.0.0" },
  registry: new McpFnRegistry().register({
    name: "packed_sum",
    description: "Add values from an installed tarball.",
    inputSchema: { type: "object" },
    handler: async ({ left, right }) => structuredResult({ result: left + right }),
  }),
});
await server.serveStdio();
`);
  writeFileSync(roundtrip, String.raw`
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createMcpFnClient,
  stdioTarget,
  streamableHttpTarget,
} from "@mcpfn/client";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";

async function call(target) {
  const client = createMcpFnClient({ target });
  await client.connect();
  try {
    const result = await client.tools.call("packed_sum", { left: 2, right: 3 });
    assert.deepEqual(result.structuredContent, { result: 5 });
  } finally {
    await client.close();
  }
}

await call(stdioTarget({ command: process.execPath, args: [${JSON.stringify(stdioServer)}] }));

const mcp = createMcpFnServer({
  info: { name: "packed-http", version: "1.0.0" },
  registry: new McpFnRegistry().register({
    name: "packed_sum",
    description: "Add values from an installed tarball.",
    inputSchema: { type: "object" },
    handler: async ({ left, right }) => structuredResult({ result: left + right }),
  }),
});
const handler = await mcp.createWebStandardHandler({ enableJsonResponse: true });
const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://" + request.headers.host);
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const webResponse = await handler(new Request(url, {
    method: request.method,
    headers: new Headers(Object.entries(request.headers).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => [key, entry])
        : value === undefined ? [] : [[key, value]]
    )),
    ...(body.length ? { body } : {}),
  }));
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
});
await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
try {
  const address = httpServer.address();
  await call(streamableHttpTarget("http://127.0.0.1:" + address.port + "/mcp"));
} finally {
  await mcp.close();
  await new Promise((resolve) => httpServer.close(resolve));
}
process.stdout.write(JSON.stringify({ ok: true, transports: ["stdio", "streamable-http"] }) + "\n");
`);
  run("consumer:roundtrip", process.execPath, [roundtrip], {
    cwd: consumerRoot,
    timeout: 30_000,
  });
}

try {
  verifyMcpSdkSecurityPolicy();
  for (const workspace of [
    "@superfunctions/auth",
    "@superfunctions/observability",
    "@superfunctions/db",
    "@superfunctions/oauth-storage",
  ]) {
    npmStep(`dependency:build:${workspace}`, ["run", "build", "--workspace", workspace]);
  }
  npmStep("oauth-core:typecheck", ["run", "typecheck", "--workspace", "@superfunctions/oauth-core"]);
  npmStep("oauth-core:test", ["run", "test", "--workspace", "@superfunctions/oauth-core"]);
  npmStep("oauth-core:build", ["run", "build", "--workspace", "@superfunctions/oauth-core"]);

  npmStep("core:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/core"]);
  npmStep("core:test", ["run", "test", "--workspace", "@mcpfn/core"]);
  npmStep("core:build", ["run", "build", "--workspace", "@mcpfn/core"]);

  npmStep("client:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/client"]);
  npmStep("client:test", ["run", "test", "--workspace", "@mcpfn/client"]);
  npmStep("client:build", ["run", "build", "--workspace", "@mcpfn/client"]);

  npmStep("auth:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/auth"]);
  npmStep("auth:test", ["run", "test", "--workspace", "@mcpfn/auth"]);
  npmStep("auth:build", ["run", "build", "--workspace", "@mcpfn/auth"]);

  npmStep("testing:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/testing"]);
  npmStep("testing:test", ["run", "test", "--workspace", "@mcpfn/testing"]);
  npmStep("testing:playwright", ["run", "test:playwright", "--workspace", "@mcpfn/testing"]);
  npmStep("testing:build", ["run", "build", "--workspace", "@mcpfn/testing"]);

  npmStep("inspector:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/inspector"]);
  npmStep("inspector:test", ["run", "test", "--workspace", "@mcpfn/inspector"]);
  npmStep("inspector:build", ["run", "build", "--workspace", "@mcpfn/inspector"]);

  for (const workspace of [
    "@datafn/core",
    "@superfunctions/http",
  ]) {
    npmStep(`dependency:build:${workspace}`, ["run", "build", "--workspace", workspace]);
  }
  npmStep("datafn-server:typecheck", ["run", "typecheck", "--workspace", "@datafn/server"]);
  npmStep("datafn-server:test", ["run", "test", "--workspace", "@datafn/server"]);
  npmStep("datafn-server:build", ["run", "build", "--workspace", "@datafn/server"]);

  npmStep("datafn:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/datafn"]);
  npmStep("named-consumer:datafn-test", ["run", "test", "--workspace", "@mcpfn/datafn"]);
  npmStep("datafn:build", ["run", "build", "--workspace", "@mcpfn/datafn"]);

  npmStep("cli:typecheck", ["run", "typecheck", "--workspace", "@mcpfn/cli"]);
  npmStep("cli:test", ["run", "test", "--workspace", "@mcpfn/cli"]);
  npmStep("cli:build", ["run", "build", "--workspace", "@mcpfn/cli"]);

  for (const [name, packagePath, tagSlug] of [
    ["oauth-core", "packages/oauth-core", "superfunctions-oauth-core"],
    ["core", "mcpfn/core", "mcpfn-core"],
    ["client", "mcpfn/client", "mcpfn-client"],
    ["inspector", "mcpfn/inspector", "mcpfn-inspector"],
    ["auth", "mcpfn/auth", "mcpfn-auth"],
    ["testing", "mcpfn/testing", "mcpfn-testing"],
    ["datafn", "mcpfn/datafn", "mcpfn-datafn"],
    ["cli", "mcpfn/cli", "mcpfn-cli"],
    ["admin", "packages/admin", "superfunctions-admin"],
  ]) {
    run(`release-tag:${name}`, process.execPath, [
      "scripts/resolve-release-tag.mjs",
      `${tagSlug}-v${packageVersion(packagePath)}`,
    ]);
  }

  run("example:manifest", process.execPath, [
    "mcpfn/cli/dist/bin.js", "manifest", "mcpfn/examples/calculator-server.ts", "--output", candidateManifest,
  ]);
  run("example:validate", process.execPath, [
    "mcpfn/cli/dist/bin.js", "validate", "mcpfn/examples/calculator.manifest.json",
  ]);
  run("example:diff", process.execPath, [
    "mcpfn/cli/dist/bin.js", "diff", "mcpfn/examples/calculator.manifest.json", candidateManifest,
    "--fail-on-behavioral",
  ]);
  run("example:scenarios", process.execPath, [
    "mcpfn/cli/dist/bin.js", "test", "mcpfn/examples/calculator-server.ts",
    "mcpfn/examples/calculator-scenarios.ts", "--output", scenarioReport,
  ]);
  run("example:production-client", process.execPath, [
    "scripts/test-mcpfn-calculator-example.mjs",
  ], { timeout: 30_000 });
  run("example:external-authenticated-server", process.execPath, [
    "scripts/test-mcpfn-external-server.mjs",
  ], { timeout: 60_000 });
  run("official:conformance", process.execPath, ["scripts/test-mcpfn-conformance.mjs"]);

  const packageNames = ["@mcpfn/core", "@mcpfn/client", "@mcpfn/auth", "@mcpfn/testing", "@mcpfn/inspector", "@mcpfn/datafn", "@mcpfn/cli"];
  run("packages:esm-import", process.execPath, [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(packageNames)}) { const loaded = await import(name); if (Object.keys(loaded).length === 0) throw new Error(name + " has no ESM exports"); }`,
  ]);
  run("packages:cjs-require", process.execPath, [
    "-e",
    `for (const name of ${JSON.stringify(packageNames)}) { const loaded = require(name); if (Object.keys(loaded).length === 0) throw new Error(name + " has no CJS exports"); }`,
  ]);
  const testingSubpaths = ["@mcpfn/testing/auth", "@mcpfn/testing/playwright"];
  run("testing-subpaths:esm-import", process.execPath, [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(testingSubpaths)}) { const loaded = await import(name); if (Object.keys(loaded).length === 0) throw new Error(name + " has no ESM exports"); }`,
  ]);
  run("testing-subpaths:cjs-require", process.execPath, [
    "-e",
    `for (const name of ${JSON.stringify(testingSubpaths)}) { const loaded = require(name); if (Object.keys(loaded).length === 0) throw new Error(name + " has no CJS exports"); }`,
  ]);

  for (const packagePath of ["mcpfn/core", "mcpfn/client", "mcpfn/auth", "mcpfn/testing", "mcpfn/inspector", "mcpfn/datafn", "mcpfn/cli"]) {
    verifyPackage(packagePath);
  }
  verifyPackedConsumer();
  verifyNamedConsumerParity();
  verifyDocumentation();

  console.log(JSON.stringify({
    ok: true,
    gate: "npm run gate:mcpfn-release",
    steps: results.map(({ stdout, stderr, ...result }) => result),
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    steps: results.map(({ stdout, stderr, ...result }) => result),
  }));
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
