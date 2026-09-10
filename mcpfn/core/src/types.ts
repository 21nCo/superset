import type {
  Annotations,
  CallToolResult,
  ClientCapabilities,
  CompleteResult,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  CreateTaskResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  GetPromptResult,
  Icon,
  Implementation,
  ListResourcesResult,
  ListRootsResult,
  PromptArgument,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
  Tool,
  ToolAnnotations,
  ToolExecution,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  RequestHandlerExtra,
  RequestOptions,
  RequestTaskStore,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

export type McpFnJsonSchema = Record<string, unknown>;

export type McpFnObjectSchema = McpFnJsonSchema & {
  type: "object";
  properties?: Record<string, McpFnJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | McpFnJsonSchema;
};

export type McpFnRequestExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
>;
export type McpFnTaskRequestExtra = McpFnRequestExtra & {
  taskStore: RequestTaskStore;
};

/** Safe structural JSON Schema diagnostic. Argument values are never retained. */
export interface McpFnSchemaIssue {
  /** Backwards-compatible alias for instancePath; `/` represents the root. */
  path: string;
  /** RFC 6901 path to the rejected input location; `/` represents the root. */
  instancePath: string;
  /** JSON Schema path reported by the validator. */
  schemaPath: string;
  keyword: string;
  message: string;
  /** Exact unknown property name for additionalProperties failures. */
  rejectedProperty?: string;
  /** Exact missing property name for required failures. */
  missingProperty?: string;
}

export type McpFnToolLifecycleStage =
  | "input-validation"
  | "handler"
  | "output-validation";

export interface McpFnToolLifecycleObserver {
  onStage?(stage: McpFnToolLifecycleStage): void;
}

export interface McpFnTaskHandler<TContext = undefined> {
  createTask(
    args: Record<string, unknown>,
    context: TContext,
    extra: McpFnTaskRequestExtra,
  ): CreateTaskResult | Promise<CreateTaskResult>;
}

export interface McpFnToolDefinition<TContext = undefined> {
  name: string;
  title?: string;
  description: string;
  inputSchema: McpFnObjectSchema;
  outputSchema?: McpFnObjectSchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
  handler(
    args: Record<string, unknown>,
    context: TContext,
    extra: McpFnRequestExtra,
  ): CallToolResult | Promise<CallToolResult>;
  /** Implements call-now/fetch-later execution when execution.taskSupport allows it. */
  taskHandler?: McpFnTaskHandler<TContext>;
  /** Optional domain-specific mapping for JSON Schema argument failures. */
  handleInvalidArguments?(
    args: Record<string, unknown>,
    issues: McpFnSchemaIssue[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): CallToolResult | Promise<CallToolResult>;
}

export interface McpFnResourceDefinition<TContext = undefined> {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
  read(
    uri: URL,
    context: TContext,
    extra: McpFnRequestExtra,
  ): ReadResourceResult | Promise<ReadResourceResult>;
  subscribe?(
    uri: URL,
    context: TContext,
    extra: McpFnRequestExtra,
  ): void | Promise<void>;
  unsubscribe?(
    uri: URL,
    context: TContext,
    extra: McpFnRequestExtra,
  ): void | Promise<void>;
}

export interface McpFnResourceTemplateDefinition<TContext = undefined> {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
  read(
    uri: URL,
    variables: Record<string, string | string[]>,
    context: TContext,
    extra: McpFnRequestExtra,
  ): ReadResourceResult | Promise<ReadResourceResult>;
  /** Optionally publishes concrete resources produced by this template. */
  list?(
    context: TContext,
    extra: McpFnRequestExtra,
  ): ListResourcesResult | Promise<ListResourcesResult>;
  complete?: Record<
    string,
    (
      value: string,
      completionContext: Record<string, string> | undefined,
      context: TContext,
      extra: McpFnRequestExtra,
    ) => CompleteResult | Promise<CompleteResult>
  >;
  subscribe?(
    uri: URL,
    variables: Record<string, string | string[]>,
    context: TContext,
    extra: McpFnRequestExtra,
  ): void | Promise<void>;
  unsubscribe?(
    uri: URL,
    variables: Record<string, string | string[]>,
    context: TContext,
    extra: McpFnRequestExtra,
  ): void | Promise<void>;
}

export interface McpFnPromptDefinition<TContext = undefined> {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  /** Optional stricter JSON Schema for prompt arguments. Values remain strings per MCP. */
  argumentsSchema?: McpFnObjectSchema;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
  get(
    args: Record<string, string>,
    context: TContext,
    extra: McpFnRequestExtra,
  ): GetPromptResult | Promise<GetPromptResult>;
  complete?: Record<
    string,
    (
      value: string,
      completionContext: Record<string, string> | undefined,
      context: TContext,
      extra: McpFnRequestExtra,
    ) => CompleteResult | Promise<CompleteResult>
  >;
}

export interface McpFnServerInfo extends Implementation {
  instructions?: string;
}

export interface McpFnManifestTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: McpFnObjectSchema;
  outputSchema?: McpFnObjectSchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
}

export interface McpFnManifestResource extends Omit<Resource, "_meta"> {
  /** Whether this concrete resource accepts resources/subscribe requests. */
  subscribable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface McpFnManifestResourceTemplate
  extends Omit<ResourceTemplate, "_meta"> {
  /** Whether resources matched by this template accept resources/subscribe requests. */
  subscribable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface McpFnManifestPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  argumentsSchema?: McpFnObjectSchema;
  icons?: Icon[];
  metadata?: Record<string, unknown>;
}

export interface McpFnManifest {
  formatVersion: 1;
  server: {
    name: string;
    version: string;
    instructions?: string;
  };
  protocolVersions?: string[];
  transports?: Array<"stdio" | "streamable-http">;
  capabilities?: ServerCapabilities;
  clientRequirements?: {
    sampling?: boolean;
    elicitation?: Array<"form" | "url">;
    roots?: boolean;
  };
  extensions?: Record<string, unknown>;
  tools: McpFnManifestTool[];
  resources?: McpFnManifestResource[];
  resourceTemplates?: McpFnManifestResourceTemplate[];
  prompts?: McpFnManifestPrompt[];
  hash: string;
}

export type McpFnChangeSeverity = "breaking" | "additive" | "behavioral";

export interface McpFnContractChange {
  severity: McpFnChangeSeverity;
  code: string;
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

export interface McpFnDiffResult {
  compatible: boolean;
  changes: McpFnContractChange[];
  summary: Record<McpFnChangeSeverity, number>;
}

export type McpFnListedTool = Tool;
export type McpFnListedResource = Resource;
export type McpFnListedResourceTemplate = ResourceTemplate;

/** Self-reported initialization information. It is compatibility input, never identity. */
export interface McpFnReportedClient {
  info?: Implementation;
  capabilities?: ClientCapabilities;
}

export type McpFnSamplingParams = CreateMessageRequest["params"];
export type McpFnSamplingResult =
  | CreateMessageResult
  | CreateMessageResultWithTools;
export type McpFnElicitationParams =
  | ElicitRequestFormParams
  | ElicitRequestURLParams;
export type McpFnElicitationResult = ElicitResult;
export type McpFnRootsResult = ListRootsResult;
export type McpFnClientRequestOptions = RequestOptions;
