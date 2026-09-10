# McpFn architecture

McpFn separates protocol correctness from product correctness and gives every
client-side tool one session engine.

```text
MCP client
   |
official MCP SDK transports and protocol lifecycle
   |
OAuth resource-server wrapper -> validated authInfo
   |
McpFnServer -> trusted request context and client-mediated requests
   |
McpFnRegistry -> tools/resources/prompts/tasks -> domain handlers
   |                                      |
explicit domain tool                 DatafnExecutor
                                          |
                             DataFn auth, namespace, policy,
                             hooks, rate limits, idempotency

application / CLI / test / inspector
   |
McpFnClient capability facades and lifecycle diagnostics
   |
McpFnTarget: stdio | Streamable HTTP | custom
   |
official MCP SDK client transports and OAuth orchestration
```

## Runtime ownership

The official `@modelcontextprotocol/sdk` owns initialization, JSON-RPC dispatch, stdio framing, Streamable HTTP, capability negotiation, ping, and protocol errors. McpFn does not carry a second MCP protocol implementation.

`McpFnServer` owns server identity, capability derivation, request-context construction, pagination, dispatch, error normalization, client-mediated roots/sampling/elicitation, notifications, and transport connection lifecycle. One `McpFnServer` instance connects to one transport. A host accepting multiple connections creates one server instance per connection while sharing the immutable registry.

`McpFnRegistry` owns the application contract. It registers tools, exact resources, URI-template resources, prompts, completions, subscriptions, and task-capable tool handlers. Ajv validates tool and prompt inputs. URI templates are parsed once at registration. Task-capable tools require an explicit SDK `TaskStore`. MCP App links are validated across the full registry before a server or manifest is created.

`McpFnServerDeclaration` is the side-effect-free application facade. It owns a
registry, identity, transports, extensions, and client requirements; the same
declaration creates manifests and per-connection server runtimes. Existing
`McpFnServer` construction remains supported.

## Client and session ownership

`@mcpfn/client` owns target description, connection state, initialization,
complete inventory pagination, tool/resource/prompt/task facades, explicit
authorization callback completion, explicit reconnection, and bounded redacted
diagnostics. It uses official SDK transports and protocol objects. It may retry
connection establishment when configured; it never replays a caller's tool or
other capability operation.

The testing package wraps this production client for in-memory and external
targets. The inspector records its diagnostics and invokes its facades. The CLI
constructs its stdio or HTTP targets. This one-way dependency rule prevents
test-only, inspector-only, or command-line protocol forks.

An authenticated external target is URL plus credential provider, not a server
implementation contract. The provider acquires bounded headers for one target
open and may revoke and dispose them. The shared target refuses redirect
following, omits headers from descriptors and reports, releases once across
success or failure, and delegates all MCP lifecycle behavior to
`@mcpfn/client`.

Testing failures retain a machine-readable phase and classify the failing layer
as McpFn preflight, authorization server, resource server, MCP initialization,
scenario, or upstream conformance. JSON and JUnit serializers apply redaction
and aggregate bounds after serialization and include the testing package, report
schema, and Node runtime versions.

## Authorization ownership

The official SDK owns RFC discovery, DCR, PKCE construction, token exchange,
refresh, and transport challenge handling. `@mcpfn/auth` supplies secure state
and integration policy:

- exact redirect matching with only the RFC 8252 loopback-port exception;
- callback-state correlation before token exchange;
- memory-only credentials by default or application-supplied encrypted storage;
- redacted, bounded diagnostics and read-only discovery probes;
- protected-resource verification and conversion to trusted SDK `authInfo`;
- hosted metadata, registration, and authorization-request compatibility while
  login, consent, signing, token issuance, and durable identity stay with the
  host application.

Client ID Metadata Document fetching is HTTPS-only, size-bounded, and requires
an application allow-policy before any external URL is fetched. Additional
advertised grant types do not invalidate a client that supports the requested
authorization-code flow.

## Manifest compatibility

`createManifest` emits code-unit-sorted tool, resource, template, and prompt inventories plus a SHA-256 hash over a canonically ordered JSON representation. Object-valued capabilities, client requirements, and extensions retain their supplied insertion order in the returned body; their order does not affect the hash. `diffManifests` classifies changes as:

- `breaking`: removed tools/properties/support, narrowed input enums, widened output enums, tighter input constraints, relaxed output constraints, newly required inputs, required output additions, and any output property added to a previously closed schema;
- `additive`: added tools, optional input properties, optional output properties accepted by a previously open schema, widened input enums, relaxed input constraints, and added protocol/transport support;
- `behavioral`: titles, descriptions, or annotations that can alter model tool selection without changing JSON validity.

The diff is deliberately structural. Semantic scenarios are still required for authorization decisions, version resolution, idempotency, side effects, error envelopes, and result meaning.

## DataFn integration

`DatafnServer.executor` is an in-process boundary over the same query, mutation, transaction, and search handlers used by HTTP. It preserves authorization callbacks, namespace and actor derivation, schema permissions, plugins, rate limits, payload limits, and DataFn error envelopes.

`@mcpfn/datafn` consumes that executor. It never accepts tenant, principal, namespace, or DataFn `clientId` values as tool arguments. Reads default on only after a resource is explicitly exposed; writes never default on.

## Security invariants

- Treat names, descriptions, annotations, schemas, and output shapes as versioned public contracts.
- Build trusted context from the transport/authentication layer, not model-provided arguments.
- Keep `additionalProperties: false` unless unknown keys are an intentional contract.
- Prefer explicit output schemas for stable consumers.
- Mark destructive and read-only annotations accurately; they influence client UX but do not replace server authorization.
- Do not expose DataFn fields that its resolved read/write capabilities reject.
- Require OAuth resource indicators and scopes at the HTTP boundary; never infer identity from model arguments.
- Treat MCP Apps as untrusted HTML and declare the narrowest CSP and permissions.
- Never write authorization codes, states, verifiers, tokens, cookies, or URL
  credentials to diagnostic, inspection, or test artifacts.
