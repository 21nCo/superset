import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnRegistry,
  McpFnValidationError,
  createMcpFnServer,
  structuredResult,
  type McpFnClientProfile,
} from "../src/index.js";

interface RequestContext {
  subject?: string;
  tenantId?: string;
}

describe("McpFn client profiles", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      closeables.splice(0).map((value) => value.close().catch(() => undefined)),
    );
  });

  async function connect(
    context: RequestContext,
    profile: McpFnClientProfile<RequestContext>,
    registry: McpFnRegistry<RequestContext>,
    clientName = "reported-client",
  ) {
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => context,
      clientProfiles: {
        profiles: [profile],
        resolveVerifiedIdentity: ({ context: trusted }) =>
          trusted.subject ? { subject: trusted.subject } : undefined,
      },
    });
    const client = new Client(
      { name: clientName, version: "9.9.9" },
      { capabilities: { roots: { listChanged: true } } },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    return { client, server };
  }

  function tenantProfile(
    observeReportedClient: (name: string | undefined) => void = () => undefined,
  ): McpFnClientProfile<RequestContext> {
    return {
      id: "consumer/trusted",
      version: "1",
      matches: ({ subject }) => subject === "authenticated-client",
      serverOwnedArguments: { lookup: ["tenantId"] },
      projectCatalog: ({ tools, reportedClient }) => {
        observeReportedClient(reportedClient.info?.name);
        return tools.map((tool) => {
          if (tool.name !== "lookup") return tool;
          const { tenantId: _tenantId, ...properties } =
            tool.inputSchema.properties ?? {};
          return {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties,
              required: tool.inputSchema.required?.filter(
                (name) => name !== "tenantId",
              ),
            },
          };
        });
      },
      enrichArguments: ({ arguments: args, context }) =>
        context.tenantId ? { ...args, tenantId: context.tenantId } : args,
    };
  }

  function lookupRegistry(
    handler = vi.fn(async (args: Record<string, unknown>) =>
      structuredResult(args),
    ),
  ) {
    return {
      handler,
      registry: new McpFnRegistry<RequestContext>().register({
        name: "lookup",
        description: "Look up a value in the authenticated tenant.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            tenantId: { type: "string" },
          },
          required: ["query", "tenantId"],
          additionalProperties: false,
        },
        handler,
      }),
    };
  }

  it("projects and enriches one authenticated production lifecycle", async () => {
    const reported = vi.fn();
    const { registry, handler } = lookupRegistry();
    const { client } = await connect(
      { subject: "authenticated-client", tenantId: "trusted-tenant" },
      tenantProfile(reported),
      registry,
    );

    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(listed.tools[0]?.inputSchema.properties).not.toHaveProperty(
      "tenantId",
    );
    await expect(
      client.callTool({
        name: "lookup",
        arguments: { query: "safe" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { query: "safe", tenantId: "trusted-tenant" },
    });
    expect(handler).toHaveBeenCalledWith(
      { query: "safe", tenantId: "trusted-tenant" },
      expect.objectContaining({ subject: "authenticated-client" }),
      expect.anything(),
    );
    expect(reported).toHaveBeenCalledWith("reported-client");
  });

  it("keeps generic clients canonical when no verified profile matches", async () => {
    const { registry } = lookupRegistry();
    const { client } = await connect(
      { subject: "generic-client" },
      tenantProfile(),
      registry,
    );
    expect((await client.listTools()).tools[0]?.inputSchema.required).toEqual([
      "query",
      "tenantId",
    ]);
    await expect(
      client.callTool({
        name: "lookup",
        arguments: { query: "safe", tenantId: "model-value" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { query: "safe", tenantId: "model-value" },
    });
  });

  it("fails forged and missing server-owned arguments before the handler", async () => {
    const first = lookupRegistry();
    const forged = await connect(
      { subject: "authenticated-client", tenantId: "trusted-tenant" },
      tenantProfile(),
      first.registry,
    );
    const forgedResult = await forged.client.callTool({
      name: "lookup",
      arguments: { query: "safe", tenantId: "forged" },
    });
    expect(forgedResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MCPFN_FORGED_SERVER_ARGUMENT",
          details: {
            lifecycleStage: "argument-enrichment",
            rejectedProperty: "tenantId",
          },
        },
      },
    });
    expect(first.handler).not.toHaveBeenCalled();

    const second = lookupRegistry();
    const missing = await connect(
      { subject: "authenticated-client" },
      tenantProfile(),
      second.registry,
    );
    const missingResult = await missing.client.callTool({
      name: "lookup",
      arguments: { query: "safe" },
    });
    expect(missingResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MCPFN_MISSING_TRUSTED_CONTEXT",
          details: { lifecycleStage: "argument-enrichment" },
        },
      },
    });
    expect(second.handler).not.toHaveBeenCalled();
  });

  it("rejects projection/enrichment asymmetry while listing", async () => {
    const { registry } = lookupRegistry();
    const asymmetric: McpFnClientProfile<RequestContext> = {
      id: "consumer/asymmetric",
      version: "1",
      matches: () => true,
      projectCatalog: ({ tools }) =>
        tools.map((tool) => ({
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        })),
    };
    const { client } = await connect(
      { subject: "authenticated-client" },
      asymmetric,
      registry,
    );
    await expect(client.listTools()).rejects.toThrow(
      /without trusted enrichment/,
    );
  });

  it("rejects invented and duplicate projected tools", async () => {
    const inventedRegistry = lookupRegistry();
    const invented = await connect(
      { subject: "authenticated-client" },
      {
        id: "consumer/invented",
        version: "1",
        matches: () => true,
        projectCatalog: ({ tools }) => [
          ...tools,
          { ...tools[0]!, name: "invented" },
        ],
      },
      inventedRegistry.registry,
    );
    await expect(invented.client.listTools()).rejects.toThrow(/unknown tool/);

    const duplicateRegistry = lookupRegistry();
    const duplicate = await connect(
      { subject: "authenticated-client" },
      {
        id: "consumer/duplicate",
        version: "1",
        matches: () => true,
        projectCatalog: ({ tools }) => [tools[0]!, tools[0]!],
      },
      duplicateRegistry.registry,
    );
    await expect(duplicate.client.listTools()).rejects.toThrow(
      /duplicate tool/,
    );
  });

  it("applies canonical visibility before projection and preserves call symmetry", async () => {
    const hidden = {
      name: "hidden",
      description: "Hidden.",
      inputSchema: {
        type: "object" as const,
        properties: { tenantId: { type: "string" } },
        required: ["tenantId"],
        additionalProperties: false,
      },
      handler: async () => structuredResult({ ok: true }),
    };
    const visible = lookupRegistry();
    visible.registry.register(hidden);
    const configured = tenantProfile();
    configured.serverOwnedArguments = {
      ...configured.serverOwnedArguments,
      hidden: ["tenantId"],
    };
    const server = createMcpFnServer({
      info: { name: "visibility-profile", version: "1.0.0" },
      registry: visible.registry,
      context: () => ({ subject: "authenticated-client", tenantId: "trusted" }),
      toolVisibility: ({ tool }) => tool.name !== "hidden",
      clientProfiles: {
        profiles: [configured],
        resolveVerifiedIdentity: ({ context }) => ({
          subject: context.subject!,
        }),
      },
    });
    const client = new Client(
      { name: "visibility-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "lookup",
    ]);
    await expect(
      client.callTool({ name: "hidden", arguments: {} }),
    ).rejects.toThrow(/not found/);
  });

  it("retains exact structured Ajv diagnostics without rejected values", async () => {
    const captured = vi.fn();
    const registry = new McpFnRegistry().register({
      name: "strict",
      description: "Strict input.",
      inputSchema: {
        type: "object",
        properties: {
          nested: { type: "object", properties: { count: { type: "number" } } },
        },
        additionalProperties: false,
      },
      handleInvalidArguments: async (_args, issues) => {
        captured(issues);
        return structuredResult({ issues });
      },
      handler: async () => structuredResult({ ok: true }),
    });
    await registry.callTool(
      "strict",
      { secretUnexpected: "must-not-leak" },
      undefined,
      {} as never,
    );
    expect(captured).toHaveBeenCalledWith([
      {
        path: "/",
        instancePath: "/",
        schemaPath: "#/additionalProperties",
        keyword: "additionalProperties",
        message: "must NOT have additional properties",
        rejectedProperty: "secretUnexpected",
      },
    ]);
    expect(JSON.stringify(captured.mock.calls)).not.toContain("must-not-leak");
  });

  it("attributes handler failures to the handler lifecycle stage", async () => {
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "fails",
      description: "Fail inside the handler.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        throw new McpFnValidationError("Domain validation failed");
      },
    });
    const { client } = await connect(
      { subject: "generic" },
      tenantProfile(),
      registry,
    );
    await expect(
      client.callTool({ name: "fails", arguments: {} }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { details: { lifecycleStage: "handler" } },
      },
    });
  });
});
