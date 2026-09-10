# McpFn deterministic test vectors

These matrices define the maintained compatibility fixtures. Each vector is
implemented by the auth, client, testing, inspector, CLI, or release-gate test
suites. Named host data is synthetic and contains no provider credential.

## Redirect and registration vectors

| Vector | Expected result |
| --- | --- |
| Exact public HTTPS callback | accepted |
| Scheme, host, path, or query drift | rejected before user-agent launch |
| Fixed loopback port drift | rejected |
| IPv4 loopback with registration omitting the port | dynamic port accepted |
| IPv6 loopback with registration omitting the port | dynamic port accepted |
| `localhost` dynamic port without explicit policy | rejected |
| `localhost` dynamic port with explicit policy | accepted |
| Native private-use URI without explicit policy | rejected |
| Native private-use URI with explicit policy | exact match accepted |
| Multiple registered redirects | only the exact selected entry is accepted |
| DCR or Client ID Metadata Document callback drift | rejected by normalized registration |
| External metadata redirect to a disallowed host | rejected before the next fetch |
| Slow or oversized external metadata | aborted or rejected within configured bounds |

## Authorization and token vectors

| Vector | Expected result |
| --- | --- |
| Missing, mismatched, or replayed state | callback rejected |
| Missing PKCE challenge or non-S256 method | authorization rejected |
| Reused or expired authorization code | token authority rejects `invalid_grant` |
| Resource missing when required | `invalid_target` |
| Resource outside the allowlist | `invalid_target` |
| Unsupported scope | `invalid_scope` |
| Unsupported grant | `unsupported_grant_type` |
| `none`, Basic, and POST client method negotiation | only declared and registered methods accepted |
| Concurrent refresh for one credential | serialized |
| Refresh without configured rotation | server error unless rotation policy is disabled |
| Revoked or expired access credential | resource server returns a Bearer challenge |
| Remote revocation unavailable | diagnosed failure; local credentials retained |
| Successful exchange | pending state and verifier removed |

## Protocol and artifact vectors

| Vector | Expected result |
| --- | --- |
| Roots, sampling, and form elicitation | advertised from typed client handlers and callable by the server |
| Logging, progress, task status, resource updates, list changes, subscriptions | redacted client events |
| Tool, inventory, resource, prompt, task, event, and auth scenarios | validated format version 1 records |
| Per-scenario timeout | cancellation signal plus deterministic failed result |
| Explicit incomplete scenario | incomplete result without execution |
| Oversized report or inspector timeline | bounded truncation with completeness metadata |
| Inspector-exported tool/resource/prompt operation | executable by the shared runner |
| Target open or authorization runtime failure | CLI exit 1 |
| Invalid CLI usage or configuration | CLI exit 2 |

## Named provider-shaped fixtures

The ChatGPT fixture uses a pre-registered client identifier and the configured
ChatGPT connector callback shape. The Claude fixture uses an HTTPS URL-based
client identifier and an independently supplied Claude callback shape. Each
test performs authorization request, state, PKCE, code exchange, protected MCP
initialization, a tool call, and revocation through the production client.

Fixture changes require a source note in the change description, review by an
McpFn owner, and a full release-gate run. Provider-controlled production URLs
are verified only in a separately authorized controlled-live lane; synthetic
fixtures are reviewed on every MCP SDK upgrade and at least once per quarter.

## Authenticated client-profile vectors

| Vector | Expected result |
| --- | --- |
| No verified identity or no matching profile | canonical generic catalog and arguments |
| Self-reported client name without matching verified identity | no trusted profile selection |
| Visibility-hidden tool with a profile transform | absent from both list and call |
| Profile removes canonical required field and declares trusted enrichment | field absent from catalog and restored before canonical validation |
| Required field removed without enrichment declaration | catalog projection rejected as asymmetric |
| Model supplies a declared server-owned field | rejected before handler as forged metadata |
| Trusted enricher omits a declared server-owned field | missing-context failure before handler |
| Projector invents or duplicates a tool | catalog projection rejected |
| Unknown root argument reaches strict validation | exact property, instance path, schema path, and keyword retained; value omitted |
| Handler throws a validation-shaped domain error | lifecycle remains `handler`, not `input-validation` |
| draft-07 schema with `definitions` and local `$ref` | compiled with draft-07 |
| 2020-12 schema with `$defs`, composition, arrays, or local `$ref` | recursively compiled with 2020-12 |
| Unsupported dialect or unresolved reference | portability error |
| Reviewed portability-sensitive keyword | warning, or error when policy requires |
| Stale effective-catalog snapshot | profile contract fails |
| Captured failure fixture | production list/call path used; arguments absent from report |
| Mutating fixture without explicit suite opt-in | not executed; report marked incomplete |
| One profile target fails to open | failed profile receipt; remaining profiles still execute |
| Oversized compatibility receipt | bounded truncation with explicit incomplete status |
