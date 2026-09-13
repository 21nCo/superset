# McpFn Core

`defineMcpFnServer()` creates a side-effect-free declaration whose registry and
manifest are shared by runtime, tests, and release tooling. Call
`declaration.createServer()` once per transport connection. Existing
`createMcpFnServer()` usage remains supported.

Declare protocol capabilities on `defineMcpFnServer()`. Per-connection runtime
options provide context, visibility, task storage, and transport behavior but
cannot add capabilities, so `declaration.manifest()` and every runtime manifest
remain byte-for-byte identical. When combining a supplied registry with inline
definitions, the declaration clones the registry before adding them.

`@mcpfn/core` is the shared MCP runtime for Superfunctions. It delegates wire protocol and transport behavior to the official Model Context Protocol SDK while providing the pieces product code needs to remain stable:

- an explicit, validated tool, resource, template, and prompt registry;
- authenticated, versioned client-profile catalog projection and trusted enrichment;
- actionable, value-free JSON Schema diagnostics;
- pagination, completions, subscriptions, and task-capable tools;
- server-initiated roots, sampling, elicitation, logging, and list-change notifications;
- MCP Apps resource and tool-link contracts;
- consistent structured and text results;
- deterministic, hashed manifests;
- breaking, additive, and model-behavior compatibility classification;
- stdio, Web Standard Streamable HTTP, and in-memory transport support through the official SDK.

```ts
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "@mcpfn/core";

const registry = new McpFnRegistry()
  .register({
    name: "greet",
    description: "Greet one person by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ name }) =>
      structuredResult({ greeting: `Hello, ${String(name)}!` }),
  });

const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  transports: ["stdio", "streamable-http"],
});

await server.serveStdio();
```

Tool definitions are public contracts. Do not derive tool names, descriptions, or exposed fields from storage schemas without an explicit exposure manifest.

## Server context and errors

Build trusted context once at the server boundary:

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry: new McpFnRegistry<{ workspaceId: string }>(),
  context: async (extra) => ({
    workspaceId: await authenticateRequest(extra.requestInfo),
  }),
});
```

For tenant- or actor-specific discovery, use `toolVisibility`. McpFn applies
the hook to both `tools/list` and `tools/call`; a hidden call returns the same
protocol `MethodNotFound` response as an unknown tool. The static manifest
continues to describe the complete server contract.

```ts
const server = createMcpFnServer({
  info: { name: "admin", version: "1.0.0" },
  registry,
  context: (extra) => resolvePrincipal(extra.authInfo),
  toolVisibility: ({ tool, context }) =>
    context.permissions.includes(String(tool._meta?.permission)),
});
```

Do not accept workspace, tenant, actor, or credential identifiers as tool arguments. The context factory receives the official SDK request metadata and runs before every tool call.

Invalid input returns `MCPFN_INVALID_ARGUMENTS`; invalid declared output returns
`MCPFN_INVALID_OUTPUT`; other handler failures return `MCPFN_TOOL_ERROR`.
Error objects that already expose a string `code` keep it. Schema issues retain
`instancePath`, `schemaPath`, `keyword`, and safe keyword-specific names
such as `rejectedProperty` and `missingProperty`; rejected values are never
included. `handleInvalidArguments` is available for existing domain packages
that must map schema failures into a stable legacy envelope.

When a tool declares a success `outputSchema`, error details remain in its JSON text content and `structuredContent` is omitted so the official SDK does not validate an error envelope against the success schema. Tools without an output schema retain both structured and text error envelopes.

One `McpFnServer` instance connects to one transport. Create a new instance per concurrent connection and share the registry.

## Authenticated client profiles

Use `clientProfiles` only when an authenticated client needs a projected
catalog and server-owned required arguments. Profile matching receives a
`McpFnVerifiedClientIdentity` produced from trusted context; reported client
name/version and capabilities are available to hooks separately and cannot
select the profile.

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  context: (extra) => authenticateRequest(extra.authInfo),
  clientProfiles: {
    resolveVerifiedIdentity: ({ context }) => ({
      subject: context.authenticatedClientId,
    }),
    profiles: [{
      id: "consumer/trusted",
      version: "1",
      matches: ({ subject }) => subject === "trusted-client-id",
      serverOwnedArguments: { lookup: ["workspaceId"] },
      projectCatalog: ({ tools }) => tools.map((tool) => {
        if (tool.name !== "lookup") return tool;
        const { workspaceId: _hidden, ...properties } =
          tool.inputSchema.properties ?? {};
        return {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties,
            required: tool.inputSchema.required?.filter(
              (name) => name !== "workspaceId",
            ),
          },
        };
      }),
      enrichArguments: ({ arguments: args, context }) => ({
        ...args,
        workspaceId: context.workspaceId,
      }),
    }],
  },
});
```

McpFn applies canonical visibility before projection, checks calls against the
same effective catalog, rejects model-supplied server-owned fields, enriches
from trusted context, and only then invokes canonical Ajv validation. Declared
server-owned fields must be canonical required properties, must be absent from
the projected schema, and must be supplied by the enricher. A profile cannot
invent or duplicate tools or mutate model-owned arguments. No matching profile
preserves canonical behavior.

The optional `evidence` sink receives only bounded structural lifecycle
events. It is observational: a sink failure cannot fail or change a request.

## Resources, prompts, and client features

Use `registerResource`, `registerResourceTemplate`, and `registerPrompt` on the same registry. Resource-template and prompt completers advertise the completions capability automatically. Resource subscription handlers advertise `resources.subscribe`. List calls use stable `mcpfn:<offset>` cursors and a configurable server page size.

Task support is declared with `execution.taskSupport` and a `taskHandler`; a task-capable server must receive an official SDK `TaskStore`. `server.listRoots()`, `server.sample()`, and `server.elicit()` invoke matching client capabilities. Declare required client features in `clientRequirements` so manifests and host-profile tests can reject incompatible hosts before deployment.

`createWebStandardHandler()` accepts the official SDK `HandleRequestOptions`, including validated `authInfo`. Use `@mcpfn/auth` to publish OAuth protected-resource metadata and produce that trusted value. In stateless mode, McpFn creates and disposes an isolated SDK server and transport for every request. Attach protocol instrumentation with `configureRequestServer`; it receives the live isolated server before transport connection and runs once per request, or once per session initialization attempt. Because configuration precedes SDK request validation, a rejected attempt can invoke the hook without retaining a session. Supply a cryptographically secure `sessionIdGenerator` when the server uses sampling, elicitation, or another server-to-client request that must be correlated across HTTP requests; session-enabled handlers retain their transport across the session.

See the [architecture](https://github.com/21nCo/super-functions/blob/main/mcpfn/ARCHITECTURE.md), [testing guide](https://github.com/21nCo/super-functions/blob/main/mcpfn/TESTING.md), and runnable [calculator example](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator-server.ts).

Profile hooks that consume initialization metadata require a sessionful HTTP
handler (`sessionIdGenerator`). Stateless handlers accept only profiles explicitly
marked `requiresReportedClient: false`; their hooks must depend solely on verified
identity and request context. Model-owned property schemas retain their canonical
types and constraints. Projection may hide server-owned required fields, but does
not replace the canonical validator.

Structural diagnostics retain exact unknown property names and instance paths;
consumer report sinks must apply an aggregate size cap (the testing suite defaults
to one MiB) rather than silently shortening property names.
