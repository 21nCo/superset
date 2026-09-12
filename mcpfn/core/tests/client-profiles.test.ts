import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnRegistry,
  McpFnValidationError,
  McpFnError,
  type McpFnClientProfileEvidence,
  type McpFnTaskRequestExtra,
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
    evidence?: (event: McpFnClientProfileEvidence) => void,
  ) {
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => context,
      clientProfiles: {
        profiles: [profile],
        evidence,
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
  it("rejects a projected type incompatible with canonical validation", async () => {
    const { registry } = lookupRegistry();
    const bad = tenantProfile();
    const project = bad.projectCatalog!;
    bad.projectCatalog = async (input) => (await project(input)).map(tool => ({
      ...tool, inputSchema: { ...tool.inputSchema, properties: { query: { type: "number" } } },
    }));
    const { client } = await connect({ subject: "authenticated-client", tenantId: "trusted" }, bad, registry);
    await expect(client.listTools()).rejects.toThrow(/canonical schema/);
  });

  it.each([[null], ["tenantId"], [["tenantId", "tenantId"]], [[42]], [["__proto__"]]])(
    "rejects malformed ownership declarations: %j", (value) => {
      const bad = tenantProfile();
      bad.serverOwnedArguments = { lookup: value } as never;
      expect(() => createMcpFnServer({
        info: { name: "bad", version: "1" }, registry: lookupRegistry().registry,
        context: () => ({}), clientProfiles: { profiles: [bad], resolveVerifiedIdentity: () => undefined },
      })).toThrow();
    },
  );

  it("requires sessions for hooks that consume initialization metadata", async () => {
    const server = createMcpFnServer({
      info: { name: "http-profile", version: "1" }, registry: lookupRegistry().registry,
      context: () => ({}), clientProfiles: { profiles: [tenantProfile()], resolveVerifiedIdentity: () => undefined },
    });
    await expect(server.createWebStandardHandler()).rejects.toThrow(/session/i);
    closeables.push(server);
  });

  it("preserves exact long rejected property names", async () => {
    const { client } = await connect({ subject: "generic" }, tenantProfile(), lookupRegistry().registry);
    const unknown = "unexpected".repeat(50);
    const result = await client.callTool({ name: "lookup", arguments: { query: "ok", tenantId: "ok", [unknown]: "secret" } });
    expect(JSON.stringify(result)).toContain(unknown);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("omits handler-supplied issue payloads from evidence", async () => {
    const events: McpFnClientProfileEvidence[] = [];
    const { registry } = lookupRegistry(vi.fn(async () => {
      throw new McpFnError("HANDLER_ERROR", "secret-input", { issues: [{ message: "secret-input" }] });
    }));
    const { client } = await connect({ subject: "generic" }, tenantProfile(), registry, "reported", event => { events.push(event); });
    await client.callTool({ name: "lookup", arguments: { query: "ok", tenantId: "ok" } });
    expect(events.filter(e => e.stage === "handler" && e.outcome === "failed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("secret-input");
  });

  it("reports validation when a delayed task result is stored", async () => {
    let finish!: () => Promise<unknown>;
    const stored = vi.fn();
    const outcome = vi.fn();
    const stages = vi.fn();
    const registry = new McpFnRegistry().register({
      name: "delayed", description: "Delayed result", inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      execution: { taskSupport: "required" }, handler: async () => structuredResult({ value: "ok" }),
      taskHandler: { createTask: async (_args, _context, extra) => {
        finish = () => extra.taskStore.storeTaskResult("task", "completed", structuredResult({ value: 42 }));
        return { task: { taskId: "task", status: "working", createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null } };
      } },
    });
    await registry.createToolTask("delayed", {}, undefined, { taskStore: { storeTaskResult: stored } } as unknown as McpFnTaskRequestExtra, { onStage: stages, onTaskOutput: outcome });
    expect(outcome).not.toHaveBeenCalled();
    await expect(finish()).rejects.toThrow(/Invalid output/);
    expect(stages).toHaveBeenLastCalledWith("output-validation");
    expect(outcome).toHaveBeenCalledWith("failed", expect.any(Error));
    expect(stored).not.toHaveBeenCalled();
  });

});

describe("projected contract boundaries", () => {
  it.each(["additionalProperties", "minProperties", "outputSchema", "taskSupport"])("rejects changed %s", async (change) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const tool = { name: "test", description: "test", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map((entry) => ({ ...entry,
        ...(change === "outputSchema" ? { outputSchema: { type: "object" as const } } :
          change === "taskSupport" ? { execution: { taskSupport: "required" as const } } :
          { inputSchema: { ...entry.inputSchema, [change]: change === "additionalProperties" ? true : 2 } }),
      })) },
    } })).rejects.toThrow(/preserve root constraints/);
  });

  it("accepts an unchanged local root reference", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object", $ref: "#" } }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true },
    } })).resolves.toMatchObject({ changes: [] });
  });

  it("persists failed task results without applying success output requirements", async () => {
    const stored = vi.fn();
    const registry = new McpFnRegistry().register({ name: "task", description: "test", inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["answer"] }, execution: { taskSupport: "required" },
      handler: async () => structuredResult({ answer: true }),
      taskHandler: { createTask: async (_args, _context, extra) => {
        await extra.taskStore.storeTaskResult("task:1", "failed", { content: [{ type: "text", text: "Failed" }] });
        return { task: { taskId: "task:1", status: "failed", createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null } };
      } },
    });
    await registry.createToolTask("task", {}, undefined, { taskStore: { storeTaskResult: stored } } as unknown as McpFnTaskRequestExtra);
    expect(stored).toHaveBeenCalledWith("task:1", "failed", expect.objectContaining({ isError: true }));
  });
});


