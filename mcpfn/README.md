# McpFn

McpFn is the Superfunctions layer for building and keeping Model Context Protocol servers regression-free. It uses the official MCP SDK for protocol and transport behavior, then adds validated tools, resources, prompts, task execution, client-mediated features, OAuth resource-server security, MCP Apps contracts, deterministic manifests, compatibility diffs, semantic scenarios, and a safe DataFn adapter.

## Packages

| Package | Purpose |
| --- | --- |
| `@mcpfn/core` | Official-SDK runtime, tools/resources/prompts/tasks, client-mediated features, MCP Apps contracts, manifests, and compatibility diffing |
| `@mcpfn/client` | Production stdio/Streamable HTTP targets, lifecycle-safe sessions, complete inventories, tasks, OAuth callback completion, and redacted phase diagnostics |
| `@mcpfn/auth` | OAuth client persistence and callback policy, discovery diagnostics, hosted authorization compatibility, RFC 9728 resource protection, and generic auth-provider composition |
| `@mcpfn/testing` | The production client exposed as a fixture, auth regression matrices, named host-shaped OAuth fixtures, local/external target suites, scenarios, Playwright, and conformance orchestration |
| `@mcpfn/inspector` | Headless inventory, capability execution, redacted timelines, and sanitized scenario export over the production client |
| `@mcpfn/datafn` | Deny-by-default generation of bounded MCP tools from a DataFn server executor |
| `@mcpfn/cli` | Contract, local/remote target testing, inspection, authorization discovery diagnostics, and official conformance commands with stable CI exit codes |

All client-side surfaces share `@mcpfn/client`; tests, the inspector, and CLI do
not carry private transport or protocol implementations. McpFn's inspector is
headless so product UIs can compose it without becoming runtime dependencies.

The version-controlled acceptance and compatibility decisions live in
[`REQUIREMENTS.md`](./REQUIREMENTS.md), [`TEST_VECTORS.md`](./TEST_VECTORS.md),
and [`ADR-0001-COMPATIBILITY.md`](./ADR-0001-COMPATIBILITY.md).

## Quick start

```ts
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "@mcpfn/core";

// Replace this example with your application's published-skill lookup.
const resolvePublishedSkill = async (slug: string) => ({ slug });

const registry = new McpFnRegistry().register({
  name: "skill_get",
  description: "Resolve one published skill by slug.",
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string", minLength: 1 } },
    required: ["slug"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { skill: { type: "object" } },
    required: ["skill"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ slug }) =>
    structuredResult({ skill: await resolvePublishedSkill(String(slug)) }),
});

const server = createMcpFnServer({
  info: { name: "skillplane", version: "1.0.0" },
  registry,
  transports: ["stdio", "streamable-http"],
});

await server.serveStdio();
```

The handler receives only schema-valid arguments. If an output schema is declared, McpFn also validates `structuredContent` before returning it. Domain errors with a string `code` retain that code in the MCP error result.

## Regression workflow

Commit a manifest baseline and semantic scenarios with the MCP server:

```sh
mcpfn manifest ./src/mcp/server.ts --output ./mcpfn.manifest.json
mcpfn validate ./mcpfn.manifest.json
mcpfn diff ./mcpfn.manifest.json ./candidate.manifest.json --fail-on-behavioral
mcpfn test ./src/mcp/server.ts ./tests/mcp.scenarios.ts --output ./mcpfn-report.json
mcpfn test-target https://api.example.com/mcp ./tests/mcp.scenarios.ts --bearer-token-env MCP_TOKEN --junit ./mcpfn-report.xml
mcpfn inspect https://api.example.com/mcp --output ./mcpfn-inspection.json
mcpfn auth-diagnose https://api.example.com/mcp
mcpfn conformance http://127.0.0.1:3000/mcp --suite active --bearer-token-env MCP_TOKEN --report ./mcpfn-conformance.json
```

The manifest catches tool, resource, template, prompt, task, extension, client-requirement, protocol-version, and transport changes. Scenarios catch business behavior. Host profiles expose feature mismatches. The official conformance runner catches wire-protocol behavior. None of those layers substitutes for the others.

The conformance subcommand pins the reviewed official runner version and requires Node.js 22 or newer. Other McpFn commands support Node.js 18.18 or newer.

External targets may be third-party servers built with the official MCP SDK or
another conforming implementation. URL-plus-credential targets reuse the
production client session, acquire and release credentials through an explicit
provider, refuse credential-bearing redirects, and emit bounded redacted JSON
or JUnit evidence. No `McpFnServer` or `McpFnRegistry` is required on the server
side.

Run `npm run gate:mcpfn-release` from this repository for the complete package, example, migration, and packability gate.

The examples include a declaration-backed calculator server, stdio entrypoint,
Streamable HTTP entrypoint, production client, semantic scenarios, and committed
manifest under `mcpfn/examples`.

## Authorization and MCP Apps

Wrap `server.createWebStandardHandler()` with
`createOAuthResourceServerHandler()` from `@mcpfn/auth`. For clients, use
`McpFnOAuthClientProvider`; it delegates discovery, DCR, PKCE, token exchange,
and refresh mechanics to the official SDK, correlates callback state, validates
redirects before browser launch, defaults to memory-only credentials, and
supports encrypted application-provided persistence. Hosted applications can
compose their existing login, consent, signing, and token authority through
`createMcpAuthorizationCompatibilityHandler()` instead of creating a second
identity system. Existing `@superfunctions/oauth-*` packages continue to own
outbound provider connections.

Use `@mcpfn/testing/auth` to run the common missing, invalid, valid, insufficient-scope, expired, wrong-resource, and revoked credential matrix. Use `@mcpfn/testing/playwright` for a real authorization-code + PKCE browser flow, refresh rotation, revocation, callback capture, and extensible Client ID Metadata fixtures. An application such as Skillplane supplies only its API-key/token lifecycle adapter, authorization endpoint, login setup, and product-specific access assertions.

Use `createMcpAppResource()` and `mcpAppToolMetadata()` for `ui://` HTML resources. McpFn validates the MCP App MIME type, CSP metadata, visibility, and tool-to-resource links. It does not implement a browser iframe host.

## DataFn boundary

`@mcpfn/datafn` is useful when a domain operation really is a bounded projection of DataFn query/mutation semantics. A resource must be explicitly named, returned fields are fixed, filter/sort fields are allowlisted, and writes require explicit fields plus a caller-supplied `mutationId`. Authentication, namespace, actor, and `clientId` values come from trusted server context.

Do not auto-publish an entire DataFn schema. Skillplane-style operations such as version resolution, access grants, audit workflows, or asset delivery should remain explicit domain tools even if they call DataFn internally.

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Adoption inventory](./ADOPTION.md)
- [Testing and CI](./TESTING.md)
- [Migration guide](./MIGRATION.md)
- [Core API](./core/README.md)
- [OAuth resource server](./auth/README.md)
- [DataFn adapter](./datafn/README.md)
- [Testing package](./testing/README.md)
- [CLI](./cli/README.md)
