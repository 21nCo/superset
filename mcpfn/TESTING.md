# Testing and CI

A regression-free MCP project needs six independent layers.

Scenario arrays remain readable for compatibility, while new portable bundles
use the version 1 `mcpfn.scenarios` artifact. Every scenario can declare a
timeout, side-effect class, required variable names, or an explicit incomplete
state. Reports and inspector timelines apply aggregate bounds and record
truncation rather than silently dropping evidence. See `TEST_VECTORS.md` for
the maintained compatibility matrix.

| Layer | What it catches | McpFn surface |
| --- | --- | --- |
| Unit/domain | Handler logic, authorization, persistence, policy | Existing package tests |
| Contract | Tools, resources, prompts, tasks, extensions, host requirements | Hashed manifest plus `mcpfn diff` |
| Deterministic profile compatibility | Authenticated effective catalogs, schema portability, projection/enrichment symmetry, trusted fixtures, diagnostic fidelity | `runMcpFnClientProfileContracts` plus `mcpfn test-profiles` |
| Semantic protocol | Real client/server calls and stable business envelopes | `@mcpfn/testing` scenarios |
| Authentication | API keys, OAuth challenges, scopes, audience, expiry, revocation, PKCE, refresh, and client metadata | `@mcpfn/testing/auth` and `@mcpfn/testing/playwright` |
| Protocol conformance | Initialization, JSON-RPC, transport, and MCP specification behavior | Official `@modelcontextprotocol/conformance` via `mcpfn conformance` |

## Contract baseline

Generate a candidate manifest from a module whose default export is a `McpFnServer`, an async factory returning one, a `McpFnRegistry`, or an existing manifest:

```sh
mcpfn manifest ./mcp-server.ts --output ./candidate.manifest.json
mcpfn diff ./mcpfn.manifest.json ./candidate.manifest.json --fail-on-behavioral
```

For a registry export, pass both `--name` and `--version`. Exit code `1` means the diff found a breaking change, or a behavioral change when requested. Exit code `2` means the source or command was invalid.

Review additive changes before replacing the committed baseline. A compatible diff means old inputs remain structurally accepted; it does not prove the new tool is authorized or semantically correct.

## Deterministic client profiles

Client-profile contracts exercise the catalog and calls through the production
`@mcpfn/client` target/session engine. Configure at least one generic case and
each authenticated profile that the consumer supports. Every case gets an
independent target connection so one authentication, listing, call, or close
failure does not abort later profiles.

The suite hashes the complete effective `tools/list` response, records
value-free per-tool hashes, validates input and output schemas using their
declared draft-07, 2019-09, or 2020-12 dialect, and executes only explicit
fixtures. Fixtures classified `idempotent` or `non-idempotent` remain
incomplete unless `allowSideEffects` is explicitly enabled. Captured
production-failure fixtures use the same call path and are never serialized
with their argument values.

```ts
import {
  createMcpFnClientProfileSnapshot,
  runMcpFnClientProfileContracts,
} from "@mcpfn/testing";

const report = await runMcpFnClientProfileContracts({
  profiles: [{
    id: "consumer/trusted",
    version: "1",
    target: authenticatedTarget,
    expectedSnapshot: reviewedSnapshot,
    fixtures: [{
      name: "minimal lookup",
      tool: "lookup",
      arguments: { query: "example" },
      sideEffect: "read-only",
      source: "minimal-valid",
    }],
  }],
});
```

Snapshot changes are explicit review artifacts. `diffMcpFnClientProfileSnapshots`
classifies added, removed, and modified advertised tools; removed tools are
incompatible and modified tools can be made CI-failing with
`mcpfn diff-profiles --fail-on-behavioral`. Portability warnings are
policy-configurable, while invalid dialects and unresolved schemas always fail.

## Semantic scenarios

```ts
import type { McpFnScenario } from "@mcpfn/testing";

export default [
  {
    name: "resolves the published version",
    tool: "skill_get",
    arguments: { slug: "work-linear-issue" },
    expect: {
      isError: false,
      structuredContent: {
        skill: { slug: "work-linear-issue", version: 3 },
      },
      structuredTextParity: true,
    },
  },
] satisfies McpFnScenario[];
```

