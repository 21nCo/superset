# ADR 0001: McpFn runtime and compatibility policy

- Status: accepted
- Date: 2026-08-26
- Scope: pre-1.0 McpFn packages and quality artifacts

## Decision

All seven McpFn packages support Node.js 18.18 or newer. The guarded release
and official conformance environment is Node.js 22. Top-level package entries
are Node runtimes: stdio, cryptography, module loading, and local fixture tools
are not advertised as browser or edge bundles. Desktop and native products may
consume a remote Streamable HTTP target or run the Node client in a managed
subprocess. No browser-specific export condition is provided in this release.

The official MCP SDK is the only protocol, JSON-RPC, initialization, and
transport implementation. McpFn adds application declarations, lifecycle
ownership, OAuth compatibility policy, testing, artifacts, and inspection.

## Public format policy

Manifests, scenario artifacts, scenario reports, target-suite reports, and
client events use integer `formatVersion: 1`. Inspector snapshots use
`formatVersion: 2`; version 2 removes the version 1 `state` field and replaces
it with the unambiguous `clientState` field. Snapshot readers must reject the
unknown major version until they migrate to `clientState`; no dual-field
compatibility representation is emitted. Additive optional fields are
compatible within a major format version, while removing or changing field
meaning requires the next version. Individual legacy scenario arrays remain
readable during the 0.x migration, but exporters write version 1 records or
artifacts.

Diagnostic event phase/outcome/code values and client event kinds are stable
machine-readable identifiers. New identifiers and optional fields are
additive. Renaming or removing an identifier requires a package minor release,
a migration note, and a compatibility test during 0.x.

Encrypted OAuth records are written in a version 1 envelope. Readers accept
the earlier unenveloped encrypted JSON representation, then rewrite it in the
version 1 envelope on the next save. Memory stores are process-local and need
no persistence migration. Inspector exports use secret variable references;
raw credential values are never an artifact feature.

Target-suite JSON and JUnit reports also carry a semantic report-schema version,
the producing `@mcpfn/testing` package version, and the Node runtime version.
Failure-layer identifiers are additive within report schema 1.x. A meaning
change, removal, or incompatible shape requires a report-schema major version
and a testing-package minor release during 0.x.

## Optional AuthFn integration

The provider adapter is structurally typed in `@mcpfn/auth`. AuthFn is an
optional peer and development dependency, not a runtime dependency of the base
package. Identity, login, consent, signing, durable client/code/token state,
and business authorization stay in the provider. McpFn owns MCP discovery,
registration normalization, redirect/state/resource/PKCE policy, token request
parsing, client method negotiation, refresh serialization, revocation routing,
and OAuth error envelopes.

## Shared primitives and single writers

PKCE generation and derivation, state generation, credential redaction, and
encrypted storage interfaces come from shared Superfunctions OAuth packages.
McpFn-specific code is limited to MCP discovery and interoperability policy.

`@mcpfn/datafn` is the named in-repository downstream consumer for the first
release. Its registry is the only MCP projection and its configured DataFn
executor is the only query/mutation writer; there is no HTTP or alternate
fallback. The calculator example is the named generic client/server smoke.
LangFn and Skillplane are not present on this base and require their own later
parity and deployment evidence before migration.

## Evidence boundaries

The release gate proves the checked-out workspace, temporary tarballs, an
external installed consumer, deterministic provider-shaped fixtures, and the
pinned official conformance runner. It does not prove npm registry publication,
provider-controlled configuration, a downstream branch, or production
deployment. Those claims require separately recorded evidence for the exact
published version or deployed revision.

The official conformance dependency is an exact reviewed pin. Its upgrades use
a dedicated change and the complete Node 22 release gate; new results are
reviewed rather than silently absorbed into expected failures. Consumers pin
`@mcpfn/testing` and `@mcpfn/cli` and may restore their previous pins as the
rollback boundary.
