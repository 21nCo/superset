import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";

import { createMcpFnClient, customTarget } from "../src/index.js";
import type { McpFnTransportHandle } from "../src/index.js";

describe("McpFn production client", () => {
  it("shares the official session engine and paginates complete inventories", async () => {
    const registry = new McpFnRegistry()
      .register({
        name: "one",
        description: "One.",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async () => structuredResult({ value: 1 }),
      })
      .register({
        name: "two",
        description: "Two.",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async () => structuredResult({ value: 2 }),
      });
    const server = createMcpFnServer({
      info: { name: "client-test", version: "1.0.0" },
      registry,
      pageSize: 1,
    });
    const events: Array<{ phase: string; details?: Record<string, unknown> }> = [];
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      diagnostics: (event) => events.push(event),
    });

    await client.connect();
    await expect(client.tools.listAll()).resolves.toHaveLength(2);
    await expect(client.tools.listBounded(1)).resolves.toMatchObject({
      items: [{ name: "one" }],
      droppedItems: 1,
      complete: false,
    });
    await expect(client.tools.call("two")).resolves.toMatchObject({
      structuredContent: { value: 2 },
    });
    expect(client.getServerVersion()).toMatchObject({ name: "client-test" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "mcp-initialize" }),
      expect.objectContaining({
        phase: "capability-operation",
        details: expect.objectContaining({ operation: "tools/call" }),
      }),
    ]));
    await client.close();
  });

  it("rejects repeated inventory cursors and enforces the overall page cap", async () => {
    const server = createMcpFnServer({
      info: { name: "pagination-bounds", version: "1.0.0" },
      registry: new McpFnRegistry(),
    });
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      maxInventoryPages: 2,
    });
    await client.connect();

    const listTools = vi.spyOn(client.protocol, "listTools").mockResolvedValue({
      tools: [],
      nextCursor: "repeated",
    });
    await expect(client.tools.listAll()).rejects.toMatchObject({
      code: "MCPFN_OPERATION_FAILED",
      details: { operation: "tools/list", reason: "cursor repeated" },
    });
    expect(listTools).toHaveBeenCalledTimes(2);

    let resourcePage = 0;
    vi.spyOn(client.protocol, "listResources").mockImplementation(async () => ({
      resources: [],
      nextCursor: `page-${++resourcePage}`,
    }));
    await expect(client.resources.listAll()).rejects.toMatchObject({
      code: "MCPFN_OPERATION_FAILED",
      details: { operation: "resources/list", reason: "exceeded 2 pages" },
    });
    expect(resourcePage).toBe(2);

    await expect(client.tools.listBounded(0)).rejects.toThrow(
      /maxEntries must be a positive safe integer/,
    );

    await client.close();
  });

  it("redacts target queries before diagnostics are emitted", async () => {
    const events: unknown[] = [];
    const client = createMcpFnClient({
      target: customTarget({
        kind: "broken",
        descriptor: { url: "https://example.com/mcp?access_token=secret" },
        open: () => { throw new Error("unavailable"); },
      }),
      diagnostics: (event) => events.push(event),
    });
    await expect(client.connect()).rejects.toMatchObject({
      code: "MCPFN_TARGET_OPEN_FAILED",
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).toContain("REDACTED");
  });

  it("keeps the client event deadline referenced until the wait settles", async () => {
    const deadline = setTimeout(() => undefined, 60_000);
    const unref = vi.spyOn(deadline, "unref");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockReturnValueOnce(deadline);
    const controller = new AbortController();
    const client = createMcpFnClient({
      target: customTarget({ kind: "unused", open: () => { throw new Error("unused"); } }),
    });
    try {
      const waiting = client.waitForEvent(() => false, { signal: controller.signal });
      expect(unref).not.toHaveBeenCalled();
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("rejects non-integer and non-finite connection retry counts", () => {
    const target = customTarget({ kind: "unused", open: () => { throw new Error("unused"); } });
    for (const connectRetries of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createMcpFnClient({ target, connectRetries })).toThrow(
        /non-negative safe integer/,
      );
    }
  });

  it("treats falsy target-open rejections as retryable failures", async () => {
    const open = vi.fn().mockRejectedValue(undefined);
    const client = createMcpFnClient({
      target: customTarget({ kind: "falsy-rejection", open }),
      connectRetries: 1,
      connectRetryDelayMs: 1,
    });

    await expect(client.connect()).rejects.toMatchObject({
      code: "MCPFN_TARGET_OPEN_FAILED",
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(client.state).toBe("idle");
  });

  it("detaches an aborted open so reconnect succeeds and closes its late handle", async () => {
    const [lateClientTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpFnServer({
      info: { name: "reconnected", version: "1.0.0" },
      registry: new McpFnRegistry(),
    });
    let targetSignal: AbortSignal | undefined;
    let resolveOpen!: (handle: McpFnTransportHandle) => void;
    let openCalls = 0;
    const closeHandle = vi.fn(async () => undefined);
    const client = createMcpFnClient({
      target: customTarget({
        kind: "delayed",
        open: async (context) => {
          openCalls += 1;
          if (openCalls > 1) {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);
            return { transport: clientTransport, close: () => server.close() };
          }
          targetSignal = context.signal;
          return new Promise<McpFnTransportHandle>((resolve) => {
            resolveOpen = resolve;
          });
        },
      }),
    });

    const connecting = client.connect();
    const connectResult = expect(connecting).rejects.toMatchObject({
      code: "MCPFN_CONNECT_ABORTED",
    });
    await vi.waitFor(() => expect(targetSignal).toBeDefined());
    const closing = client.close();
    await vi.waitFor(() => expect(targetSignal?.aborted).toBe(true));
    await expect(closing).resolves.toBeUndefined();
    expect(client.state).toBe("closed");
    expect(closeHandle).not.toHaveBeenCalled();
    await expect(client.reconnect()).resolves.toBeUndefined();
    expect(client.state).toBe("connected");
    resolveOpen({ transport: lateClientTransport, close: closeHandle });

    await connectResult;
    await vi.waitFor(() => expect(closeHandle).toHaveBeenCalledOnce());
    expect(client.state).toBe("connected");
    await client.close();
  });

  it("keeps a delayed initialization attempt from taking over a reconnect", async () => {
    const [firstClientTransport] = InMemoryTransport.createLinkedPair();
    const firstClose = vi.fn(async () => undefined);
    const server = createMcpFnServer({
      info: { name: "reconnected-after-configure", version: "1.0.0" },
      registry: new McpFnRegistry(),
    });
    let openCalls = 0;
    let configureCalls = 0;
    let releaseConfigure!: () => void;
    let markConfigureStarted!: () => void;
    const configureStarted = new Promise<void>((resolve) => {
      markConfigureStarted = resolve;
    });
    const delayedConfigure = new Promise<void>((resolve) => {
      releaseConfigure = resolve;
    });
    const client = createMcpFnClient({
      target: customTarget({
        kind: "delayed-configure",
        open: async () => {
          openCalls += 1;
          if (openCalls === 1) {
            return { transport: firstClientTransport, close: firstClose };
          }
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      configure: async () => {
        configureCalls += 1;
        if (configureCalls === 1) {
          markConfigureStarted();
          await delayedConfigure;
        }
      },
    });

    const connecting = client.connect();
    const connectResult = expect(connecting).rejects.toMatchObject({
      code: "MCPFN_CONNECT_ABORTED",
    });
    await configureStarted;
    await client.close();
    expect(firstClose).toHaveBeenCalledOnce();
    await expect(client.reconnect()).resolves.toBeUndefined();
    expect(client.getServerVersion()).toMatchObject({ name: "reconnected-after-configure" });

    releaseConfigure();
    await connectResult;
    expect(client.state).toBe("connected");
    expect(client.getServerVersion()).toMatchObject({ name: "reconnected-after-configure" });
    await client.close();
  });

  it("closes the transport to interrupt a pending MCP initialization", async () => {
    let onclose: (() => void) | undefined;
    const closeTransport = vi.fn(async () => onclose?.());
    const transport = {
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: closeTransport,
      get onclose() {
        return onclose;
      },
      set onclose(callback: (() => void) | undefined) {
        onclose = callback;
      },
    } as unknown as McpFnTransportHandle["transport"];
    const client = createMcpFnClient({
      target: customTarget({
        kind: "stalled-initialization",
        open: () => ({ transport }),
      }),
    });

    const connecting = client.connect();
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalled());

    await expect(client.close()).resolves.toBeUndefined();
    await expect(connecting).rejects.toMatchObject({ code: "MCPFN_CONNECT_ABORTED" });
    expect(closeTransport).toHaveBeenCalled();
    expect(client.state).toBe("closed");
  });

  it("cleans up target and protocol ownership when configure fails", async () => {
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    const closeHandle = vi.fn(async () => undefined);
    const client = createMcpFnClient({
      target: customTarget({
        kind: "configure-failure",
        open: () => ({ transport: clientTransport, close: closeHandle }),
      }),
      configure: async () => {
        throw new Error("configure failed");
      },
    });

    await expect(client.connect()).rejects.toMatchObject({ code: "MCPFN_CONNECT_FAILED" });

    expect(closeHandle).toHaveBeenCalledOnce();
    expect(client.state).toBe("idle");
    expect(client.getServerVersion()).toBeUndefined();
  });

  it("closes a custom transport when its handle omits close", async () => {
    const closeTransport = vi.fn(async () => undefined);
    const transport = {
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: closeTransport,
    } as unknown as McpFnTransportHandle["transport"];
    const client = createMcpFnClient({
      target: customTarget({
        kind: "configure-failure-with-transport-fallback",
        open: () => ({ transport }),
      }),
      configure: async () => {
        throw new Error("configure failed");
      },
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "MCPFN_CONNECT_FAILED" });
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(client.state).toBe("idle");
  });

  it("isolates diagnostic observer failures from lifecycle and operation results", async () => {
    let executions = 0;
    const server = createMcpFnServer({
      info: { name: "observer-test", version: "1.0.0" },
      registry: new McpFnRegistry().register({
        name: "mutate",
        description: "Mutate exactly once.",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async () => structuredResult({ executions: ++executions }),
      }),
    });
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      diagnostics: async () => {
        throw new Error("observer failed");
      },
    });

    await client.connect();
    await expect(client.tools.call("mutate")).resolves.toMatchObject({
      structuredContent: { executions: 1 },
    });
    expect(executions).toBe(1);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("clears protocol and handle ownership after an unexpected transport close", async () => {
    const server = createMcpFnServer({
      info: { name: "unexpected-close", version: "1.0.0" },
      registry: new McpFnRegistry(),
    });
    const closeHandle = vi.fn(async () => undefined);
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: closeHandle };
        },
      }),
    });

    await client.connect();
    await server.close();
    await vi.waitFor(() => expect(client.state).toBe("idle"));

    expect(client.getServerVersion()).toBeUndefined();
    expect(closeHandle).toHaveBeenCalledOnce();
    await client.close();
  });

  it("advertises first-class client-mediated handlers and observes server events", async () => {
    const registry = new McpFnRegistry()
      .register({
        name: "progress",
        description: "Emit one progress event.",
        inputSchema: { type: "object", additionalProperties: false },
        handler: async (_input, _context, extra) => {
          if (extra._meta?.progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: extra._meta.progressToken, progress: 1, total: 1 },
            });
          }
          return structuredResult({ ok: true });
        },
      })
      .registerResource({
        uri: "memory://status",
        name: "status",
        read: async () => ({ contents: [{ uri: "memory://status", text: "ready" }] }),
        subscribe: async () => undefined,
        unsubscribe: async () => undefined,
      })
      .registerPrompt({ name: "hello", get: async () => ({ messages: [] }) });
    const server = createMcpFnServer({
      info: { name: "client-mediated", version: "1.0.0" },
      registry,
      additionalCapabilities: { logging: {}, tasks: {} },
    });
    const events: Array<{ kind: string }> = [];
    const diagnostics: Array<{ code?: string }> = [];
    const client = createMcpFnClient({
      target: customTarget({
        kind: "in-memory",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      handlers: {
        roots: async () => ({ roots: [{ uri: "file:///workspace", name: "workspace" }] }),
        sampling: async () => ({
          role: "assistant",
          content: { type: "text", text: "sampled" },
          model: "fixture-model",
          stopReason: "endTurn",
        }),
        elicitation: async () => ({ action: "accept", content: { approved: true } }),
      },
      clientOptions: {
        listChanged: {
          tools: {
            onChanged: () => { throw new Error("consumer callback failed"); },
          },
        },
      },
      diagnostics: (event) => { diagnostics.push(event); },
      events: (event) => { events.push(event); },
    });

    await client.connect();
    await expect(server.listRoots()).resolves.toMatchObject({
      roots: [{ uri: "file:///workspace" }],
    });
    await expect(server.sample({
      maxTokens: 32,
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
    })).resolves.toMatchObject({ model: "fixture-model" });
    await expect(server.elicit({
      mode: "form",
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { approved: { type: "boolean" } },
      },
    })).resolves.toMatchObject({ action: "accept" });
    await server.sendLoggingMessage({ level: "info", data: { message: "ready" } });
    await client.tools.call("progress");
    await client.resources.subscribe("memory://status");
    await client.resources.unsubscribe("memory://status");
    await server.sendResourceUpdated({ uri: "memory://status" });
    await server.sendToolListChanged();
    await server.sendResourceListChanged();
    await server.sendPromptListChanged();
    const now = new Date().toISOString();
    await server.protocol.notification({
      method: "notifications/tasks/status",
      params: {
        taskId: "task-1",
        status: "working",
        ttl: null,
        createdAt: now,
        lastUpdatedAt: now,
      },
    });
    await vi.waitFor(() => expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "client.roots",
      "client.sampling",
      "client.elicitation",
      "logging.message",
      "progress",
      "resources.subscribed",
      "resources.unsubscribed",
      "resources.updated",
      "tools.list_changed",
      "resources.list_changed",
      "prompts.list_changed",
      "tasks.status",
    ])));
    await vi.waitFor(() => expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MCPFN_LIST_CHANGED_CALLBACK_FAILED" }),
    ])));
    await client.close();
  });
});


it("retries failed handle cleanup before reconnecting", async () => {
  let opens = 0;
  const failedClose = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
  const client = createMcpFnClient({ target: customTarget({ kind: "retry-cleanup", open: async () => {
    opens++;
    const server = createMcpFnServer({ info: { name: "retry", version: "1" }, registry: new McpFnRegistry() });
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    await server.connect(peer);
    return { transport, close: opens === 1 ? failedClose : () => server.close() };
  } }) });
  await client.connect();
  await expect(client.reconnect()).rejects.toThrow(/cleanup failed/);
  expect(opens).toBe(1);
  await client.reconnect();
  expect(failedClose).toHaveBeenCalledTimes(2);
  expect(opens).toBe(2);
  await client.close();
});
