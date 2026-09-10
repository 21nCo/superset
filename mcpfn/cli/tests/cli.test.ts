import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpFnRegistry,
  createManifest,
  structuredResult,
} from "@mcpfn/core";

import {
  loadManifestSource,
  loadScenarios,
  MCPFN_CLI_VERSION,
  parseHttpHeaders,
  runCli,
} from "../src/index.js";

const testRequire = createRequire(import.meta.url);

describe("mcpfn CLI", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps the reported CLI version aligned with the package manifest", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(MCPFN_CLI_VERSION).toBe(packageJson.version);
  });

  it("returns usage exit code 2 when a command is missing or unknown", async () => {
    let errors = "";
    expect(await runCli([], { stderr: (value) => { errors += value; } })).toBe(2);
    expect(errors).toContain("A command is required");

    errors = "";
    expect(await runCli(["not-a-command"], {
      stderr: (value) => { errors += value; },
    })).toBe(2);
    expect(errors).toContain("Unknown command: not-a-command");

    errors = "";
    expect(await runCli([
      "auth-diagnose",
      "https://mcp.example.com/mcp",
      "--timeout",
      "10ms",
    ], { stderr: (value) => { errors += value; } })).toBe(2);
    expect(errors).toContain("--timeout must be a positive integer");
  });

  it("parses repeatable HTTP credential headers without accepting header injection", () => {
    const headers = parseHttpHeaders([
      "Authorization: Bearer test-token",
      "X-Workspace: fixture",
    ]);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("x-workspace")).toBe("fixture");
    expect(() => parseHttpHeaders("missing separator")).toThrow(/valid HTTP header name/);
    expect(() => parseHttpHeaders("Authorization: bearer\r\ninjected: value"))
      .toThrow(/single-line value/);
  });

  it("validates and diffs manifests with stable exit codes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-"));
    roots.push(root);
    const make = (required: string[]) => {
      const registry = new McpFnRegistry().register({
        name: "tool",
        description: "A tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" }, label: { type: "string" } },
          required,
        },
        handler: async () => structuredResult({ ok: true }),
      });
      return createManifest({ name: "test", version: "1.0.0" }, registry);
    };
    await writeFile(path.join(root, "before.json"), JSON.stringify(make(["value"])));
    await writeFile(path.join(root, "after.json"), JSON.stringify(make(["value", "label"])));
    let output = "";
    expect(await runCli(["validate", "before.json"], { cwd: root, stdout: (value) => { output += value; } })).toBe(0);
    expect(output).toContain("Valid McpFn manifest");
    expect(await runCli(["diff", "before.json", "after.json", "--json"], { cwd: root, stdout: (value) => { output += value; } })).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, "before.json"), "utf8")).formatVersion).toBe(1);
  });

  it("loads a server by public shape across package-instance boundaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-server-"));
    roots.push(root);
    const manifest = createManifest({ name: "foreign", version: "1.0.0" }, new McpFnRegistry());
    await writeFile(
      path.join(root, "server.mjs"),
      `export default {
        manifest() { return ${JSON.stringify(manifest)}; },
        async connect() {},
        async close() {}
      };`,
    );

    await expect(loadManifestSource("server.mjs", root)).resolves.toMatchObject({
      manifest: { server: { name: "foreign" } },
      server: expect.any(Object),
    });

    const coreUrl = pathToFileURL(testRequire.resolve("@mcpfn/core")).href;
    await writeFile(
      path.join(root, "declaration.mjs"),
      `import { defineMcpFnServer } from ${JSON.stringify(coreUrl)};
       export default defineMcpFnServer({ info: { name: "declared", version: "1.0.0" } });`,
    );
    const declarationOnly = await loadManifestSource("declaration.mjs", root);
    expect(declarationOnly).toMatchObject({
      manifest: { server: { name: "declared" } },
    });
    expect(declarationOnly).not.toHaveProperty("server");
    await expect(loadManifestSource("declaration.mjs", root, undefined, {})).resolves.toMatchObject({
      manifest: { server: { name: "declared" } },
      server: expect.any(Object),
    });

    await writeFile(
      path.join(root, "registry.mjs"),
      `const tools = ["z", "a"].map((name) => ({
         name, description: name, inputSchema: { type: "object" }, handler: async () => ({ content: [] })
       }));
       export default {
         definitions() { return tools; },
         resourceDefinitions() { return []; },
         resourceTemplateDefinitions() { return []; },
         promptDefinitions() { return []; },
         capabilities() { return { tools: {} }; },
         listTools() { return tools; },
         async callTool() { return { content: [] }; }
       };`,
    );
    await expect(loadManifestSource("registry.mjs", root, {
      name: "foreign",
      version: "1.0.0",
    })).rejects.toThrow(/sorted and unique/);
  });

  it("loads task-capable declaration manifests without constructing a runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-task-manifest-"));
    roots.push(root);
    const coreUrl = pathToFileURL(testRequire.resolve("@mcpfn/core")).href;
    await writeFile(
      path.join(root, "tasks.mjs"),
      `import { defineMcpFnServer, structuredResult } from ${JSON.stringify(coreUrl)};
       export default defineMcpFnServer({
         info: { name: "tasks", version: "1.0.0" },
         tools: [{
           name: "deferred", description: "Deferred work.", inputSchema: { type: "object" },
           execution: { taskSupport: "required" },
           handler: async () => structuredResult({ ok: true }),
           taskHandler: { createTask: async () => { throw new Error("not invoked"); } }
         }]
       });`,
    );
    let output = "";

    expect(await runCli(["manifest", "tasks.mjs"], {
      cwd: root,
      stdout: (value) => { output += value; },
    })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      server: { name: "tasks" },
      capabilities: { tasks: { requests: { tools: { call: {} } } } },
    });
  });

  it("enforces max-report-bytes against the exact CLI serialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-report-cap-"));
    roots.push(root);
    const coreUrl = pathToFileURL(testRequire.resolve("@mcpfn/core")).href;
    await writeFile(
      path.join(root, "server.mjs"),
      `import { defineMcpFnServer, structuredResult } from ${JSON.stringify(coreUrl)};
       export default defineMcpFnServer({
         info: { name: "report-cap", version: "1.0.0" },
         tools: [{
           name: "noop", description: "No operation.", inputSchema: { type: "object" },
           handler: async () => structuredResult({ ok: true })
         }]
       });`,
    );
    await writeFile(
      path.join(root, "scenarios.json"),
      JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
        name: `initialize ${index} ${"x".repeat(80)}`,
        kind: "initialize",
      }))),
    );
    let output = "";
    const exitCode = await runCli([
      "test",
      "server.mjs",
      "scenarios.json",
      "--max-report-bytes",
      "1025",
    ], { cwd: root, stdout: (value) => { output += value; } });

    expect(exitCode).toBe(1);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(1_025);
    expect(JSON.parse(output)).toMatchObject({ status: "incomplete" });
  });

  it("returns test-failure exit code 1 for a manifest contract mismatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-mismatch-"));
    roots.push(root);
    const coreUrl = pathToFileURL(testRequire.resolve("@mcpfn/core")).href;
    const stale = createManifest(
      { name: "mismatch", version: "1.0.0" },
      new McpFnRegistry(),
    );
    await writeFile(
      path.join(root, "server.mjs"),
      `import { McpFnRegistry, createMcpFnServer, structuredResult } from ${JSON.stringify(coreUrl)};
       const actualRegistry = new McpFnRegistry().register({
         name: "actual", description: "Actual tool.", inputSchema: { type: "object" },
         handler: async () => structuredResult({ ok: true })
       });
       const actual = createMcpFnServer({
         info: { name: "mismatch", version: "1.0.0" }, registry: actualRegistry
       });
       const stale = ${JSON.stringify(stale)};
       export default {
         manifest() { return stale; },
         connect(transport) { return actual.connect(transport); },
         close() { return actual.close(); }
       };`,
    );
    await writeFile(path.join(root, "scenarios.mjs"), "export default [];\n");
    let errors = "";
    const exitCode = await runCli(["test", "server.mjs", "scenarios.mjs"], {
      cwd: root,
      stderr: (value) => { errors += value; },
    });
    expect(errors).toContain("Tool inventory mismatch");
    expect(exitCode).toBe(1);
  });

  it("loads every shared scenario operation shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-scenarios-"));
    roots.push(root);
    await writeFile(
      path.join(root, "scenarios.mjs"),
      `export default { formatVersion: 1, kind: "mcpfn.scenarios", status: "complete", scenarios: [
        { name: "tool", kind: "tools.call", tool: "echo" },
        { name: "task-create", kind: "tools.call:task", tool: "echo" },
        { name: "task", kind: "tasks.get", taskId: "task-1" },
        { name: "resource", kind: "resources.read", uri: "memory://one" },
        { name: "prompt", kind: "prompts.get", prompt: "summarize" },
        { name: "inventory", kind: "tools.list", expectNames: ["echo"] },
        { name: "initialize", kind: "initialize", expectCapabilities: {} },
        { name: "event", kind: "events.expect", event: "logging.message" },
        { name: "auth", kind: "auth.assert", phase: "token", expect: { outcome: "allowed" } }
      ] };`,
    );

    await expect(loadScenarios("scenarios.mjs", root)).resolves.toHaveLength(9);
  });

  it("rejects an incomplete portable scenario artifact before either test command runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-incomplete-scenarios-"));
    roots.push(root);
    await writeFile(
      path.join(root, "scenarios.json"),
      JSON.stringify({
        formatVersion: 1,
        kind: "mcpfn.scenarios",
        status: "incomplete",
        incompleteReason: "Live-provider evidence is pending",
        scenarios: [{ name: "individually complete", kind: "initialize" }],
      }),
    );

    await expect(loadScenarios("scenarios.json", root)).rejects.toThrow(
      "McpFn scenario artifact is incomplete: Live-provider evidence is pending",
    );
  });

  it("classifies target connection failures as runtime exit 1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcpfn-cli-runtime-"));
    roots.push(root);
    await writeFile(path.join(root, "scenarios.json"), "[]\n");
    let errors = "";
    const exitCode = await runCli([
      "test-target",
      "mcpfn-command-that-does-not-exist",
      "scenarios.json",
      "--stdio",
    ], {
      cwd: root,
      stderr: (value) => { errors += value; },
    });
    expect(exitCode).toBe(1);
    expect(errors).toContain("Failed to connect and initialize the MCP session");
  });
});
