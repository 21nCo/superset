import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  WebStandardStreamableHTTPServerTransport,
  type HandleRequestOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { TaskMessageQueue, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListRootsResultSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type LoggingMessageNotification,
  type ResourceUpdatedNotification,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { errorResult } from "./errors.js";
import { assertMcpAppContracts } from "./apps.js";
import { createManifest, type CreateManifestOptions } from "./manifest.js";
import {
  MCPFN_GENERIC_CLIENT_PROFILE_ID,
  type McpFnClientProfile,
  type McpFnClientProfileHooks,
} from "./client-profiles.js";
import type { McpFnRegistry } from "./registry.js";
import type {
  McpFnClientRequestOptions,
  McpFnElicitationParams,
  McpFnElicitationResult,
  McpFnManifest,
  McpFnRequestExtra,
  McpFnRootsResult,
  McpFnSamplingParams,
  McpFnSamplingResult,
  McpFnServerInfo,
  McpFnTaskRequestExtra,
  McpFnListedTool,
} from "./types.js";

export interface McpFnToolVisibilityInput<TContext> {
  tool: McpFnListedTool;
  context: TContext;
  extra: McpFnRequestExtra;
}

export interface McpFnServerOptions<TContext> extends CreateManifestOptions {
  info: McpFnServerInfo;
  registry: McpFnRegistry<TContext>;
  context?: (extra: McpFnRequestExtra) => TContext | Promise<TContext>;
  /**
   * Per-request discovery and invocation filter. Returning false hides the
   * tool from tools/list and makes tools/call indistinguishable from an
   * unknown tool. Static manifests remain the complete server contract.
   */
  toolVisibility?: (
    input: McpFnToolVisibilityInput<TContext>,
  ) => boolean | Promise<boolean>;
  /** Shared tools/list projection and pre-validation tools/call preparation lifecycle. */
  clientProfiles?: McpFnClientProfileHooks<TContext>;
  /** Maximum entries returned by each list request. Defaults to 100. */
  pageSize?: number;
  additionalCapabilities?: ServerCapabilities;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  defaultTaskPollInterval?: number;
  maxTaskQueueSize?: number;
  enforceStrictCapabilities?: boolean;
}

export type McpFnWebStandardHandlerOptions<TContext> =
  ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0] & {
    /**
     * Configure the live isolated server before its transport connects. This
     * runs once per stateless request, or once per session initialization
     * attempt before the SDK validates the request. Rejected attempts may
     * therefore invoke it without retaining a session. This is the correct
     * place to attach protocol instrumentation.
     */
    configureRequestServer?: (
      server: McpFnServer<TContext>,
    ) => void | Promise<void>;
  };

function mergeCapabilities(
  base: ServerCapabilities,
  extra: ServerCapabilities | undefined,
): ServerCapabilities {
  const merged = { ...base, ...extra };
  for (const key of ["prompts", "resources", "tools", "tasks"] as const) {
    if (base[key] || extra?.[key]) {
      (merged as Record<string, unknown>)[key] = {
        ...(base[key] as object | undefined),
        ...(extra?.[key] as object | undefined),
      };
    }
  }
  return merged;
}

/** Resolve the exact protocol/manifest capabilities from one registry contract. */
export function resolveMcpFnServerCapabilities<TContext>(
  registry: McpFnRegistry<TContext>,
  additionalCapabilities: ServerCapabilities | undefined,
  includeTaskOperations: boolean,
): ServerCapabilities {
  const registryCapabilities = registry.capabilities();
  if (registryCapabilities.tasks && includeTaskOperations) {
    registryCapabilities.tasks = {
      ...registryCapabilities.tasks,
      list: {},
      cancel: {},
    };
  }
  return mergeCapabilities(registryCapabilities, additionalCapabilities);
}

function page<T>(
  values: T[],
  cursor: string | undefined,
  pageSize: number,
): { values: T[]; nextCursor?: string } {
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^mcpfn:(\d+)$/.exec(cursor);
    if (!match) throw new McpError(ErrorCode.InvalidParams, "Invalid McpFn pagination cursor");
    offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset > values.length) {
      throw new McpError(ErrorCode.InvalidParams, "Expired McpFn pagination cursor");
    }
  }
  const selected = values.slice(offset, offset + pageSize);
  const nextOffset = offset + selected.length;
  return {
    values: selected,
    ...(nextOffset < values.length ? { nextCursor: `mcpfn:${nextOffset}` } : {}),
  };
}