`mcpfn test` connects the production McpFn client and server with the official
in-memory transport. `mcpfn test-target` runs the same scenarios against stdio
or Streamable HTTP. Both check or exercise the real capability boundary.
`McpFnTestClient` also exposes resources, prompts, completions, subscriptions,
and experimental task APIs; its `configure` hook installs client-side roots,
sampling, elicitation, and notification handlers before initialization.

`structuredTextParity` is appropriate only when the text block is JSON representing the same object as `structuredContent`. Human-readable text such as MemoryFn's search summary should be asserted separately.

`McpFnInspector.exportScenario()` uses this same contract. Its sanitized output
can be passed directly to `runScenarios()` or saved in a scenario module for
`mcpfn test`; the CLI validates tool, resource, prompt, inventory, and
initialization shapes before execution.

For tools with a declared success `outputSchema`, assert error codes by parsing the JSON text block: McpFn intentionally omits structured error content so it cannot be rejected against the success schema.

## Authentication

`assertAuthRegressionSuite()` runs the transport-level API-key or OAuth matrix against a caller-provided protected operation. The thin provider adapter maps credential issuance and revocation to the application's existing test support. OAuth runs can enable scope, expiry, resource binding, and revocation capabilities; resource-binding coverage rejects both missing and incorrect resource indicators, and every rejected OAuth request is checked for a protected-resource `WWW-Authenticate` challenge.

The `@mcpfn/testing/playwright` subpath exports a Playwright `test` extended with `mcpfnOAuth`. Its local server supports authorization-code + PKCE, consent approval and denial, callback capture, one-time codes, refresh rotation, revocation, discovery, client metadata variants, and access-token verification. The extension-grant variants verify that an authorization server accepts a compatible authorization-code client even when its metadata advertises additional JWT-bearer, device-code, or custom grants. Actual unsupported token requests must still return `unsupported_grant_type`.

Keep application-specific UI selectors, real-provider secrets, workspace authorization, and least-privilege assertions in the application repository. McpFn owns the reusable protocol and credential-lifecycle mechanics.

## Proof levels

| Level | What it proves | What it does not prove |
| --- | --- | --- |
| Workspace | Source, focused tests, profile contracts, and builds pass in this checkout. | Packed-package resolution or any live environment. |
| Installed | Packed tarballs install and execute in a clean consumer. | Registry publication or live-provider behavior. |
| Published | A named registry version resolves and executes. | A particular deployment or host authorization. |
| Controlled live | A controlled endpoint completes protocol and OAuth checks. | Production deployment, production data, or end-user host acceptance. |
| Deployed | The named production revision and configuration are running. | External host acceptance unless that host is tested separately. |

Each release claim must name its highest verified level. Evidence at one level never implies a later level.

## Official conformance

Start a real Streamable HTTP endpoint, then run:

```sh
mcpfn conformance http://127.0.0.1:3000/mcp --suite active
```

McpFn delegates to the pinned official conformance npm package and returns its exit code. The current pinned runner requires Node.js 22 or newer. Use an expected-failures file only for reviewed, time-bounded exceptions; do not turn new failures into a silent baseline update.

## Superfunctions release gate

```sh
npm run gate:mcpfn-release
```

The gate typechecks, tests, and builds all seven McpFn packages; runs real stdio
and Streamable HTTP round trips, OAuth boundary tests, a real Chromium PKCE
flow, and the official active conformance suite; runs the complete DataFn
server suite; exercises the real CLI; checks package contents; and installs
packed artifacts into a temporary external consumer for ESM and CommonJS
imports. LangFn, MemoryFn, and ProbeFn are not covered by this release gate.

CI routes a change set made entirely of the McpFn runtime, its DataFn adapter, README, and release metadata through this dedicated Node.js 22 gate. Root package manifests, lockfiles, CI workflows, and the CI planner always run the repository's generic JavaScript job as well as the McpFn gate. This conservative boundary prevents unrelated global changes from gaining coverage merely by being included with McpFn work.

When publishing manually, release the required `@superfunctions/oauth-*`
versions, then `@mcpfn/core`, `@mcpfn/client`, and `@mcpfn/auth`, followed by
`@mcpfn/testing`, `@mcpfn/inspector`, `@mcpfn/datafn`, and `@mcpfn/cli`. The
repository's package release workflow publishes one selected package at a time;
it does not infer dependency order.
