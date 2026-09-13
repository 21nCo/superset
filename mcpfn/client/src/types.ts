import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
  ListRootsRequest,
  ListRootsResult,
} from "@modelcontextprotocol/sdk/types.js";

export type McpFnDiagnosticPhase =
  | "resource-discovery"
  | "authorization-server-discovery"
  | "client-registration"
  | "authorization-request"
  | "authorization-callback"
  | "token-exchange"
  | "token-refresh"
  | "token-revocation"
  | "transport-connect"
  | "mcp-initialize"
  | "capability-operation"
  | "transport-close";

export type McpFnDiagnosticOutcome = "started" | "succeeded" | "failed";

export interface McpFnTargetDescriptor extends Record<string, unknown> {
  kind: string;
}

export interface McpFnDiagnosticEvent {
  phase: McpFnDiagnosticPhase;
  outcome: McpFnDiagnosticOutcome;
  code?: string;
  requestId: string;
  at: string;
  target: McpFnTargetDescriptor;
  details?: Record<string, unknown>;
}

export type McpFnDiagnosticSink = (
  event: McpFnDiagnosticEvent,
) => void | Promise<void>;

export type McpFnClientEventKind =
  | "logging.message"
  | "progress"
  | "tasks.status"
  | "resources.updated"
  | "tools.list_changed"
  | "resources.list_changed"
  | "prompts.list_changed"
  | "resources.subscribed"
  | "resources.unsubscribed"
  | "client.roots"
  | "client.sampling"
  | "client.elicitation";

export interface McpFnClientEvent {
  formatVersion: 1;
  kind: McpFnClientEventKind;
  at: string;
  requestId: string;
  target: McpFnTargetDescriptor;
  payload?: unknown;
}

export type McpFnClientEventSink = (
  event: McpFnClientEvent,
) => void | Promise<void>;

export interface McpFnClientMediatedHandlers {
  roots?(
    request: ListRootsRequest,
    extra: unknown,
  ): ListRootsResult | Promise<ListRootsResult>;
  sampling?(
    request: CreateMessageRequest,
    extra: unknown,
  ): CreateMessageResult | CreateMessageResultWithTools |
    Promise<CreateMessageResult | CreateMessageResultWithTools>;
  elicitation?(
    request: ElicitRequest,
    extra: unknown,
  ): ElicitResult | Promise<ElicitResult>;
}

export interface McpFnTargetContext {
  requestId: string;
  signal?: AbortSignal;
  diagnostic: McpFnDiagnosticSink;
}

export interface McpFnTransportHandle {
  transport: Transport;
  finishAuthorization?(authorizationCode: string, state?: string): Promise<void>;
  terminateSession?(): Promise<void>;
  close?(): Promise<void>;
}

/** A target opens an official-SDK transport; it never implements MCP itself. */
export interface McpFnTarget {
  readonly kind: string;
  describe(): McpFnTargetDescriptor;
  open(context: McpFnTargetContext): Promise<McpFnTransportHandle>;
  /** Retry cleanup for resources retained by failed opens; live handles are separate. */
  cleanup?(): Promise<void>;
}

export type McpFnClientState =
  | "idle"
  | "connecting"
  | "authorization-required"
  | "connected"
  | "closing"
  | "closed";

export type McpFnClientErrorCode =
  | "MCPFN_AUTHORIZATION_REQUIRED"
  | "MCPFN_AUTH_CALLBACK_UNSUPPORTED"
  | "MCPFN_AUTH_CALLBACK_FAILED"
  | "MCPFN_CLIENT_NOT_CONNECTED"
  | "MCPFN_CONNECT_ABORTED"
  | "MCPFN_CONNECT_FAILED"
  | "MCPFN_OPERATION_FAILED"
  | "MCPFN_TARGET_OPEN_FAILED";

export class McpFnClientError extends Error {
  readonly code: string;
  readonly phase: McpFnDiagnosticPhase;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      phase: McpFnDiagnosticPhase;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "McpFnClientError";
    this.code = code;
    this.phase = options.phase;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export type McpFnConfigureClient = (
  client: Client,
) => void | Promise<void>;
