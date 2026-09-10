# McpFn adoption inventory

This inventory separates the shared platform release from consumer migrations.

| Surface | Current owner | MCP-2 state | Migration boundary |
| --- | --- | --- | --- |
| Server declaration/runtime | `@mcpfn/core` | Shared registry, manifest, and official-SDK runtime available | Consumers may adopt one server at a time without changing public contracts |
| Production client/session | `@mcpfn/client` | stdio, Streamable HTTP, OAuth callback completion, capabilities, tasks, and diagnostics available | Replace private clients only with consumer-specific regression evidence |
| OAuth compatibility | `@mcpfn/auth` | Client, resource-server, generic provider, and hosted composition seams available | Existing identity, consent, signing, token, and provider-link systems remain authoritative |
| Test/quality platform | `@mcpfn/testing` | Local/external targets, scenarios, auth matrices, host-shaped fixtures, and conformance available | Each consumer supplies domain assertions and credentials through adapters |
| Inspection | `@mcpfn/inspector` and `@mcpfn/cli` | Headless snapshot, execution, timeline, scenario export, and discovery diagnostics available | Product UI is a separate consumer of the headless package |
| DataFn projection | `@mcpfn/datafn` | Existing deny-by-default adapter retained | Explicit domain tools remain preferred for product workflows |

For the first release, `@mcpfn/datafn` is the named in-repository parity
consumer. Its focused suite and the external installed-tarball round trip are
mandatory release-gate steps. The adapter calls only its configured DataFn
executor for reads and writes and has no alternate HTTP/fallback writer. The
calculator is the named generic client/server smoke.

The `dev` base used for MCP-2 does not contain the LangFn, MemoryFn, or ProbeFn
consumer packages. Their implementations on other development lines were used
only to understand required lifecycle behavior; MCP-2 does not copy, modify, or
claim validation for them. Each later migration must pin its public tool and
authorization contract, adopt the shared client/server surface, and add its own
scenario and deployment evidence.

Downstream Skillplane work consumes published McpFn packages after the guarded
release sequence. This repository gate proves the shared packages, examples,
packed external installation, and protocol fixtures; it does not prove a
downstream deployment or hosted OAuth registration.

## Third-party server adoption

A server does not need to adopt the McpFn runtime to consume the quality
platform. Pin released `@mcpfn/testing` and `@mcpfn/cli` versions, describe the
remote URL, provide credentials through an application-owned provider or named
environment variable, and run semantic scenarios plus the official conformance
lane. The SDK-only external example is the compatibility boundary: it imports
no McpFn server package.

Package upgrades are explicit. Update the testing and CLI pins together, review
artifact schema or exit-code changes, run the remote regression suite, and only
then advance the consumer lockfile. A failed upgrade can be rolled back by
restoring the previous pins without changing the external MCP server.