async function releaseAfterResponse(
  response: Response,
  release: () => Promise<void>,
): Promise<Response> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await release();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await release();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class McpFnServer<TContext = undefined> {
  readonly registry: McpFnRegistry<TContext>;
  readonly info: McpFnServerInfo;
  readonly protocol: Server;
  readonly capabilities: ServerCapabilities;
  private readonly contextFactory: (
    extra: McpFnRequestExtra,
  ) => TContext | Promise<TContext>;
  private readonly toolVisibility?: McpFnServerOptions<TContext>["toolVisibility"];
  private readonly clientProfiles?: McpFnClientProfileHooks<TContext>;
  private readonly manifestOptions: CreateManifestOptions;
  private readonly pageSize: number;
  private readonly serverOptions: McpFnServerOptions<TContext>;
  private readonly requestServers = new Set<McpFnServer<TContext>>();
  private connected = false;

  constructor(options: McpFnServerOptions<TContext>) {
    this.serverOptions = { ...options };
    this.info = options.info;
    this.registry = options.registry;
    assertMcpAppContracts(this.registry);
    this.contextFactory = options.context ?? (() => undefined as TContext);
    this.toolVisibility = options.toolVisibility;
    this.clientProfiles = options.clientProfiles;
    this.pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) {
      throw new Error("McpFn pageSize must be a positive integer");
    }
    const hasTaskTools = Boolean(this.registry.capabilities().tasks);
    if (hasTaskTools && !options.taskStore) {
      throw new Error("Task-capable McpFn tools require a taskStore");
    }
    const declaredCapabilities = mergeCapabilities(
      options.capabilities ?? {},
      options.additionalCapabilities,
    );
    this.capabilities = resolveMcpFnServerCapabilities(
      this.registry,
      declaredCapabilities,
      Boolean(options.taskStore),
    );
    this.manifestOptions = {
      protocolVersions: options.protocolVersions,
      transports: options.transports,
      extensions: options.extensions,
      capabilities: this.capabilities,
      clientRequirements: options.clientRequirements,
    };
    const { instructions, ...implementation } = options.info;
    this.protocol = new Server(
      implementation,
      {
        capabilities: this.capabilities,
        instructions,
        taskStore: options.taskStore,
        taskMessageQueue: options.taskMessageQueue,
        defaultTaskPollInterval: options.defaultTaskPollInterval,
        maxTaskQueueSize: options.maxTaskQueueSize,
        enforceStrictCapabilities: options.enforceStrictCapabilities,
        debouncedNotificationMethods: [
          "notifications/tools/list_changed",
          "notifications/resources/list_changed",
          "notifications/prompts/list_changed",
        ],
      },
    );
    this.installHandlers();
  }

  private installHandlers(): void {
    if (this.capabilities.tools) {
      this.protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const tools = this.registry.listTools();
        const context = await this.contextFactory(extra);
        const visibleTools = this.toolVisibility
          ? await this.filterVisibleTools(tools, context, extra)
          : tools;
        const profile = await this.resolveClientProfile(context, extra);
        const projectedTools = this.clientProfiles?.projectCatalog
          ? await this.clientProfiles.projectCatalog({
            tools: structuredClone(visibleTools), profile, context, extra,
          })
          : visibleTools;
        const result = page(projectedTools, request.params?.cursor, this.pageSize);
        return { tools: result.values, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
      });
      this.protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const context = await this.contextFactory(extra);
        const profile = await this.resolveClientProfile(context, extra);
        const canonicalTools = this.registry.listTools();
        const visibleTools = this.toolVisibility
          ? await this.filterVisibleTools(canonicalTools, context, extra)
          : canonicalTools;
        const effectiveTools = this.clientProfiles?.projectCatalog
          ? await this.clientProfiles.projectCatalog({
            tools: structuredClone(visibleTools), profile, context, extra,
          })
          : visibleTools;
        const listedTool = effectiveTools.find((tool) => tool.name === request.params.name);
        if (!listedTool) {
          throw new McpError(ErrorCode.MethodNotFound, `Tool ${request.params.name} not found`);
        }
        const taskSupport = this.registry.taskSupport(request.params.name);
        const isTaskRequest = Boolean(request.params.task);
        if (taskSupport === "required" && !isTaskRequest) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${request.params.name} requires task augmentation`,
          );
        }
        if (taskSupport === "forbidden" && isTaskRequest) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${request.params.name} does not support task augmentation`,
          );
        }
        try {
          const rawArguments = request.params.arguments ?? {};
          const preparedArguments = this.clientProfiles?.enrichArguments
            ? await this.clientProfiles.enrichArguments({
              tool: listedTool,
              arguments: structuredClone(rawArguments),
              profile,
              context,
              extra,
            })
            : rawArguments;
          if (isTaskRequest) {
            if (!extra.taskStore) throw new Error("No task store is available");
            return await this.registry.createToolTask(
              request.params.name,
              preparedArguments,
              context,
              extra as McpFnTaskRequestExtra,
            );
          }
          return await this.registry.callTool(
            request.params.name,
            preparedArguments,
            context,
            extra,
          );
        } catch (error) {
          if (isTaskRequest) throw error;
          return errorResult(error, {
            includeStructuredContent: !this.registry.hasOutputSchema(request.params.name),
          });
        }
      });
    }

    if (this.capabilities.resources) {
      this.protocol.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
        const context = await this.contextFactory(extra);
        const result = page(
          await this.registry.listResources(context, extra),
          request.params?.cursor,
          this.pageSize,
        );
        return {
          resources: result.values,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      });
      this.protocol.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
        const result = page(
          this.registry.listResourceTemplates(),
          request.params?.cursor,
          this.pageSize,
        );
        return {
          resourceTemplates: result.values,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      });
      this.protocol.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
        const context = await this.contextFactory(extra);
        return this.registry.readResource(request.params.uri, context, extra);
      });
      if (this.capabilities.resources.subscribe) {
        this.protocol.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
          const context = await this.contextFactory(extra);
          await this.registry.changeSubscription(request.params.uri, true, context, extra);
          return {};
        });
        this.protocol.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
          const context = await this.contextFactory(extra);
          await this.registry.changeSubscription(request.params.uri, false, context, extra);
          return {};
        });
      }
    }

    if (this.capabilities.prompts) {
      this.protocol.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        const result = page(this.registry.listPrompts(), request.params?.cursor, this.pageSize);
        return {
          prompts: result.values,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      });
      this.protocol.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
        const context = await this.contextFactory(extra);
        return this.registry.getPrompt(
          request.params.name,
          request.params.arguments,
          context,
          extra,
        );
      });
    }

    if (this.capabilities.completions) {
      this.protocol.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
        const context = await this.contextFactory(extra);
        return this.registry.complete(
          request.params.ref,
          request.params.argument,
          request.params.context?.arguments,
          context,
          extra,
        );
      });
    }
  }

  private async resolveClientProfile(
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<McpFnClientProfile> {
    const verifiedIdentity = await this.clientProfiles?.verifiedIdentity?.(context, extra);
    const protocol = this.protocol as unknown as {
      getClientVersion?(): import("@modelcontextprotocol/sdk/types.js").Implementation | undefined;
      getClientCapabilities?(): import("@modelcontextprotocol/sdk/types.js").ClientCapabilities | undefined;
    };
    const initialization = {
      clientInfo: protocol.getClientVersion?.(),
      capabilities: protocol.getClientCapabilities?.(),
    };
    const selected = await this.clientProfiles?.selectProfile?.({
      verifiedIdentity, initialization, context, extra,
    });
    return {
      id: selected?.id ?? MCPFN_GENERIC_CLIENT_PROFILE_ID,
      ...(selected?.version ? { version: selected.version } : {}),
      ...(verifiedIdentity ? { verifiedIdentity } : {}),
      initialization,
    };
  }

  private async filterVisibleTools(
    tools: McpFnListedTool[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<McpFnListedTool[]> {
    if (!this.toolVisibility) return tools;
    const decisions = await Promise.all(tools.map((tool) =>
      this.toolVisibility!({ tool, context, extra })));
    return tools.filter((_, index) => decisions[index]);
  }

  manifest(): McpFnManifest {
    return createManifest(this.info, this.registry, this.manifestOptions);
  }

  async connect(transport: Transport): Promise<void> {
    if (this.connected) throw new Error("McpFnServer is already connected to a transport");
    await this.protocol.connect(transport);
    this.connected = true;
  }

  async serveStdio(): Promise<void> {
    await this.connect(new StdioServerTransport());
  }

  async createWebStandardHandler(
    options: McpFnWebStandardHandlerOptions<TContext> = {},
  ): Promise<(request: Request, options?: HandleRequestOptions) => Promise<Response>> {
    const { configureRequestServer, ...transportOptions } = options;
    if (!transportOptions.sessionIdGenerator) {
      return async (request: Request, handleOptions?: HandleRequestOptions) => {
        const requestServer = new McpFnServer(this.serverOptions);
        const transport = new WebStandardStreamableHTTPServerTransport(transportOptions);
        this.requestServers.add(requestServer);
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          this.requestServers.delete(requestServer);
          await requestServer.close();
        };

        try {
          await configureRequestServer?.(requestServer);
          await requestServer.connect(transport);
          const response = await transport.handleRequest(request, handleOptions);
          return releaseAfterResponse(response, release);
        } catch (error) {
          await release();
          throw error;
        }
      };
    }

    const sessions = new Map<string, {
      server: McpFnServer<TContext>;
      transport: WebStandardStreamableHTTPServerTransport;
    }>();
    return async (request: Request, handleOptions?: HandleRequestOptions) => {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return session.transport.handleRequest(request, handleOptions);
      }

      const requestServer = new McpFnServer(this.serverOptions);
      let initializedSessionId: string | undefined;
      let released = false;
      let transport: WebStandardStreamableHTTPServerTransport;
      const release = async () => {
        if (released) return;
        released = true;
        if (initializedSessionId) sessions.delete(initializedSessionId);
        this.requestServers.delete(requestServer);
        await requestServer.close();
      };
      transport = new WebStandardStreamableHTTPServerTransport({
        ...transportOptions,
        onsessioninitialized: async (id) => {
          await transportOptions.onsessioninitialized?.(id);
          initializedSessionId = id;
          sessions.set(id, { server: requestServer, transport });
        },
        onsessionclosed: async (id) => {
          sessions.delete(id);
          try {
            await transportOptions.onsessionclosed?.(id);
          } finally {
            await release();
          }
        },
      });
      this.requestServers.add(requestServer);

      try {
        await configureRequestServer?.(requestServer);
        await requestServer.connect(transport);
        const response = await transport.handleRequest(request, handleOptions);
        if (initializedSessionId) return response;
        return releaseAfterResponse(response, release);
      } catch (error) {
        await release();
        throw error;
      }
    };
  }

  sample(
    params: McpFnSamplingParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnSamplingResult> {
    return this.protocol.createMessage(params, options);
  }

  sampleForRequest(
    extra: McpFnRequestExtra,
    params: McpFnSamplingParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnSamplingResult> {
    const schema = params.tools?.length
      ? CreateMessageResultWithToolsSchema
      : CreateMessageResultSchema;
    return extra.sendRequest(
      { method: "sampling/createMessage", params },
      schema,
      options,
    ) as Promise<McpFnSamplingResult>;
  }

  elicit(
    params: McpFnElicitationParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnElicitationResult> {
    return this.protocol.elicitInput(params, options);
  }

  elicitForRequest(
    extra: McpFnRequestExtra,
    params: McpFnElicitationParams,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnElicitationResult> {
    return extra.sendRequest(
      { method: "elicitation/create", params },
      ElicitResultSchema,
      options,
    );
  }

  listRoots(options?: RequestOptions): Promise<McpFnRootsResult> {
    return this.protocol.listRoots(undefined, options);
  }

  listRootsForRequest(
    extra: McpFnRequestExtra,
    options?: McpFnClientRequestOptions,
  ): Promise<McpFnRootsResult> {
    return extra.sendRequest(
      { method: "roots/list" },
      ListRootsResultSchema,
      options,
    );
  }

  sendLoggingMessage(params: LoggingMessageNotification["params"], sessionId?: string) {
    return this.protocol.sendLoggingMessage(params, sessionId);
  }

  sendResourceUpdated(params: ResourceUpdatedNotification["params"]) {
    return this.protocol.sendResourceUpdated(params);
  }

  sendResourceListChanged() {
    return this.protocol.sendResourceListChanged();
  }

  sendToolListChanged() {
    return this.protocol.sendToolListChanged();
  }

  sendPromptListChanged() {
    return this.protocol.sendPromptListChanged();
  }

  async close(): Promise<void> {
    const requestServers = [...this.requestServers];
    this.requestServers.clear();
    await Promise.all(requestServers.map((server) => server.close()));
    await this.protocol.close();
    this.connected = false;
  }
}

export function createMcpFnServer<TContext = undefined>(
  options: McpFnServerOptions<TContext>,
): McpFnServer<TContext> {
  return new McpFnServer(options);
}
