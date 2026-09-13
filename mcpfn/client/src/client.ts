import { randomUUID } from "node:crypto";

import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  CreateTaskResultSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  TaskStatusNotificationSchema,
  type CallToolResult,
  type ClientCapabilities,
  type CompleteRequest,
  type CompleteResult,
  type CreateTaskResult,
  type GetPromptResult,
  type Implementation,
  type ListTasksResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Task,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import type {
  McpFnClientState,
  McpFnClientEvent,
  McpFnClientEventKind,
  McpFnClientEventSink,
  McpFnClientMediatedHandlers,
  McpFnConfigureClient,
  McpFnDiagnosticEvent,
  McpFnDiagnosticPhase,
  McpFnDiagnosticSink,
  McpFnTarget,
  McpFnTargetDescriptor,
  McpFnTransportHandle,
} from "./types.js";
import { McpFnClientError } from "./types.js";

const DEFAULT_MAX_INVENTORY_PAGES = 1_000;

export interface McpFnClientOptions {
  target: McpFnTarget;
  info?: Implementation;
  capabilities?: ClientCapabilities;
  clientOptions?: Omit<ClientOptions, "capabilities">;
  configure?: McpFnConfigureClient;
  diagnostics?: McpFnDiagnosticSink;
  events?: McpFnClientEventSink;
  handlers?: McpFnClientMediatedHandlers;
  requestId?: () => string;
  clock?: () => Date;
  connectRetries?: number;
  connectRetryDelayMs?: number;
  maxInventoryPages?: number;
}

export interface McpFnBoundedInventory<T> {
  items: T[];
  droppedItems: number;
  complete: boolean;
}

export class McpFnClient {
  private readonly options: McpFnClientOptions;
  private readonly listeners = new Set<McpFnDiagnosticSink>();
  private readonly eventListeners = new Set<McpFnClientEventSink>();
  private _state: McpFnClientState = "idle";
  private _protocol?: Client;
  private handle?: McpFnTransportHandle;
  private readonly pendingCleanup = new Set<McpFnTransportHandle>();
  private readonly cleanupPromises = new Map<McpFnTransportHandle, Promise<void>>();
  private connectPromise?: Promise<void>;
  private readonly openingSignals = new Set<AbortSignal>();
  private closePromise?: Promise<void>;
  private connectController?: AbortController;

  readonly tools = {
    listAll: (options?: RequestOptions) => this.listTools(options),
    listBounded: (maxEntries: number, options?: RequestOptions) =>
      this.listToolsBounded(maxEntries, options),
    call: (name: string, args: Record<string, unknown> = {}, options?: RequestOptions) =>
      this.operation("tools/call", () => this.protocol.callTool(
        { name, arguments: args },
        undefined,
        this.observeProgress(options, "tools/call"),
      ) as Promise<CallToolResult>),
    createTask: (
      name: string,
      args: Record<string, unknown> = {},
      task: { ttl?: number } = {},
      options?: RequestOptions,
    ) => this.operation("tools/call:task", () => this.protocol.request(
      { method: "tools/call", params: { name, arguments: args, task } },
      CreateTaskResultSchema,
      this.observeProgress(options, "tools/call:task"),
    ) as Promise<CreateTaskResult>),
  };

  readonly resources = {
    listAll: (options?: RequestOptions) => this.listResources(options),
    listBounded: (maxEntries: number, options?: RequestOptions) =>
      this.listResourcesBounded(maxEntries, options),
    listTemplatesAll: (options?: RequestOptions) => this.listResourceTemplates(options),
    listTemplatesBounded: (maxEntries: number, options?: RequestOptions) =>
      this.listResourceTemplatesBounded(maxEntries, options),
    read: (uri: string, options?: RequestOptions): Promise<ReadResourceResult> =>
      this.operation("resources/read", () => this.protocol.readResource(
        { uri },
        this.observeProgress(options, "resources/read"),
      )),
    subscribe: async (uri: string, options?: RequestOptions): Promise<void> => {
      await this.operation("resources/subscribe", () =>
        this.protocol.subscribeResource(
          { uri },
          this.observeProgress(options, "resources/subscribe"),
        ));
      await this.emitEvent("resources.subscribed", { uri });
    },
    unsubscribe: async (uri: string, options?: RequestOptions): Promise<void> => {
      await this.operation("resources/unsubscribe", () =>
        this.protocol.unsubscribeResource(
          { uri },
          this.observeProgress(options, "resources/unsubscribe"),
        ));
      await this.emitEvent("resources.unsubscribed", { uri });
    },
  };

