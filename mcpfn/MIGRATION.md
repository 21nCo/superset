# Migrating an MCP server to McpFn

## 1. Remove hand-written protocol dispatch

Keep domain handlers and schemas, but replace custom initialize, tools, resources, prompts, tasks, ping, stdio framing, and Streamable HTTP parsing with an `McpFnRegistry` and `McpFnServer`. The official SDK owns those protocol paths.

## 2. Register the existing public contract

Preserve tool names and descriptions unless the change is intentional. Use object JSON Schemas, declare `additionalProperties`, add accurate annotations, and add output schemas wherever consumers rely on structured results.

Handlers should return MCP `CallToolResult` values. `structuredResult` emits both `structuredContent` and an equivalent JSON text block. Existing domain errors with a string `code` retain that code. Use `handleInvalidArguments` only when a package has an established validation envelope that must remain stable.

## 3. Build trusted context

Use `createMcpFnServer({ context })` to derive principals, workspace/tenant IDs, credentials, and request metadata from authenticated transport state. Never copy these values out of tool arguments.

## 4. Adopt the shared production client

Replace private stdio/HTTP clients with `McpFnClient` targets. Use
`McpFnTestClient` for local fixtures and `runMcpFnTargetSuite` for external
targets; both route through the same production session. Assert the real
initialize and capability boundary, not `registry.callTool` or handler
functions alone.

## 5. Commit the regression contract

Generate a manifest, review it, add semantic scenarios, and run official conformance for the deployed Streamable HTTP endpoint. Put manifest diff and scenarios in required CI.

## 6. Add HTTP authorization deliberately

Wrap the Web Standard handler with `@mcpfn/auth` when the endpoint is protected.
Supply an SDK-compatible token verifier, resource identifier,
authorization-server URLs, and required scopes. Client applications use
`McpFnOAuthClientProvider`, explicitly receive both callback `code` and `state`,
and choose memory-only or encrypted persistence. Hosted authorization servers
compose their existing identity and token systems through the compatibility
handler. Do not move outbound provider OAuth flows out of
`@superfunctions/oauth-*`; MCP resource-server verification and provider
account linking are separate boundaries.

## 7. Declare host requirements

Set `clientRequirements` for roots, sampling, or elicitation used by handlers. Add extension declarations for MCP Apps, then check the manifest against the intended host profile in CI. This turns a host capability mismatch into a pre-release failure instead of a runtime surprise.

## Existing Superfunctions migrations

LangFn, MemoryFn, and ProbeFn migrations are outside this release. Their existing
MCP compatibility surfaces remain unchanged until each consumer is migrated and
its own regression suite is added to the release gate.

Run `npm run gate:mcpfn-release` after changes to the shared McpFn runtime or its
current DataFn adapter. Do not treat that gate as evidence for unmigrated consumers.

## Testing an existing non-McpFn server

Runtime migration is optional for regression adoption. Pin released
`@mcpfn/testing` and `@mcpfn/cli`, point `mcpfn test-target` at the existing
Streamable HTTP URL, and supply a bearer token or API key through a named
environment variable. Add the official conformance command for a protected
loopback test deployment and retain the bounded JSON/JUnit artifacts. This path
does not introduce a second server, registry, OAuth state store, or token
authority.
