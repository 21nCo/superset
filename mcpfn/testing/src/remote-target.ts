import {
  customTarget,
  streamableHttpTarget,
  type McpFnStreamableHttpTargetOptions,
  type McpFnTarget,
  type McpFnTransportHandle,
} from "@mcpfn/client";

import { redactOAuthValue } from "@superfunctions/oauth-core";

type SecretState = { active: Map<string, number>; scopes: Set<Set<string>> };
const targetSecrets = new WeakMap<McpFnTarget, SecretState>();

/** Retain released credentials only for the lifetime of a report operation. */
export function beginTargetCredentialRedaction(target: McpFnTarget): () => void {
  const state = targetSecrets.get(target);
  if (!state) return () => undefined;
  const scope = new Set(state.active.keys());
  state.scopes.add(scope);
  return () => { state.scopes.delete(scope); scope.clear(); };
}

function credentialValues(headers: HeadersInit): Set<string> {
  // Read raw entries before Headers validation, which may itself fail.
  const values: string[] = [];
  if (headers instanceof Headers) headers.forEach((value) => values.push(value));
  else values.push(...(Array.isArray(headers) ? headers.map((entry) => entry[1]) : Object.values(headers)));
  const secrets = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    secrets.add(raw);
    secrets.add(raw.trim());
    const trimmed = raw.trim();
    const separator = trimmed.search(/\s/);
    if (separator > 0 && ["bearer", "basic"].includes(trimmed.slice(0, separator).toLowerCase())) {
      const token = trimmed.slice(separator).trim();
      if (token) secrets.add(token);
    }
  }
  return secrets;
}

export class McpFnRedactionLimitError extends Error {
  constructor() { super("Credential redaction exceeded its traversal budget"); }
}

// Only these locally authored envelope paths retain structural keys. Unknown
// children (including inspector events and server metadata) are always payloads.
const envelopeKeys: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  root: "formatVersion kind status runtime ok target server capabilities manifestChecked manifestHash total passed failed incomplete droppedResults droppedObservedEvents incompleteReason failure timeline droppedTimelineEvents results count clientState tools resources resourceTemplates prompts droppedEvents timelineComplete droppedInventoryEntries inventoryComplete suiteVersion exitCode stdout stderr phase outcome code requestId at details",
  result: "formatVersion name operation tool status sideEffect durationMs error droppedObservedEvents",
  diagnostic: "phase outcome code requestId at target details",
  inspectorEvent: "formatVersion source kind at event",
  failure: "name message layer code phase details",
  runtime: "node scenarioFormatVersion reportSchemaVersion packages",
  packages: "testing",
  droppedInventoryEntries: "tools resources resourceTemplates prompts",
  target: "kind",
}).map(([role, keys]) => [role, new Set(keys.split(" "))]));

function scrubCredentials<T>(value: T, values: Iterable<string>, preserveKeys = false): T {
  const secrets = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  let entries = 0, stringBytes = 0;
  const budget = (input: unknown, depth = 0): void => {
    if ((Array.isArray(input) && input.length > 100_000) || ++entries > 100_000 || depth > 32) throw new McpFnRedactionLimitError();
    if (typeof input === "string") {
      stringBytes += Buffer.byteLength(input);
      if (input.length > 262_144 || stringBytes > 2_097_152) throw new McpFnRedactionLimitError();
    } else if (input && typeof input === "object") {
      for (const key in input) if (Object.hasOwn(input, key)) {
        budget(key, depth + 1);
        budget((input as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  // Check before either redactor allocates copies. Exceeding a budget is an
  // explicit failure, never silent truncation of a typed report collection.
  budget(value);
  const scrub = (input: unknown, role = "payload", field = ""): unknown => {
    if (typeof input === "string") {
      if ((role === "root" || role === "result") && field === "status" && ["passed", "failed", "incomplete", "complete"].includes(input)) return input;
      if ((role === "root" || role === "diagnostic") && field === "outcome" && ["started", "succeeded", "failed"].includes(input)) return input;
      if (role === "root" && field === "kind" && ["mcpfn.target-suite-report", "mcpfn.inspector-snapshot", "mcpfn.official-conformance-report"].includes(input)) return input;
      if ((role === "root" || role === "diagnostic" || role === "failure") && field === "phase" && ["resource-discovery", "authorization-server-discovery", "client-registration", "authorization-request", "authorization-callback", "token-exchange", "token-refresh", "token-revocation", "transport-connect", "mcp-initialize", "capability-operation", "transport-close"].includes(input)) return input;
      if (role === "failure" && field === "layer" && ["mcpfn-preflight", "authorization-server", "resource-server", "mcp-initialization", "scenario", "upstream-conformance"].includes(input)) return input;
      if (role === "inspectorEvent" && field === "source" && ["diagnostic", "client"].includes(input)) return input;
      if (role === "result" && field === "sideEffect" && ["read-only", "idempotent", "non-idempotent"].includes(input)) return input;
      return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), input);
    }
    if (Array.isArray(input)) return input.map(entry => scrub(entry, role));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
      const fixed = envelopeKeys[role]?.has(key) ?? false;
      let childRole = "payload";
      if (fixed) {
        if (key === "results") childRole = "result";
        else if (key === "timeline") childRole = (value as any)?.kind === "mcpfn.inspector-snapshot" ? "inspectorEvent" : "diagnostic";
        else if (["failure", "runtime", "packages", "droppedInventoryEntries", "target"].includes(key)) childRole = key;
      }
      return [fixed ? key : scrub(key), typeof entry === "string" ? scrub(entry, fixed ? role : "payload", key) : scrub(entry, childRole)];
    }));
    return input;
  };
  return scrub(redactOAuthValue(value, { maxStringLength: 262_144, maxDepth: 64, maxArrayEntries: 100_000, maxObjectEntries: 100_000 }), preserveKeys ? "root" : "payload") as T;
}