describe("optional projected tool metadata", () => {
  it.each([false, true])("treats forbidden task support as the default (%s)", async (explicit) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const tool = { name: "test", inputSchema: { type: "object" as const }, ...(explicit ? { execution: { taskSupport: "forbidden" as const } } : {}) };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map(({ execution, ...entry }) => ({ ...entry, ...(!explicit ? { execution: { taskSupport: "forbidden" as const } } : {}) })) },
    } })).resolves.toBeDefined();
  });
  it("rejects a null projected output schema when the canonical schema is absent", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object" } }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map((tool) => ({ ...tool, outputSchema: null as any })) },
    } })).rejects.toThrow(/preserve root constraints/);
  });
});

describe("reference and ownership projection safety", () => {
  async function project(inputSchema: any, projected: any, execution?: any) {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    return buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true,
        serverOwnedArguments: { test: ["tenantId"] }, enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
        projectCatalog: () => [{ name: "test", inputSchema: projected, ...(execution === undefined ? {} : { execution }) }],
      },
    } });
  }
  const canonical = { type: "object", properties: { tenantId: { type: "string" }, query: { type: "string" } }, required: ["tenantId"] };
  const visible = { type: "object", properties: { query: { type: "string" } } };
  it.each(["dependencies", "dependentRequired"])("rejects owned-field %s even when copied unchanged", async keyword => {
    const constraint = { [keyword]: { tenantId: ["query"] } };
    await expect(project({ ...canonical, ...constraint }, { ...visible, ...constraint })).rejects.toThrow(/whole-object constraints/);
  });
  it("allows ownership projection inside local root definitions", async () => {
    await expect(project({ type: "object", $ref: "#/$defs/input", $defs: { input: canonical } },
      { type: "object", $ref: "#/$defs/input", $defs: { input: visible } })).resolves.toBeDefined();
  });
  it("rejects a changed referenced model-owned property", async () => {
    await expect(project({ ...canonical, properties: { ...canonical.properties, query: { $ref: "#/$defs/query" } }, $defs: { query: { type: "string" } } },
      { ...visible, properties: { query: { $ref: "#/$defs/query" } }, $defs: { query: { type: "number" } } })).rejects.toThrow(/canonical schema/);
  });
  it.each([[null], [{ taskSupport: null }]])("rejects null execution metadata %j", async execution => {
    await expect(project(canonical, visible, execution)).rejects.toThrow(/Invalid task execution metadata/);
  });
});

it.each(['optional', 'root-ref', 'const', 'enum'])('rejects asymmetric projection %s', async kind => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  const inputSchema: any = { type: 'object', properties: { tenantId: { type: 'string' }, query: kind === 'root-ref' ? { $ref: '#' } : { type: 'string' } }, required: ['tenantId'], additionalProperties: false };
  if (kind === 'const') inputSchema.const = { tenantId: 'trusted' };
  if (kind === 'enum') inputSchema.enum = [{ tenantId: 'trusted' }];
  const visible = { ...inputSchema, properties: kind === 'optional' ? {} : { query: inputSchema.properties.query }, required: [] };
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: 'test', inputSchema }], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' }, profile: { id: 'test', version: '1', matches: () => true, serverOwnedArguments: { test: ['tenantId'] }, enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: 'trusted' }), projectCatalog: () => [{ name: 'test', inputSchema: visible }] } } })).rejects.toThrow();
});
it('preserves an unchanged recursive property schema', async () => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  const tool: any = { name: 'test', inputSchema: { type: 'object', properties: { child: { $ref: '#' } } } };
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' }, profile: { id: 'test', version: '1', matches: () => true } } })).resolves.toMatchObject({ changes: [] });
});
