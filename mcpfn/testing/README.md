# McpFn Testing

`@mcpfn/testing` provides deterministic MCP regression testing over the official SDK's in-memory transport and against arbitrary stdio or Streamable HTTP MCP servers. It tests the protocol boundary rather than calling handlers directly; the server under test does not need to use McpFn.

It includes:

- the production McpFn client exposed as a fixture;
- exact manifest assertions across tools, resources, templates, and prompts;
- resource, prompt, completion, subscription, and task client methods;
- reusable API-key and OAuth resource-server regression matrices;
- an in-memory authorization-code, PKCE, refresh, and revocation server;
- extensible Client ID Metadata fixtures that include unrelated grant types;
- optional Playwright fixtures for real redirect and consent-page coverage;
- generic tools-only, full-protocol, and MCP Apps host profiles;
- named ChatGPT- and Claude-shaped OAuth metadata fixtures;
- one suite for in-memory, custom, stdio, and Streamable HTTP targets;
- structured/text response parity checks;
- version 1 declarative scenarios for capabilities, tasks, events, and auth phases;
- per-scenario timeout/cancellation, side-effect and incomplete metadata;
- bounded, redacted scenario and target-suite reports;
- JSON and JUnit artifacts with package/runtime provenance and failure layers;
- orchestration of the official `@modelcontextprotocol/conformance` runner.

Official conformance validates protocol behavior. McpFn scenarios validate product behavior. Production MCP servers should run both. For a protected local endpoint, use `runAuthenticatedOfficialConformance({ url, credential })`; it requires a literal loopback upstream, binds a temporary loopback-only streaming proxy, pins every request to the configured upstream path, injects bounded credential headers without printing them, and always revokes/disposes the credential and closes the proxy after the pinned official runner exits.

Use `runMcpFnTargetSuite({ target, scenarios, manifest })` when a test should
exercise a subprocess or deployed target. It constructs the same session used
by applications, the inspector, and CLI. Scenario execution is serial and
capability calls are never retried implicitly.

```ts
import {
  McpFnTestClient,
  assertManifestContract,
  runScenarios,
} from "@mcpfn/testing";

const server = createServer();
const client = await McpFnTestClient.connect(server);
try {
  await assertManifestContract(client, server.manifest());
  const results = await runScenarios(client, [
    {
      name: "returns one skill",
      tool: "skill_get",
      arguments: { slug: "work-linear-issue" },
      expect: { isError: false, structuredTextParity: true },
    },
  ]);
  if (results.some((result) => result.status === "failed")) {
    throw new Error(JSON.stringify(results));
  }
} finally {
  await client.close();
}
```

## External authenticated targets

`authenticatedHttpTarget()` accepts a URL plus either a static credential or an
application-owned provider. The provider is responsible for acquiring the
credential and may revoke and dispose it. McpFn applies the headers only to the
fixed target, refuses redirect following, excludes credentials from target
descriptors and reports, and releases the credential exactly once even when
initialization fails.

```ts
import {
  authenticatedHttpTarget,
  createMcpFnTargetSuiteJUnit,
  runMcpFnTargetSuite,
} from "@mcpfn/testing";

const report = await runMcpFnTargetSuite({
  target: authenticatedHttpTarget("https://mcp.example.com/mcp", {
    credential: {
      kind: "api-key",
      headers: { "x-api-key": process.env.MCP_API_KEY! },
    },
  }),
  scenarios,
});

await writeArtifact("mcpfn-report.xml", createMcpFnTargetSuiteJUnit(report));
```

Use a provider instead of a static credential for short-lived OAuth access
tokens. Report failures identify `mcpfn-preflight`, `authorization-server`,
`resource-server`, `mcp-initialization`, `scenario`, or
`upstream-conformance` without serializing secret material.

Scenarios run serially so stateful workflows and idempotency checks remain
deterministic. Legacy arrays are readable; portable artifacts use
`{ formatVersion: 1, kind: "mcpfn.scenarios", status, scenarios }`. A runner
rejects an artifact whose top-level status is `incomplete`, even when its
individual scenarios are complete, so incomplete evidence cannot produce a
passing report. A runner
timeout supplies an abort signal and also bounds adapters that do not cooperate
with cancellation. `assertStructuredTextParity` requires a JSON text block; do
not use it for intentionally human-readable text.

`checkHostCompatibility(manifest, profile)` returns `compatible`, `degraded`, or `incompatible`. Unsupported optional server surfaces are degraded; missing protocol overlap or required client-mediated features are incompatible. The built-in profiles are stable capability fixtures, not claims about the current behavior of named commercial hosts. Supply a custom profile for a captured host version.

## Authentication regression suite

Import the transport-level testkit from `@mcpfn/testing/auth`. The application adapter owns only credential issuance and revocation; McpFn owns the common rejection and lifecycle matrix.

```ts
import {
  apiKeyCredential,
  assertAuthRegressionSuite,
  createFetchAuthTarget,
} from "@mcpfn/testing/auth";

await assertAuthRegressionSuite({
  kind: "api-key",
  target: createFetchAuthTarget({ url: "http://127.0.0.1:8787/mcp" }),
  invalidCredentialHeaders: { "x-api-key": "invalid" },
  provider: {
    capabilities: { revocation: true },
    async issue() {
      const key = await skillplaneTestAuth.issueApiKey();
      return apiKeyCredential(key.value, { headerName: "x-api-key", scheme: "" });
    },
    async revoke(credential) {
      await skillplaneTestAuth.revokeApiKey(credential);
    },
  },
});
```

OAuth adapters can additionally enable scope, expiry, resource-binding, and revocation scenarios. Rejected OAuth requests must include a Bearer challenge with `resource_metadata`; API keys intentionally do not inherit that OAuth-specific requirement.

`createOAuthClientMetadataVariants()` returns authorization-code clients with basic, JWT-bearer-extension, device-code-extension, and generic-extension metadata. The compatibility assertion requires authorization-code support while deliberately accepting unrelated grants, which catches closed-world Client ID Metadata validation regressions.

`createHostedAuthorizationFixtures()` keeps registration metadata independent
from the generated authorization request. The ChatGPT-shaped pre-registration,
Claude-shaped Client ID Metadata Document, and dynamic-registration cases cover
authorization code with S256 PKCE and refresh. Advertised JWT bearer, device,
and custom grants remain compatible when authorization code is supported, while
an actual unsupported token request must return `unsupported_grant_type`.

## Playwright fixture

Install `@playwright/test` and import the ready-to-extend fixture from `@mcpfn/testing/playwright`:

```ts
import { expect, test } from "@mcpfn/testing/playwright";

test("accepts extensible OAuth client metadata", async ({ page, mcpfnOAuth }) => {
  const result = await mcpfnOAuth.authorize(page, {
    authorizationEndpoint: skillplane.authorizationEndpoint,
    clientId: mcpfnOAuth.server.clientMetadataUrl("jwtBearerExtension"),
    redirectUri: mcpfnOAuth.server.callbackUrl,
    scopes: ["mcp:read"],
    beforeDecision: async (currentPage) => signInIfRequired(currentPage),
  });
  expect(result.callback.parameters.code).toBeTruthy();
});
```

The fixture starts a local mock server that publishes authorization-server discovery, consent UI, callback capture, client metadata variants, PKCE token exchange, refresh rotation, revocation, and an SDK-compatible access-token verifier. Extend the exported `test` with Skillplane's signed-in page or database fixtures; do not copy the OAuth machinery into the application.

See [Testing and CI](https://github.com/21nCo/super-functions/blob/main/mcpfn/TESTING.md) for the complete layered strategy.