/** Remove known opaque credential values as well as credential-shaped fields. */
export function redactTargetCredentials<T>(target: McpFnTarget, value: T, options: { preserveKeys?: boolean } = {}): T {
  const state = targetSecrets.get(target);
  return scrubCredentials(value, new Set([...(state?.active.keys() ?? []), ...[...(state?.scopes ?? [])].flatMap((scope) => [...scope])]), options.preserveKeys);
}

/** Redact authenticated conformance output using the acquired credential. */
export function redactRemoteCredential<T>(credential: McpFnRemoteCredential, value: T, options: { preserveKeys?: boolean } = {}): T {
  return scrubCredentials(value, credentialValues(credential.headers), options.preserveKeys);
}

const MAX_CREDENTIAL_HEADERS = 32;
const MAX_CREDENTIAL_HEADER_BYTES = 16_384;
const MAX_CREDENTIAL_HEADER_VALUE_BYTES = 8_192;
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type McpFnRemoteCredentialKind = "api-key" | "oauth" | "custom";

export interface McpFnRemoteCredential {
  /** Credential headers are applied only to the fixed target origin. */
  headers: HeadersInit;
  kind?: McpFnRemoteCredentialKind;
  label?: string;
}

export interface McpFnRemoteCredentialContext {
  url: string;
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Application-owned credential lifecycle for external MCP targets. McpFn
 * acquires once per target open, revokes before disposal, and never serializes
 * the returned headers into descriptors or reports.
 */
export interface McpFnRemoteCredentialProvider {
  acquire(
    context: McpFnRemoteCredentialContext,
  ): McpFnRemoteCredential | Promise<McpFnRemoteCredential>;
  revoke?(
    credential: McpFnRemoteCredential,
    context: McpFnRemoteCredentialContext,
  ): void | Promise<void>;
  dispose?(
    credential: McpFnRemoteCredential,
    context: McpFnRemoteCredentialContext,
  ): void | Promise<void>;
}

export interface McpFnRemoteCredentialLease {
  credential: McpFnRemoteCredential;
  release(): Promise<void>;
}

export interface McpFnAuthenticatedHttpTargetOptions
  extends Omit<McpFnStreamableHttpTargetOptions, "authProvider" | "requestInit"> {
  credential: McpFnRemoteCredential | McpFnRemoteCredentialProvider;
  requestInit?: Omit<RequestInit, "headers" | "redirect"> & { headers?: HeadersInit };
}

/** Create a provider for an already-bounded API key or OAuth-derived token. */
export function staticRemoteCredentialProvider(
  credential: McpFnRemoteCredential,
): McpFnRemoteCredentialProvider {
  return { acquire: () => credential };
}

/** Acquire a credential and return an idempotent revoke-then-dispose lease. */
export async function acquireRemoteCredential(
  source: McpFnRemoteCredential | McpFnRemoteCredentialProvider,
  context: McpFnRemoteCredentialContext,
): Promise<McpFnRemoteCredentialLease> {
  const provider = isCredentialProvider(source)
    ? source
    : staticRemoteCredentialProvider(source);
  const credential = await provider.acquire(context);
  let releasePromise: Promise<void> | undefined;
  let revoked = false;
  let disposed = false;
  return {
    credential,
    release() {
      releasePromise ??= (async () => {
        try {
          try {
            if (!revoked) { await provider.revoke?.(credential, context); revoked = true; }
          } finally {
            if (!disposed) { await provider.dispose?.(credential, context); disposed = true; }
          }
        } catch {
          throw new Error("Target credential cleanup failed");
        }
      })().catch(error => { releasePromise = undefined; throw error; });
      return releasePromise;
    },
  };
}

/**
 * A URL-plus-credential target for non-McpFn servers. It delegates MCP and
 * transport behavior to the production @mcpfn/client session engine.
 */
export function authenticatedHttpTarget(
  url: string | URL,
  options: McpFnAuthenticatedHttpTargetOptions,
): McpFnTarget {
  const targetUrl = normalizeRemoteTargetUrl(url);
  const descriptorUrl = new URL(targetUrl);
  descriptorUrl.search = "";
  const { credential: _credential, requestInit, ...transportOptions } = options;
  void _credential;

  const state: SecretState = { active: new Map(), scopes: new Set() };
  const authenticated = customTarget({
    kind: "authenticated-streamable-http",
    descriptor: {
      url: descriptorUrl.toString(),
      authenticated: true,
    },
    async open(targetContext): Promise<McpFnTransportHandle> {
      const context: McpFnRemoteCredentialContext = {
        url: targetUrl.toString(),
        requestId: targetContext.requestId,
        signal: targetContext.signal,
      };
      const lease = await acquireRemoteCredential(options.credential, context);
      const secrets = credentialValues(lease.credential.headers);
      for (const secret of secrets) {
        state.active.set(secret, (state.active.get(secret) ?? 0) + 1);
        for (const scope of state.scopes) scope.add(secret);
      }
      const release = async () => {
        await lease.release();
        {
          for (const secret of secrets) {
            const count = (state.active.get(secret) ?? 1) - 1;
            if (count) state.active.set(secret, count); else state.active.delete(secret);
          }
          secrets.clear();
        }
      };
      let handle: McpFnTransportHandle | undefined;
      try {
        const credentialHeaders = validateRemoteCredentialHeaders(lease.credential.headers);
        const headers = new Headers(requestInit?.headers);
        credentialHeaders.forEach((value, name) => headers.set(name, value));
        const target = streamableHttpTarget(targetUrl, {
          ...transportOptions,
          requestInit: {
            ...requestInit,
            headers,
            // Fetch must not replay credentials to a redirect destination.
            redirect: "error",
          },
        });
        handle = await target.open(targetContext);
      } catch (error) {
        await release();
        throw error;
      }

      let closePromise: Promise<void> | undefined;
      return {
        transport: handle.transport,
        finishAuthorization: handle.finishAuthorization,
        terminateSession: handle.terminateSession,
        close() {
          closePromise ??= closeAuthenticatedHandle(
            handle!,
            { ...lease, release },
          ).catch(async (error) => {
            closePromise = undefined;
            await targetContext.diagnostic({
              phase: "transport-close", outcome: "failed", code: "MCPFN_CREDENTIAL_CLEANUP_FAILED",
              requestId: targetContext.requestId, at: new Date().toISOString(),
              target: { kind: "authenticated-streamable-http", url: descriptorUrl.toString() },
              details: { message: "Target credential cleanup failed" },
            });
            throw error;
          });
          return closePromise;
        },
      };
    },
  });
  targetSecrets.set(authenticated, state);
  return authenticated;
}

function normalizeRemoteTargetUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Authenticated MCP targets must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && url.hostname !== "[::1]" &&
      !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    throw new TypeError("Credential-bearing HTTP targets require a literal loopback address; use HTTPS remotely");
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError(
      "Authenticated MCP target URLs must not contain userinfo or a fragment",
    );
  }
  return url;
}