  readonly prompts = {
    listAll: (options?: RequestOptions) => this.listPrompts(options),
    listBounded: (maxEntries: number, options?: RequestOptions) =>
      this.listPromptsBounded(maxEntries, options),
    get: (
      name: string,
      args?: Record<string, string>,
      options?: RequestOptions,
    ): Promise<GetPromptResult> => this.operation("prompts/get", () =>
      this.protocol.getPrompt(
        { name, ...(args ? { arguments: args } : {}) },
        this.observeProgress(options, "prompts/get"),
      )),
    complete: (
      params: CompleteRequest["params"],
      options?: RequestOptions,
    ): Promise<CompleteResult> => this.operation("completion/complete", () =>
      this.protocol.complete(params, this.observeProgress(options, "completion/complete"))),
  };

  readonly tasks = {
    get: (taskId: string, options?: RequestOptions): Promise<Task> =>
      this.operation("tasks/get", () =>
        this.protocol.experimental.tasks.getTask(
          taskId,
          this.observeProgress(options, "tasks/get"),
        )),
    result: (taskId: string, options?: RequestOptions): Promise<CallToolResult> =>
      this.operation("tasks/result", () =>
        this.protocol.experimental.tasks.getTaskResult(
          taskId,
          CallToolResultSchema,
          this.observeProgress(options, "tasks/result"),
        ) as Promise<CallToolResult>),
    list: (cursor?: string, options?: RequestOptions): Promise<ListTasksResult> =>
      this.operation("tasks/list", () =>
        this.protocol.experimental.tasks.listTasks(
          cursor,
          this.observeProgress(options, "tasks/list"),
        )),
    cancel: (taskId: string, options?: RequestOptions): Promise<Task> =>
      this.operation("tasks/cancel", () =>
        this.protocol.experimental.tasks.cancelTask(
          taskId,
          this.observeProgress(options, "tasks/cancel"),
        )),
  };

  constructor(options: McpFnClientOptions) {
    this.options = options;
    const connectRetries = options.connectRetries ?? 0;
    if (!Number.isSafeInteger(connectRetries) || connectRetries < 0) {
      throw new Error("McpFn connectRetries must be a non-negative safe integer");
    }
    const maxInventoryPages = options.maxInventoryPages ?? DEFAULT_MAX_INVENTORY_PAGES;
    if (!Number.isSafeInteger(maxInventoryPages) || maxInventoryPages < 1) {
      throw new Error("McpFn maxInventoryPages must be a positive safe integer");
    }
    if (options.diagnostics) this.listeners.add(options.diagnostics);
    if (options.events) this.eventListeners.add(options.events);
  }

  get state(): McpFnClientState {
    return this._state;
  }

  get protocol(): Client {
    if (!this._protocol || this._state !== "connected") {
      throw new McpFnClientError(
        "MCPFN_CLIENT_NOT_CONNECTED",
        "McpFn client is not connected",
        { phase: "capability-operation" },
      );
    }
    return this._protocol;
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this._protocol?.getServerCapabilities();
  }

  getServerVersion(): Implementation | undefined {
    return this._protocol?.getServerVersion();
  }

  getTargetDescriptor() {
    return this.options.target.describe();
  }

