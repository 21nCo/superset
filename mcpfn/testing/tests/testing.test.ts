import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "@mcpfn/core";

import {
  McpFnTestClient,
  MCPFN_HOST_PROFILES,
  assertManifestContract,
  buildOfficialConformanceArgs,
  buildOfficialConformanceEnvironment,
  checkHostCompatibility,
  createAuthenticatedConformanceProxy,
  createMcpFnScenarioArtifact,
  createMcpFnScenarioReport,
  runAuthenticatedOfficialConformance,
  runScenarios,
  validateMcpFnScenarios,
} from "../src/index.js";

describe("McpFn testing", () => {
  it("checks manifests and deterministic semantic scenarios", async () => {
    const registry = new McpFnRegistry().register({
      name: "echo",
      description: "Echo a value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async ({ value }) => structuredResult({ value }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = await McpFnTestClient.connect(server);
    try {
      await expect(assertManifestContract(client, server.manifest())).resolves.toHaveLength(1);
      const results = await runScenarios(client, [
        {
          name: "echoes",
          tool: "echo",
          arguments: { value: "hello" },
          expect: {
            structuredContent: { value: "hello" },
            structuredTextParity: true,
          },
        },
      ]);
      expect(results).toMatchObject([{ status: "passed" }]);
      const redactedFailure = await runScenarios(client, [{
        name: "redacts verifier errors",
        tool: "echo",
        arguments: { value: "hello" },
        verify: () => {
          throw new Error(
            "failed at https://client.example/callback?api_key=secret#access_token=token",
          );
        },
      }]);
      expect(JSON.stringify(redactedFailure)).not.toContain("secret");
      expect(JSON.stringify(redactedFailure)).not.toContain("access_token=token");
      expect(JSON.stringify(redactedFailure)).toContain("REDACTED");

      const artifact = createMcpFnScenarioArtifact([{
        formatVersion: 1,
        name: "deferred live smoke",
        kind: "auth.assert",
        phase: "provider-login",
        expect: { outcome: "allowed" },
        status: "incomplete",
        incompleteReason: "Requires controlled live-provider credentials",
      }], { status: "incomplete", incompleteReason: "Controlled-live lane" });
      expect(() => validateMcpFnScenarios(artifact)).toThrow(
        "McpFn scenario artifact is incomplete: Controlled-live lane",
      );
      expect(() => validateMcpFnScenarios([{
        name: "mistyped scenario status",
        tool: "echo",
        status: "incomplate",
      }])).toThrow("status must be complete or incomplete");
      for (const minimum of [-1, 0, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
        expect(() => validateMcpFnScenarios([{
          name: "invalid event minimum",
          kind: "events.expect",
          event: "resources.subscribed",
          minimum,
        }])).toThrow("events.expect minimum must be a positive integer");
      }
      const auth = vi.fn(async (scenario: { phase: string }) => {
        if (scenario.phase === "slow-provider") {
          await new Promise(() => undefined);
        }
        return { outcome: "allowed" as const, code: "AUTHORIZED" };
      });
      const lifecycle = await runScenarios(client, [
        ...artifact.scenarios,
        {
          formatVersion: 1,
          name: "deterministic auth assertion",
          kind: "auth.assert",
          phase: "token-exchange",
          expect: { outcome: "allowed", code: "AUTHORIZED" },
        },
        {
          formatVersion: 1,
          name: "bounded timeout",
          kind: "auth.assert",
          phase: "slow-provider",
          timeoutMs: 5,
          expect: { outcome: "allowed" },
        },
        {
          formatVersion: 1,
          name: "skipped after timeout",
          kind: "auth.assert",
          phase: "must-not-overlap",
          expect: { outcome: "allowed" },
        },
      ], {
        auth,
      });
      expect(lifecycle.map((result) => result.status)).toEqual([
        "incomplete",
        "passed",
        "failed",
        "incomplete",
      ]);
      expect(lifecycle[3]?.error).toContain("Skipped after timed-out scenario");
      expect(auth.mock.calls.map(([scenario]) => scenario.phase)).toEqual([
        "token-exchange",
        "slow-provider",
      ]);
      const boundedReport = createMcpFnScenarioReport(
        Array.from({ length: 30 }, (_, index) => ({
          ...lifecycle[2],
          name: `large-${index}-${"x".repeat(100)}`,
        })),
        { maxBytes: 1_024 },
      );
      expect(boundedReport.status).toBe("incomplete");
      expect(boundedReport.droppedResults).toBeGreaterThan(0);
      expect(new TextEncoder().encode(JSON.stringify(boundedReport)).byteLength)
        .toBeLessThanOrEqual(1_024);

      const emitNotifications = vi.spyOn(client.session, "onEvent");
      let observeEvent: ((event: Parameters<Parameters<typeof client.session.onEvent>[0]>[0]) => void) |
        undefined;
      emitNotifications.mockImplementation((listener) => {
        observeEvent = listener;
        return () => undefined;
      });
      const eventBounded = await runScenarios(client, [{
        name: "bounded observed events",
        kind: "auth.assert",
        phase: "emit-events",
        expect: { outcome: "allowed" },
      }], {
        maxObservedEvents: 2,
        auth: async () => {
          for (let index = 0; index < 5; index += 1) {
            observeEvent?.({ kind: "logging.message", payload: { index } });
          }
          return { outcome: "allowed" };
        },
      });
      const eventBoundedReport = createMcpFnScenarioReport(eventBounded);
      expect(eventBounded).toMatchObject([{ status: "passed", droppedObservedEvents: 3 }]);
      expect(eventBoundedReport).toMatchObject({
        status: "incomplete",
        droppedObservedEvents: 3,
        incompleteReason: "Observed client events exceeded maxObservedEvents",
      });
      emitNotifications.mockRestore();
    } finally {
      await client.close();
    }
  });

  it("attributes observed-event loss while later scenarios are skipped", async () => {
    const client = await McpFnTestClient.connect(createMcpFnServer({
      info: { name: "event-loss-after-timeout", version: "1.0.0" },
      registry: new McpFnRegistry(),
    }));
    const onEvent = vi.spyOn(client.session, "onEvent");
    let observeEvent: ((event: Parameters<Parameters<typeof client.session.onEvent>[0]>[0]) => void) |
      undefined;
    onEvent.mockImplementation((listener) => {
      observeEvent = listener;
      return () => undefined;
    });
    const skippedScenario = {
      get name() {
        for (let index = 0; index < 5; index += 1) {
          observeEvent?.({ kind: "logging.message", payload: { index } });
        }
        return "skipped while events continue";
      },
      kind: "auth.assert" as const,
      phase: "must-not-run",
      expect: { outcome: "allowed" as const },
    };
    try {
      const results = await runScenarios(client, [
        {
          name: "times out",
          kind: "auth.assert",
          phase: "never-settles",
          timeoutMs: 5,
          expect: { outcome: "allowed" },
        },
        skippedScenario,
      ], {
        maxObservedEvents: 2,
        auth: async () => new Promise(() => undefined),
      });

      expect(results).toMatchObject([
        { status: "failed" },
        { status: "incomplete", droppedObservedEvents: 3 },
      ]);
      expect(createMcpFnScenarioReport(results)).toMatchObject({
        status: "incomplete",
        droppedObservedEvents: 3,
        incompleteReason: "Observed client events exceeded maxObservedEvents",
      });
    } finally {
      onEvent.mockRestore();
      await client.close();
    }
  });

  it("preserves the complete server implementation identity", async () => {
    const server = createMcpFnServer({
      info: {
        name: "identity",
        title: "Identity Server",
        version: "1.0.0",
        description: "Complete implementation metadata.",
        websiteUrl: "https://example.test",
        instructions: "Use the echo tool.",
      },
      registry: new McpFnRegistry(),
    });
    const client = await McpFnTestClient.connect(server);
    try {
      expect(client.client.getServerVersion()).toMatchObject({
        name: "identity",
        title: "Identity Server",
        description: "Complete implementation metadata.",
        websiteUrl: "https://example.test",
      });
    } finally {
      await client.close();
    }
  });

  it("fails unexpected tool errors unless the scenario explicitly expects one", async () => {
    const registry = new McpFnRegistry().register({
      name: "fails",
      description: "Return a tool-level failure.",
      inputSchema: { type: "object" },
      handler: async () => ({
        isError: true,
        content: [{ type: "text", text: "broken" }],
      }),
    });
    const server = createMcpFnServer({
      info: { name: "scenario-errors", version: "1.0.0" },
      registry,
    });
    const client = await McpFnTestClient.connect(server);
    try {
      await expect(runScenarios(client, [{ name: "unexpected", tool: "fails" }]))
        .resolves.toMatchObject([{ status: "failed", error: expect.stringContaining("isError=true") }]);
      await expect(runScenarios(client, [{
        name: "expected",
        tool: "fails",
        expect: { isError: true },
      }])).resolves.toMatchObject([{ status: "passed" }]);
    } finally {
      await client.close();
    }
  });

  it("runs task creation and inventory through the shared scenario contract", async () => {
    const taskStore = new InMemoryTaskStore();
    const registry = new McpFnRegistry().register({
      name: "deferred",
      description: "Create a completed task.",
      inputSchema: { type: "object", additionalProperties: false },
      execution: { taskSupport: "required" },
      handler: async () => structuredResult({ ok: true }),
      taskHandler: {
        createTask: async (_args, _context, extra) => {
          const task = await extra.taskStore.createTask({
            ttl: extra.taskRequestedTtl,
            pollInterval: 1,
          });
          await extra.taskStore.storeTaskResult(
            task.taskId,
            "completed",
            structuredResult({ ok: true }),
          );
          return { task: await extra.taskStore.getTask(task.taskId) };
        },
      },
    });
    const client = await McpFnTestClient.connect(createMcpFnServer({
      info: { name: "task-scenarios", version: "1.0.0" },
      registry,
      taskStore,
    }));
    try {
      await expect(runScenarios(client, [
        { name: "create", kind: "tools.call:task", tool: "deferred", task: { ttl: 5_000 } },
        { name: "list", kind: "tasks.list" },
      ])).resolves.toMatchObject([
        { status: "passed", operation: "tools.call:task" },
        { status: "passed", operation: "tasks.list" },
      ]);
    } finally {
      await client.close();
    }
  });

  it("checks an explicit request-visible tool inventory against the full manifest", async () => {
    const registry = new McpFnRegistry()
      .register({
        name: "hidden",
        description: "Hidden tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      })
      .register({
        name: "visible",
        description: "Visible tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      });
    const server = createMcpFnServer({
      info: { name: "filtered", version: "1.0.0" },
      registry,
      toolVisibility: ({ tool }) => tool.name === "visible",
    });
    const client = await McpFnTestClient.connect(server);
    try {
      const manifest = server.manifest();
      await expect(assertManifestContract(client, manifest)).rejects.toThrow(
        /Tool inventory mismatch/,
      );
      await expect(assertManifestContract(client, manifest, {
        expectedToolNames: ["visible"],
      })).resolves.toMatchObject([{ name: "visible" }]);
      await expect(assertManifestContract(client, manifest, {
        expectedToolNames: ["missing"],
      })).rejects.toThrow(/absent from the manifest/);
    } finally {
      await client.close();
    }
  });

  it("rejects stale resource and prompt inventories and ignores undefined scenario fields", async () => {
    const registry = new McpFnRegistry()
      .register({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ value: "ok" }),
      })
      .registerResource({
        uri: "docs://one",
        name: "one",
        read: async () => ({ contents: [{ uri: "docs://one", text: "One" }] }),
      })
      .registerResource({
        uri: "docs://two",
        name: "two",
        read: async () => ({ contents: [{ uri: "docs://two", text: "Two" }] }),
      })
      .registerPrompt({ name: "one", get: async () => ({ messages: [] }) })
      .registerPrompt({ name: "two", get: async () => ({ messages: [] }) });
    const server = createMcpFnServer({
      info: { name: "inventory", version: "1.0.0" },
      registry,
    });
    const client = await McpFnTestClient.connect(server);
    try {
      const manifest = server.manifest();
      await expect(assertManifestContract(client, {
        ...manifest,
        resources: manifest.resources?.slice(1),
      })).rejects.toThrow(/Resource inventory mismatch/);
      await expect(assertManifestContract(client, {
        ...manifest,
        prompts: manifest.prompts?.slice(1),
      })).rejects.toThrow(/Prompt inventory mismatch/);
      await expect(runScenarios(client, [{
        name: "undefined parity",
        tool: "echo",
        expect: { structuredContent: { value: "ok", omitted: undefined } },
      }])).resolves.toMatchObject([{ status: "passed" }]);
    } finally {
      await client.close();
    }
  });

  it("excludes resources listed by templates from static manifest equality", async () => {
    const registry = new McpFnRegistry()
      .register({
        name: "echo",
        description: "Echo.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ value: "ok" }),
      })
      .registerResource({
        uri: "docs://guide",
        name: "guide",
        subscribe: async () => undefined,
        unsubscribe: async () => undefined,
        read: async () => ({
          contents: [{ uri: "docs://guide", text: "Guide" }],
        }),
      })
      .registerResource({
        uri: "docs://plain",
        name: "plain",
        read: async () => ({
          contents: [{ uri: "docs://plain", text: "Plain" }],
        }),
      })
      .registerResourceTemplate({
        uriTemplate: "docs://users/{id}",
        name: "user",
        list: async () => ({
          resources: [{ uri: "docs://users/42", name: "Ada" }],
        }),
        read: async (uri) => ({
          contents: [{ uri: uri.toString(), text: "Ada" }],
        }),
        subscribe: async () => undefined,
        unsubscribe: async () => undefined,
      });
    const server = createMcpFnServer({
      info: { name: "dynamic-resources", version: "1.0.0" },
      registry,
    });
    const client = await McpFnTestClient.connect(server);
    try {
      const manifest = server.manifest();
      await expect(assertManifestContract(client, manifest)).resolves.toHaveLength(1);
      await expect(runScenarios(client, [
        { name: "subscribe", kind: "resources.subscribe", uri: "docs://guide" },
        {
          name: "observe subscription",
          kind: "events.expect",
          event: "resources.subscribed",
        },
        { name: "unsubscribe", kind: "resources.unsubscribe", uri: "docs://guide" },
        {
          name: "observe unsubscription",
          kind: "events.expect",
          event: "resources.unsubscribed",
        },
      ])).resolves.toMatchObject([
        { status: "passed" },
        { status: "passed" },
        { status: "passed" },
        { status: "passed" },
      ]);
      await expect(assertManifestContract(client, {
        ...manifest,
        resources: manifest.resources?.map((resource) =>
          resource.uri === "docs://plain"
            ? { ...resource, subscribable: true }
            : resource
        ),
      })).rejects.toThrow(/Resource subscription mismatch for docs:\/\/plain/);
      await expect(assertManifestContract(client, {
        ...manifest,
        resources: [],
      })).rejects.toThrow(/Resource inventory mismatch/);
    } finally {
      await client.close();
    }
  });

  it("pins the official conformance runner and its supported server flags", () => {
    expect(buildOfficialConformanceArgs({
      url: "http://127.0.0.1:3000/mcp",
      scenario: "server-initialize",
      outputDir: "/tmp/mcpfn-conformance",
    })).toEqual([
      "--yes",
      "@modelcontextprotocol/conformance@0.1.16",
      "server",
      "--url",
      "http://127.0.0.1:3000/mcp",
      "--scenario",
      "server-initialize",
      "--output-dir",
      "/tmp/mcpfn-conformance",
    ]);
  });

  it("does not inherit selected credential environment variables into conformance", () => {
    const environment = buildOfficialConformanceEnvironment(
      ["MCPFN_TEST_BEARER"],
      { PATH: "/usr/bin", MCPFN_TEST_BEARER: "secret", mcpfn_test_bearer: "secret2", SAFE_VALUE: "kept" },
    );
    expect(environment.MCPFN_TEST_BEARER).toBeUndefined();
    expect(environment.mcpfn_test_bearer).toBeUndefined();
    expect(environment.SAFE_VALUE).toBe("kept");
    expect(environment.PATH).toContain("/usr/bin");
  });

  it("injects credentials through a fixed loopback conformance proxy", async () => {
    const observed: Array<{ authorization?: string; host?: string }> = [];
    const upstream = createServer((request, response) => {
      observed.push({
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(request.headers.host ? { host: request.headers.host } : {}),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("test server did not bind");
    const proxy = await createAuthenticatedConformanceProxy({
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { authorization: "Bearer conformance-secret" },
    });
    try {
      expect(proxy.url).not.toContain("conformance-secret");
      const authenticated = await fetch(proxy.url, {
        headers: { authorization: "Bearer attacker-value" },
      });
      await expect(authenticated.json()).resolves.toEqual({ ok: true });
      const hostileBody = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(
          proxy.url,
          {
            headers: {
              authorization: "Bearer attacker-value",
              host: "untrusted.example.test",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("end", () =>
              resolve(Buffer.concat(chunks).toString()),
            );
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(JSON.parse(hostileBody)).toEqual({ ok: true });
      expect(observed).toEqual([
        {
          authorization: "Bearer conformance-secret",
          host: `127.0.0.1:${address.port}`,
        },
        { host: "untrusted.example.test" },
      ]);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await expect(createAuthenticatedConformanceProxy({
      url: "https://mcp.example.com/mcp",
      headers: { authorization: "Bearer conformance-secret" },
    })).rejects.toThrow(/literal loopback address/);
    await expect(createAuthenticatedConformanceProxy({
      url: "http://127.0.0.1:1/mcp",
      headers: {},
    })).rejects.toThrow(/at least one credential header/);
  });

  it("releases authenticated conformance credentials when proxy setup fails", async () => {
    const revoke = vi.fn();
    const dispose = vi.fn();
    await expect(runAuthenticatedOfficialConformance({
      url: "https://mcp.example.com/mcp",
      credential: {
        acquire: () => ({ headers: { authorization: "Bearer conformance-secret" } }),
        revoke,
        dispose,
      },
    })).rejects.toThrow(/literal loopback address/);
    expect(revoke).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes the conformance proxy while streaming requests are active", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const upstream = createServer(() => requestStarted());
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }
    const proxy = await createAuthenticatedConformanceProxy({
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { authorization: "Bearer conformance-secret" },
    });
    const request = httpRequest(proxy.url);
    request.on("error", () => undefined);
    request.end();
    await started;

    await expect(proxy.close()).resolves.toBeUndefined();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reports degraded and incompatible host-profile matches", () => {
    const registry = new McpFnRegistry()
      .register({
        name: "requires_host",
        description: "Use host features.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      })
      .registerPrompt({
        name: "hello",
        get: async () => ({
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        }),
      });
    const server = createMcpFnServer({
      info: { name: "profiles", version: "1.0.0" },
      registry,
      protocolVersions: ["2025-11-25"],
      clientRequirements: { sampling: true },
    });
    const toolsOnly = checkHostCompatibility(
      server.manifest(),
      MCPFN_HOST_PROFILES.toolsOnly,
    );
    expect(toolsOnly).toMatchObject({ status: "incompatible", compatible: false });
    expect(toolsOnly.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sampling-required" }),
      expect.objectContaining({ code: "server-feature-unavailable", path: "capabilities.prompts" }),
    ]));
    expect(checkHostCompatibility(
      server.manifest(),
      MCPFN_HOST_PROFILES.fullProtocol,
    )).toMatchObject({ status: "compatible", compatible: true });

    const optionalPromptServer = createMcpFnServer({
      info: { name: "optional-prompts", version: "1.0.0" },
      registry: new McpFnRegistry().registerPrompt({
        name: "optional",
        get: async () => ({ messages: [] }),
      }),
      protocolVersions: ["2025-11-25"],
    });
    expect(checkHostCompatibility(
      optionalPromptServer.manifest(),
      MCPFN_HOST_PROFILES.toolsOnly,
    )).toMatchObject({
      status: "degraded",
      compatible: true,
      issues: [expect.objectContaining({
        code: "server-feature-unavailable",
        path: "capabilities.prompts",
      })],
    });
  });
});