function isCredentialProvider(
  value: McpFnRemoteCredential | McpFnRemoteCredentialProvider,
): value is McpFnRemoteCredentialProvider {
  return "acquire" in value && typeof value.acquire === "function";
}

export function validateRemoteCredentialHeaders(value: HeadersInit): Headers {
  const rawValues = value instanceof Headers ? [] : Array.isArray(value) ? value.map(entry => entry[1]) : Object.values(value);
  if (rawValues.some(entry => typeof entry !== "string")) throw new TypeError("Credential header values must be strings");
  const headers = new Headers(value);
  const entries: Array<[string, string]> = [];
  headers.forEach((headerValue, name) => entries.push([name, headerValue]));
  if (entries.length === 0) {
    throw new TypeError("Authenticated MCP targets require at least one credential header");
  }
  if (entries.length > MAX_CREDENTIAL_HEADERS) {
    throw new TypeError(`Credential headers exceed the ${MAX_CREDENTIAL_HEADERS}-header limit`);
  }
  let bytes = 0;
  for (const [name, headerValue] of entries) {
    if (!headerValue.trim()) throw new TypeError("Credential header values must not be blank");
    if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
      throw new TypeError(`Credential header ${name} is not allowed`);
    }
    const valueBytes = new TextEncoder().encode(headerValue).byteLength;
    if (valueBytes > MAX_CREDENTIAL_HEADER_VALUE_BYTES) {
      throw new TypeError(`Credential header ${name} exceeds the value-size limit`);
    }
    bytes += new TextEncoder().encode(`${name}: ${headerValue}\r\n`).byteLength;
  }
  if (bytes > MAX_CREDENTIAL_HEADER_BYTES) {
    throw new TypeError("Credential headers exceed the aggregate size limit");
  }
  return headers;
}

async function closeAuthenticatedHandle(
  handle: McpFnTransportHandle,
  lease: McpFnRemoteCredentialLease,
): Promise<void> {
  try {
    if (handle.close) await handle.close();
    else await handle.transport.close();
  } finally {
    await lease.release();
  }
}