  onDiagnostic(listener: McpFnDiagnosticSink): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: McpFnClientEventSink): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  waitForEvent(
    predicate: (event: McpFnClientEvent) => boolean,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpFnClientEvent> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("aborted", "AbortError"));
      };
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        cleanup();
        resolve(event);
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) return onAbort();
      timer = setTimeout(() => {
        cleanup();
        reject(new McpFnClientError(
          "MCPFN_OPERATION_FAILED",
          "Timed out waiting for an MCP client event",
          { phase: "capability-operation" },
        ));
      }, options.timeoutMs ?? 30_000);
    });
  }

  async connect(): Promise<void> {
    if (this.closePromise) await this.closePromise;
    if (this._state === "closing" || this.pendingCleanup.size > 0 || [...this.openingSignals].some(signal => signal.aborted)) throw new McpFnClientError("MCPFN_OPERATION_FAILED", "Retry close before reconnecting after failed cleanup", { phase: "transport-close", retryable: true });
    if (this._state === "connected") return;
    if (this.connectPromise) return this.connectPromise;
    if (this._state === "authorization-required") {
      throw new McpFnClientError(
        "MCPFN_AUTHORIZATION_REQUIRED",
        "MCP authorization is required; complete the callback before reconnecting",
        { phase: "authorization-request", retryable: true },
      );
    }
    if (this._state === "closed") this._state = "idle";
    const controller = new AbortController();
    this.connectController = controller;
    let connectPromise: Promise<void>;
    connectPromise = this.connectInternal(controller.signal).finally(() => {
      if (this.connectController === controller) this.connectController = undefined;
      if (this.connectPromise === connectPromise) this.connectPromise = undefined;
    });
    this.connectPromise = connectPromise;
    return connectPromise;
  }

  private async connectInternal(signal: AbortSignal): Promise<void> {
    const retries = this.options.connectRetries ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal.aborted) throw connectAbortedError(lastError);
      const requestId = this.requestId();
      this._state = "connecting";
      await this.emit("transport-connect", "started", requestId, undefined, { attempt });
      const openFailure = await this.openTargetAttempt(requestId, attempt, retries, signal);
      if (openFailure) {
        lastError = openFailure.error;
        continue;
      }
      const initialization = await this.initializeAttempt(requestId, attempt, signal);
      if (initialization.connected) return;
      lastError = initialization.error;
      if (attempt < retries) await this.connectRetryDelay(signal);
    }
    this._state = "idle";
    throw new McpFnClientError(
      "MCPFN_CONNECT_FAILED",
      "Failed to connect and initialize the MCP session",
      { phase: "mcp-initialize", retryable: true, cause: lastError },
    );
  }

  private async openTargetAttempt(
    requestId: string,
    attempt: number,
    retries: number,
    signal: AbortSignal,
  ): Promise<{ error: unknown } | undefined> {
    this.openingSignals.add(signal);
    try {
      const handle = await this.options.target.open({
        requestId,
        signal,
        diagnostic: (event) => this.dispatch(event),
      });
      if (signal.aborted) {
        await this.closeRetainedHandle(handle);
        throw connectAbortedError();
      }
      this.handle = handle;
      return undefined;
    } catch (error) {
      if (signal.aborted) throw connectAbortedError(error);
      await this.emit("transport-connect", "failed", requestId, "MCPFN_TARGET_OPEN_FAILED", {
        attempt,
        message: errorMessage(error),
      });
      if (attempt < retries) {
        await this.connectRetryDelay(signal);
        return { error };
      }
      this._state = "idle";
      throw new McpFnClientError(
        "MCPFN_TARGET_OPEN_FAILED",
        "Failed to open the MCP target",
        { phase: "transport-connect", retryable: true, cause: error },
      );
    } finally {
      this.openingSignals.delete(signal);
    }
  }

  private async initializeAttempt(
    requestId: string,
    attempt: number,
    signal: AbortSignal,
  ): Promise<{ connected: true } | { connected: false; error: unknown }> {
    const handle = this.handle!;
    const protocol = this.createProtocol();
    await this.emit("mcp-initialize", "started", requestId);
    try {
      this.installFirstClassHandlers(protocol);
      await this.options.configure?.(protocol);
      await this.rejectAbortedInitialization(signal, protocol, handle);
      await protocol.connect(handle.transport);
      await this.rejectAbortedInitialization(signal, protocol, handle);
      this._state = "connected";
      await this.emit("transport-connect", "succeeded", requestId, undefined, { attempt });
      await this.emit("mcp-initialize", "succeeded", requestId, undefined, {
        server: protocol.getServerVersion(),
        capabilities: protocol.getServerCapabilities(),
      });
      return { connected: true };
    } catch (error) {
      return this.handleInitializationFailure(
        error,
        requestId,
        attempt,
        signal,
        protocol,
        handle,
      );
    }
  }

  private createProtocol(): Client {
    const protocol = new Client(
      this.options.info ?? { name: "mcpfn-client", version: "0.0.1" },
      {
        ...this.instrumentClientOptions(),
        capabilities: this.effectiveCapabilities(),
      },
    );
    this._protocol = protocol;
    protocol.onerror = (error) => {
      void this.emit("capability-operation", "failed", this.requestId(), errorCode(error), {
        message: error.message,
        source: "protocol",
      });
    };
    protocol.onclose = () => this.handleProtocolClose(protocol);
    return protocol;
  }

  private handleProtocolClose(protocol: Client): void {
    if (this._protocol !== protocol || this._state !== "connected") return;
    // Use the same retryable cleanup owner as explicit close.
    void this.close(false).catch(() => undefined);
  }

  private async rejectAbortedInitialization(
    signal: AbortSignal,
    protocol: Client,
    handle: McpFnTransportHandle,
  ): Promise<void> {
    if (!signal.aborted && this._protocol === protocol && this.handle === handle) return;
    await this.cleanupOwnedAttempt(protocol, handle);
    throw connectAbortedError();
  }

  private async handleInitializationFailure(
    error: unknown,
    requestId: string,
    attempt: number,
    signal: AbortSignal,
    protocol: Client,
    handle: McpFnTransportHandle,
  ): Promise<{ connected: false; error: unknown }> {
    if (signal.aborted || this._protocol !== protocol || this.handle !== handle) {
      await this.cleanupOwnedAttempt(protocol, handle);
      throw connectAbortedError(error);
    }
    if (error instanceof UnauthorizedError) {
      this._state = "authorization-required";
      await this.emit(
        "authorization-request",
        "succeeded",
        requestId,
        "MCPFN_AUTHORIZATION_REQUIRED",
      );
      throw new McpFnClientError(
        "MCPFN_AUTHORIZATION_REQUIRED",
        "MCP authorization is required; complete the callback and retry",
        { phase: "authorization-request", retryable: true, cause: error },
      );
    }
    await this.emit("mcp-initialize", "failed", requestId, errorCode(error), {
      message: errorMessage(error),
      attempt,
    });
    await this.cleanupOwnedAttempt(protocol, handle);
    return { connected: false, error };
  }

  private connectRetryDelay(signal: AbortSignal): Promise<void> {
    return delay(this.options.connectRetryDelayMs ?? 100, signal);
  }

  async completeAuthorization(
    callback: string | { code: string; state?: string },
  ): Promise<void> {
    const authorizationCode = typeof callback === "string" ? callback : callback.code;
    const state = typeof callback === "string" ? undefined : callback.state;
    const requestId = this.requestId();
    if (this._state !== "authorization-required" || !this.handle?.finishAuthorization) {
      throw new McpFnClientError(
        "MCPFN_AUTH_CALLBACK_UNSUPPORTED",
        "The current target has no pending authorization callback",
        { phase: "authorization-callback" },
      );
    }
    await this.emit("authorization-callback", "started", requestId);
    await this.emit("token-exchange", "started", requestId);
    try {
      await this.handle.finishAuthorization(authorizationCode, state);
      await this.emit("token-exchange", "succeeded", requestId);
      await this.emit("authorization-callback", "succeeded", requestId);
    } catch (error) {
      await this.emit("token-exchange", "failed", requestId, errorCode(error), {
        message: errorMessage(error),
      });
      throw new McpFnClientError(
        "MCPFN_AUTH_CALLBACK_FAILED",
        "Failed to exchange the MCP authorization callback",
        { phase: "token-exchange", cause: error },
      );
    }
    await this.cleanupAttempt();
    this._state = "idle";
    await this.connect();
  }

  /** Explicit reconnect. McpFn never replays the caller's capability operation. */
  async reconnect(): Promise<void> {
    await this.close(false);
    this._state = "idle";
    await this.connect();
  }

  async terminateSession(): Promise<void> {
    await this.handle?.terminateSession?.();
  }

  async close(permanent = true): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this._state === "closed" && permanent && this.pendingCleanup.size === 0) return;
    this.closePromise = (async () => {
      this._state = "closing";
      const requestId = this.requestId();
      await this.emit("transport-close", "started", requestId);
      const pendingConnect = this.connectPromise;
      const pendingController = this.connectController;
      void pendingConnect?.catch(() => undefined);
      pendingController?.abort();

      if (this.connectPromise === pendingConnect) this.connectPromise = undefined;
      if (this.connectController === pendingController) this.connectController = undefined;
      try {
        await this.cleanupAttempt(true);
      } catch {
        this._state = "closing";
        await this.emit("transport-close", "failed", requestId);
        throw new Error("MCP target cleanup failed");
      }
      // Retain an observed continuation without leaving the aborted attempt as
      // the active connection. A custom target that ignores abort may settle
      // later, but its isolated handle is closed by openTargetAttempt().
      void pendingConnect?.catch(() => undefined);
      this._state = permanent ? "closed" : "idle";
      await this.emit("transport-close", "succeeded", requestId);
    })().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async cleanupAttempt(strict = false): Promise<void> {
    const protocol = this._protocol;
    const handle = this.handle;
    this._protocol = undefined;
    this.handle = undefined;
    const handles = new Set(this.pendingCleanup);
    if (handle) handles.add(handle);
    const results = await Promise.allSettled([protocol?.close(), this.options.target.cleanup?.(), ...[...handles].map(item => this.closeRetainedHandle(item, strict))]);
    if (strict && results.some((result) => result.status === "rejected")) {
      if (results[0].status === "rejected") this._protocol = protocol;

      throw new Error("MCP target cleanup failed");
    }
  }

  private async closeRetainedHandle(handle: McpFnTransportHandle | undefined, strict = false): Promise<void> {
    if (!handle) return;
    this.pendingCleanup.add(handle);
    let pending = this.cleanupPromises.get(handle);
    if (!pending) {
      pending = closeTransportHandle(handle, true).then(() => {
        this.pendingCleanup.delete(handle);
      }).finally(() => { this.cleanupPromises.delete(handle); });
      this.cleanupPromises.set(handle, pending);
    }
    try {
      await pending;
    } catch {
      await this.emit("transport-close", "failed", this.requestId(), "MCPFN_CREDENTIAL_CLEANUP_FAILED");
      if (strict) throw new Error("MCP target cleanup failed");
    }
  }

  private async cleanupOwnedAttempt(
    protocol: Client,
    handle: McpFnTransportHandle,
  ): Promise<void> {
    const ownsProtocol = this._protocol === protocol;
    const ownsHandle = this.handle === handle;
    if (ownsProtocol) this._protocol = undefined;
    if (ownsHandle) this.handle = undefined;
    if (ownsProtocol) await protocol.close().catch(() => undefined);
    if (ownsHandle) await this.closeRetainedHandle(handle);
  }

  private async listTools(options?: RequestOptions): Promise<Tool[]> {
    return (await this.listToolsBounded(undefined, options)).items;
  }

  private async listToolsBounded(
    maxEntries: number | undefined,
    options?: RequestOptions,
  ): Promise<McpFnBoundedInventory<Tool>> {
    return this.listInventory("tools/list", maxEntries, async (cursor) => {
      const page = await this.protocol.listTools(
        cursor ? { cursor } : undefined,
        this.observeProgress(options, "tools/list"),
      );
      return { items: page.tools, nextCursor: page.nextCursor };
    });
  }

  private async listResources(options?: RequestOptions): Promise<Resource[]> {
    return (await this.listResourcesBounded(undefined, options)).items;
  }

  private async listResourcesBounded(
    maxEntries: number | undefined,
    options?: RequestOptions,
  ): Promise<McpFnBoundedInventory<Resource>> {
    return this.listInventory("resources/list", maxEntries, async (cursor) => {
      const page = await this.protocol.listResources(
        cursor ? { cursor } : undefined,
        this.observeProgress(options, "resources/list"),
      );
      return { items: page.resources, nextCursor: page.nextCursor };
    });
  }

  private async listResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    return (await this.listResourceTemplatesBounded(undefined, options)).items;
  }

  private async listResourceTemplatesBounded(
    maxEntries: number | undefined,
    options?: RequestOptions,
  ): Promise<McpFnBoundedInventory<ResourceTemplate>> {
    return this.listInventory("resources/templates/list", maxEntries, async (cursor) => {
      const page = await this.protocol.listResourceTemplates(
        cursor ? { cursor } : undefined,
        this.observeProgress(options, "resources/templates/list"),
      );
      return { items: page.resourceTemplates, nextCursor: page.nextCursor };
    });
  }

  private async listPrompts(options?: RequestOptions): Promise<Prompt[]> {
    return (await this.listPromptsBounded(undefined, options)).items;
  }

  private async listPromptsBounded(
    maxEntries: number | undefined,
    options?: RequestOptions,
  ): Promise<McpFnBoundedInventory<Prompt>> {
    return this.listInventory("prompts/list", maxEntries, async (cursor) => {
      const page = await this.protocol.listPrompts(
        cursor ? { cursor } : undefined,
        this.observeProgress(options, "prompts/list"),
      );
      return { items: page.prompts, nextCursor: page.nextCursor };
    });
  }

  private async listInventory<T>(
    operation: string,
    maxEntries: number | undefined,
    loadPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<McpFnBoundedInventory<T>> {
    if (
      maxEntries !== undefined &&
      (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    ) {
      throw new TypeError("McpFn inventory maxEntries must be a positive safe integer");
    }
    return this.operation(operation, async () => {
      const values: T[] = [];
      let droppedItems = 0;
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      const maxPages = this.options.maxInventoryPages ?? DEFAULT_MAX_INVENTORY_PAGES;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const page = await loadPage(cursor);
        for (const item of page.items) {
          if (maxEntries === undefined || values.length < maxEntries) values.push(item);
          else droppedItems += 1;
        }
        if (!page.nextCursor) {
          return { items: values, droppedItems, complete: droppedItems === 0 };
        }
        if (seenCursors.has(page.nextCursor)) {
          throw inventoryPaginationError(operation, "cursor repeated");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw inventoryPaginationError(operation, `exceeded ${maxPages} pages`);
    });
  }

  private async operation<T>(name: string, run: () => Promise<T>): Promise<T> {
    const requestId = this.requestId();
    await this.emit("capability-operation", "started", requestId, undefined, { operation: name });
    try {
      const result = await run();
      await this.emit("capability-operation", "succeeded", requestId, undefined, {
        operation: name,
      });
      return result;
    } catch (error) {
      await this.emit("capability-operation", "failed", requestId, errorCode(error), {
        operation: name,
        message: errorMessage(error),
      });
      throw error;
    }
  }

  private effectiveCapabilities(): ClientCapabilities {
    const capabilities = structuredClone(this.options.capabilities ?? {});
    if (this.options.handlers?.roots) {
      capabilities.roots = { ...capabilities.roots };
    }
    if (this.options.handlers?.sampling) {
      capabilities.sampling = { ...capabilities.sampling };
    }
    if (this.options.handlers?.elicitation) {
      capabilities.elicitation = capabilities.elicitation ?? { form: {} };
    }
    return capabilities;
  }

  private installFirstClassHandlers(protocol: Client): void {
    const handlers = this.options.handlers;
    if (handlers?.roots) {
      protocol.setRequestHandler(ListRootsRequestSchema, async (request, extra) => {
        const result = await handlers.roots!(request, extra);
        await this.emitEvent("client.roots", { request, result });
        return result;
      });
    }
    if (handlers?.sampling) {
      protocol.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        const result = await handlers.sampling!(request, extra);
        await this.emitEvent("client.sampling", { request, result });
        return result;
      });
    }
    if (handlers?.elicitation) {
      protocol.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const result = await handlers.elicitation!(request, extra);
        await this.emitEvent("client.elicitation", { request, result });
        return result;
      });
    }
    protocol.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
      this.emitEvent("logging.message", notification.params));
    protocol.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) =>
      this.emitEvent("resources.updated", notification.params));
    protocol.setNotificationHandler(TaskStatusNotificationSchema, (notification) =>
      this.emitEvent("tasks.status", notification.params));
  }

  private instrumentClientOptions(): Omit<ClientOptions, "capabilities"> {
    const original = this.options.clientOptions;
    const wrap = <T>(
      kind: "tools.list_changed" | "resources.list_changed" | "prompts.list_changed",
      current: { autoRefresh?: boolean; debounceMs?: number; onChanged(error: Error | null, items: T[] | null): void } | undefined,
    ) => ({
      ...current,
      onChanged: (error: Error | null, items: T[] | null) => {
        void this.emitEvent(kind, {
          ...(error ? { error: error.message } : {}),
          ...(items ? { items } : {}),
        });
        try {
          current?.onChanged(error, items);
        } catch (callbackError) {
          void this.emit(
            "capability-operation",
            "failed",
            this.requestId(),
            "MCPFN_LIST_CHANGED_CALLBACK_FAILED",
            {
              operation: kind,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            },
          );
        }
      },
    });
    return {
      ...original,
      listChanged: {
        tools: wrap<Tool>("tools.list_changed", original?.listChanged?.tools),
        resources: wrap<Resource>("resources.list_changed", original?.listChanged?.resources),
        prompts: wrap<Prompt>("prompts.list_changed", original?.listChanged?.prompts),
      },
    };
  }

  private observeProgress(options: RequestOptions | undefined, operation: string): RequestOptions {
    return {
      ...options,
      onprogress: (progress) => {
        void this.emitEvent("progress", { operation, ...progress });
        options?.onprogress?.(progress);
      },
    };
  }

  private async emitEvent(kind: McpFnClientEventKind, payload?: unknown): Promise<void> {
    const event = redactOAuthValue({
      formatVersion: 1,
      kind,
      at: (this.options.clock?.() ?? new Date()).toISOString(),
      requestId: this.requestId(),
      target: this.options.target.describe(),
      ...(payload !== undefined ? { payload } : {}),
    }) as unknown as McpFnClientEvent;
    await Promise.allSettled(
      [...this.eventListeners].map(async (listener) => listener(event)),
    );
  }

  private requestId(): string {
    return this.options.requestId?.() ?? randomUUID();
  }

  private async emit(
    phase: McpFnDiagnosticPhase,
    outcome: McpFnDiagnosticEvent["outcome"],
    requestId: string,
    code?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.dispatch({
      phase,
      outcome,
      ...(code ? { code } : {}),
      requestId,
      at: (this.options.clock?.() ?? new Date()).toISOString(),
      target: redactOAuthValue(
        this.options.target.describe(),
      ) as unknown as McpFnTargetDescriptor,
      ...(details
        ? {
            details: redactOAuthValue(
              details,
            ) as unknown as Record<string, unknown>,
          }
        : {}),
    });
  }

  private async dispatch(event: McpFnDiagnosticEvent): Promise<void> {
    const redacted = redactOAuthValue(event) as unknown as McpFnDiagnosticEvent;
    await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(redacted)),
    );
  }
}

export function createMcpFnClient(options: McpFnClientOptions): McpFnClient {
  return new McpFnClient(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

async function closeTransportHandle(handle: McpFnTransportHandle | undefined, strict = false): Promise<void> {
  if (!handle) return;
  try {
    if (handle.close) await handle.close();
    else await handle.transport.close();
  } catch (error) { if (strict) throw error; }
}

function connectAbortedError(cause?: unknown): McpFnClientError {
  return new McpFnClientError(
    "MCPFN_CONNECT_ABORTED",
    "McpFn connection was aborted",
    { phase: "transport-connect", cause },
  );
}

function inventoryPaginationError(operation: string, reason: string): McpFnClientError {
  return new McpFnClientError(
    "MCPFN_OPERATION_FAILED",
    `MCP inventory pagination failed: ${reason}`,
    { phase: "capability-operation", details: { operation, reason } },
  );
}
