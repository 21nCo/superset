import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "../src/index.js";

describe("McpFnServer", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
  });

  it("round-trips a validated tool over the official in-memory transport", async () => {
    const registry = new McpFnRegistry().register({
      name: "add",
      description: "Add two numbers.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "number" } },
        required: ["result"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ a, b }) =>
        structuredResult({ result: Number(a) + Number(b) }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: "add",
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    await expect(
      client.callTool({ name: "add", arguments: { a: 2, b: 3 } }),
    ).resolves.toMatchObject({
      structuredContent: { result: 5 },
    });
  });

  it("normalizes structured results without treating repeated references as cycles", () => {
    const shared = { value: 1 };
    const circular: Record<string, unknown> = { shared };
    circular.self = circular;
    expect(structuredResult({ first: shared, second: shared, circular })).toMatchObject({
      structuredContent: {
        first: { value: 1 },
        second: { value: 1 },
        circular: { shared: { value: 1 }, self: "[Circular]" },
      },
    });
    expect(structuredResult({ count: 1n }).structuredContent).toEqual({ count: "1" });
    expect(() => structuredResult({ toJSON: () => null })).toThrow(
      /structuredContent must serialize to an object/,
    );
  });

  it("lists prompt arguments derived from argumentsSchema", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "schema_prompt",
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string", description: "Topic to explain." } },
        required: ["topic"],
        additionalProperties: false,
      },
      get: async () => ({ messages: [] }),
    });
    const prompts = registry.listPrompts();
    expect(prompts).toEqual([expect.objectContaining({
      name: "schema_prompt",
      arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
    })]);
    expect(createMcpFnServer({
      info: { name: "schema-prompt", version: "1.0.0" },
      registry,
    }).manifest().prompts).toEqual([expect.objectContaining({
      name: "schema_prompt",
      arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
    })]);
  });

  it("lists required-only prompt arguments derived from argumentsSchema", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "required_only_prompt",
      argumentsSchema: {
        type: "object",
        required: ["token"],
      },
      get: async () => ({ messages: [] }),
    });
    expect(registry.listPrompts()).toEqual([expect.objectContaining({
      name: "required_only_prompt",
      arguments: [{ name: "token", required: true }],
    })]);
  });

  it("rejects malformed prompt required lists through validation", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "invalid_required",
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: "topic",
      } as never,
      get: async () => ({ messages: [] }),
    })).toThrow(/invalid arguments JSON Schema/);
  });

  it("rejects conflicting prompt argument declarations", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "conflicting_prompt",
      arguments: [{ name: "topic", required: false }],
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/arguments and argumentsSchema disagree/);
  });

  it("derives and compares prompt inventories from composed schemas", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "composed_prompt",
      arguments: [{ name: "topic", required: true }],
      argumentsSchema: {
        type: "object",
        allOf: [{
          properties: { topic: { type: "string" } },
          required: ["topic"],
        }],
      },
      get: async () => ({ messages: [] }),
    }).registerPrompt({
      name: "referenced_prompt",
      argumentsSchema: {
        type: "object",
        $defs: {
          arguments: {
            properties: { token: { type: "string", description: "Access token." } },
            required: ["token"],
          },
        },
        $ref: "#/$defs/arguments",
      },
      get: async () => ({ messages: [] }),
    });
    expect(registry.listPrompts()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "composed_prompt",
        arguments: [{ name: "topic", required: true }],
      }),
      expect.objectContaining({
        name: "referenced_prompt",
        arguments: [{ name: "token", description: "Access token.", required: true }],
      }),
    ]));

    expect(() => new McpFnRegistry().registerPrompt({
      name: "conflicting_composed_prompt",
      arguments: [{ name: "topic", required: true }],
      argumentsSchema: {
        type: "object",
        allOf: [{
          properties: { other: { type: "string" } },
          required: ["other"],
        }],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/arguments and argumentsSchema disagree/);
  });

  it("rejects prompt schemas that cannot expose string-valued inventories", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "numeric_prompt",
      argumentsSchema: {
        type: "object",
        properties: { age: { type: "number" } },
        required: ["age"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/argument age must accept string values/);

    expect(() => new McpFnRegistry().registerPrompt({
      name: "contradictory_prompt",
      argumentsSchema: {
        type: "object",
        properties: {
          value: { allOf: [{ const: "a" }, { const: "b" }] },
        },
        required: ["value"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/argument value must accept string values/);

    expect(() => new McpFnRegistry().registerPrompt({
      name: "conditional_prompt",
      arguments: [{ name: "topic" }],
      argumentsSchema: {
        type: "object",
        anyOf: [{ properties: { topic: { type: "string" } } }],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/must use derivable properties/);
  });

  it("rejects prompts without callable get handlers", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "missing_get",
    } as never)).toThrow(/requires a get handler function/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "invalid_get",
      get: true,
    } as never)).toThrow(/requires a get handler function/);
  });

  it("rejects malformed prompt argument inventories with a validation error", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "malformed_prompt",
      arguments: false,
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/arguments must be an array/);
  });

  it("rejects malformed prompt argument fields and non-object schemas", () => {
    const register = (argumentsValue: unknown) => new McpFnRegistry().registerPrompt({
      name: "malformed_prompt",
      arguments: argumentsValue,
      get: async () => ({ messages: [] }),
    } as never);

    expect(() => register([{ name: "contains whitespace" }])).toThrow(/Invalid MCP prompt argument name/);
    expect(() => register([{ name: "topic", description: 42 }])).toThrow(/description must be a string/);
    expect(() => register([{ name: "topic", required: "yes" }])).toThrow(/required must be a boolean/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "non_object_schema",
      argumentsSchema: { type: "string" },
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/argumentsSchema must be an object schema/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "null_schema",
      argumentsSchema: null,
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/argumentsSchema must be an object schema/);
  });

  it("rejects unknown task support values at registration", () => {
    expect(() => new McpFnRegistry().register({
      name: "unknown_task_support",
      description: "Reject invalid task support.",
      inputSchema: { type: "object" },
      execution: { taskSupport: "sometimes" },
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/invalid taskSupport=sometimes/);
  });

  it("rejects non-object tool output schemas at registration", () => {
    expect(() => new McpFnRegistry().register({
      name: "non_object_output",
      description: "Reject a non-object structured output contract.",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/outputSchema must be an object schema/);

    expect(() => new McpFnRegistry().register({
      name: "null_output",
      description: "Reject a null structured output contract.",
      inputSchema: { type: "object" },
      outputSchema: null,
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/outputSchema must be an object schema/);
  });

  it("rejects missing and non-function tool handlers at registration", () => {
    const definition = {
      name: "invalid_handler",
      description: "Reject an invalid handler.",
      inputSchema: { type: "object" },
    };
    expect(() => new McpFnRegistry().register(definition as never))
      .toThrow(/requires a handler function/);
    expect(() => new McpFnRegistry().register({ ...definition, handler: "invalid" } as never))
      .toThrow(/requires a handler function/);
  });

  it("rejects resources and templates without callable read handlers", () => {
    expect(() => new McpFnRegistry().registerResource({
      uri: "docs://missing-read",
      name: "missing-read",
    } as never)).toThrow(/requires a read handler function/);
    expect(() => new McpFnRegistry().registerResourceTemplate({
      uriTemplate: "docs://missing-read/{id}",
      name: "missing-read-template",
      read: "invalid",
    } as never)).toThrow(/requires a read handler function/);
  });

  it("filters tools per request and makes hidden calls indistinguishable from unknown tools", async () => {
    const invoked: string[] = [];
    const registry = new McpFnRegistry<{ permissions: readonly string[] }>()
      .register({
        name: "visible",
        description: "Visible to readers.",
        inputSchema: { type: "object" },
        metadata: { permission: "records.read" },
        handler: async () => { invoked.push("visible"); return structuredResult({ ok: true }); },
      })
      .register({
        name: "hidden",
        description: "Hidden from readers.",
        inputSchema: { type: "object" },
        metadata: { permission: "records.delete" },
        handler: async () => { invoked.push("hidden"); return structuredResult({ ok: true }); },
      });
    const server = createMcpFnServer({
      info: { name: "visibility", version: "1.0.0" },
      registry,
      context: () => ({ permissions: ["records.read"] }),
      toolVisibility: ({ tool, context }) =>
        context.permissions.includes(String(tool._meta?.permission)),
    });
    const client = new Client(
      { name: "visibility-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["visible"]);
    await expect(client.callTool({ name: "hidden" })).rejects.toMatchObject({ code: -32601 });
    await expect(client.callTool({ name: "missing" })).rejects.toMatchObject({ code: -32601 });
    expect(invoked).toEqual([]);
    await expect(client.callTool({ name: "visible" })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(invoked).toEqual(["visible"]);
    expect(server.manifest().tools.map(({ name }) => name)).toEqual(["hidden", "visible"]);
  });

  it("returns a tool error for invalid arguments without invoking the handler", async () => {
    let called = false;
    const registry = new McpFnRegistry().register({
      name: "required",
      description: "Require one value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async () => {
        called = true;
        return structuredResult({ ok: true });
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "required", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "MCPFN_INVALID_ARGUMENTS" },
    });
    expect(called).toBe(false);
  });

  it("projects model-visible schemas and restores trusted arguments before canonical validation", async () => {
    let received: Record<string, unknown> | undefined;
    const registry = new McpFnRegistry().register({
      name: "scoped", description: "Uses server-owned tenant context.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tenantId: { type: "string" } }, required: ["query", "tenantId"], additionalProperties: false },
      handler: async (args) => { received = args; return structuredResult({ ok: true }); },
    });
    const server = createMcpFnServer({
      info: { name: "profiles", version: "1.0.0" }, registry,
      context: () => ({ tenantId: "verified-tenant" }),
      clientProfile: ({ context }) => ({
        id: "trusted-client", version: "1", verifiedIdentity: { tenantId: context.tenantId },
        projectTool: ({ tool }) => ({ ...tool, inputSchema: { ...tool.inputSchema, properties: { query: { type: "string" } }, required: ["query"] } }),
        enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: context.tenantId }),
      }),
    });
    const client = new Client({ name: "untrusted-name", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); closeables.push(client, server);
    expect((await client.listTools()).tools[0]?.inputSchema).toMatchObject({ required: ["query"] });
    await expect(client.callTool({ name: "scoped", arguments: { query: "hello", tenantId: "forged-by-client" } })).resolves.toMatchObject({ isError: false });
    expect(received).toEqual({ query: "hello", tenantId: "verified-tenant" });
  });

  it("retains rejected additional-property diagnostics without retaining its value", async () => {
    const registry = new McpFnRegistry().register({ name: "strict", description: "Reject unknown arguments.", inputSchema: { type: "object", additionalProperties: false }, handler: async () => structuredResult({ ok: true }) });
    const server = createMcpFnServer({ info: { name: "strict", version: "1.0.0" }, registry });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport); closeables.push(client, server);
    const result = await client.callTool({ name: "strict", arguments: { forged: "secret-value" } });
    expect(result.structuredContent).toMatchObject({ error: { details: { issues: [{ path: "/", schemaPath: "#/additionalProperties", keyword: "additionalProperties", additionalProperty: "forged" }] } } });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("allows domain packages to retain their stable invalid-argument envelope", async () => {
    const registry = new McpFnRegistry().register({
      name: "domain_validation",
      description: "Map validation failures.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async () => structuredResult({ ok: true }),
      handleInvalidArguments: async (_args, issues) => ({
        content: [{ type: "text", text: "domain invalid" }],
        structuredContent: { ok: false, code: "DOMAIN_INVALID", issues },
        isError: true,
      }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({
      name: "domain_validation",
      arguments: {},
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "DOMAIN_INVALID" },
    });
  });

  it("keeps error results valid when a tool declares a success output schema", async () => {
    const registry = new McpFnRegistry().register({
      name: "success_schema",
      description: "Declare a success-only schema.",
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
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "success_schema", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: { code: "MCPFN_INVALID_ARGUMENTS" },
    });
  });

  it("preserves coded plain-object domain errors", async () => {
    const registry = new McpFnRegistry().register({
      name: "plain_error",
      description: "Throw a coded object.",
      inputSchema: { type: "object" },
      handler: async () => {
        throw { code: "DOMAIN_DENIED", message: "Denied", metadata: { policy: "test" } };
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({ name: "plain_error" })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "DOMAIN_DENIED", message: "Denied", details: { policy: "test" } },
      },
    });
  });

  it("serializes circular and bigint error details safely", async () => {
    const details: Record<string, unknown> = { count: 2n };
    details.self = details;
    const registry = new McpFnRegistry().register({
      name: "complex_error",
      description: "Throw complex details.",
      inputSchema: { type: "object" },
      handler: async () => {
        throw { code: "COMPLEX", message: "Complex", details };
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({ name: "complex_error" })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { details: { count: "2", self: "[Circular]" } },
      },
    });
  });

  it("passes validated HTTP authInfo into trusted context", async () => {
    const registry = new McpFnRegistry<{ clientId: string }>().register({
      name: "whoami",
      description: "Return the authenticated client.",
      inputSchema: { type: "object" },
      handler: async (_args, context) => structuredResult({ clientId: context.clientId }),
    });
    const server = createMcpFnServer({
      info: { name: "http-auth", version: "1.0.0" },
      registry,
      context: (extra) => ({ clientId: extra.authInfo?.clientId ?? "anonymous" }),
    });
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    closeables.push(server);
    const authInfo = {
      token: "verified-token",
      clientId: "client-42",
      scopes: ["mcp:read"],
      resource: new URL("https://example.com/mcp"),
    };
    const post = (body: unknown) => handler(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), { authInfo });

    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(initialized.status).toBe(200);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const called = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    expect(await called.json()).toMatchObject({
      result: { structuredContent: { clientId: "client-42" } },
    });
  });

  it("configures every isolated stateless request server before connecting it", async () => {
    const registry = new McpFnRegistry().register({
      name: "visible_without_configuration",
      description: "Prove request-server configuration can wrap live protocol handlers.",
      inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const server = createMcpFnServer({
      info: { name: "configured-stateless", version: "1.0.0" },
      registry,
    });
    const configuredServers: Array<typeof server> = [];
    const handler = await server.createWebStandardHandler({
      enableJsonResponse: true,
      configureRequestServer: (requestServer) => {
        configuredServers.push(requestServer);
        requestServer.protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [],
        }));
      },
    });
    closeables.push(server);
    const post = (body: unknown) => handler(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));

    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(initialized.status).toBe(200);
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await expect(listed.json()).resolves.toMatchObject({ result: { tools: [] } });
    expect(configuredServers).toHaveLength(2);
    expect(new Set(configuredServers).size).toBe(2);
    expect(configuredServers).not.toContain(server);
  });

  it("routes sessionful HTTP clients to isolated transports", async () => {
    const registry = new McpFnRegistry().register({
      name: "echo",
      description: "Echo a value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      handler: async ({ value }) => structuredResult({ value }),
    });
    const server = createMcpFnServer({
      info: { name: "session-test", version: "1.0.0" },
      registry,
    });
    let nextSession = 0;
    let signalCloseStarted: () => void;
    let finishClose: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeCanFinish = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const configuredServers: Array<typeof server> = [];
    const closeCalls = new Map<typeof server, number>();
    const handler = await server.createWebStandardHandler({
      enableJsonResponse: true,
      sessionIdGenerator: () => `session-${++nextSession}`,
      onsessionclosed: async (id) => {
        if (id === "session-1") {
          signalCloseStarted();
          await closeCanFinish;
        }
      },
      configureRequestServer: (requestServer) => {
        configuredServers.push(requestServer);
        const close = requestServer.close.bind(requestServer);
        requestServer.close = async () => {
          closeCalls.set(requestServer, (closeCalls.get(requestServer) ?? 0) + 1);
          await close();
        };
      },
    });
    closeables.push(server);
    const post = (body: unknown, sessionId?: string) => handler(new Request(
      "https://example.com/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      },
    ));
    const initialize = (id: number) => post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: `client-${id}`, version: "1.0.0" },
      },
    });

    const rejected = await post({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/list",
    });
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(configuredServers).toHaveLength(1);
    expect(configuredServers).not.toContain(server);
    expect(closeCalls.get(configuredServers[0]!)).toBe(1);

    const first = await initialize(1);
    const second = await initialize(2);
    const firstSession = first.headers.get("mcp-session-id");
    const secondSession = second.headers.get("mcp-session-id");
    expect(firstSession).toBe("session-1");
    expect(secondSession).toBe("session-2");
    expect(configuredServers).toHaveLength(3);
    expect(configuredServers).not.toContain(server);

    for (const [id, sessionId] of [[3, firstSession], [4, secondSession]] as const) {
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "echo", arguments: { value: sessionId } },
      }, sessionId!);
      expect(await response.json()).toMatchObject({
        result: { structuredContent: { value: sessionId } },
      });
    }
    expect(configuredServers).toHaveLength(3);

    const remove = (sessionId: string) => handler(new Request("https://example.com/mcp", {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId,
        },
      }));
    const firstRemoval = remove(firstSession!);
    await closeStarted;
    const whileClosing = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "too-late" } },
    }, firstSession!);
    expect(whileClosing.status).toBe(404);
    finishClose();
    expect((await firstRemoval).status).toBe(200);
    expect(closeCalls.get(configuredServers[1]!)).toBe(1);

    expect((await remove(secondSession!)).status).toBe(200);
    expect(closeCalls.get(configuredServers[2]!)).toBe(1);
  });
});
