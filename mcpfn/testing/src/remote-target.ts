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
    const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(raw.trim())?.[1];
    if (token) secrets.add(token);
  }
  return secrets;
}

function scrubCredentials<T>(value: T, values: Iterable<string>): T {
  const secrets = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), input);
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, entry]) => [scrub(key), scrub(entry)]));
    return input;
  };
  return scrub(redactOAuthValue(value, { maxStringLength: 262_144 })) as T;
}

/** Remove known opaque credential values as well as credential-shaped fields. */
export function redactTargetCredentials<T>(target: McpFnTarget, value: T): T {
  const state = targetSecrets.get(target);
  return scrubCredentials(value, new Set([...(state?.active.keys() ?? []), ...[...(state?.scopes ?? [])].flatMap((scope) => [...scope])]));
}

/** Redact authenticated conformance output using the acquired credential. */
export function redactRemoteCredential<T>(credential: McpFnRemoteCredential, value: T): T {
  return scrubCredentials(value, credentialValues(credential.headers));
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
  return {
    credential,
    release() {
      releasePromise ??= releaseCredential(provider, credential, context);
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
        try { await lease.release(); }
        finally {
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

async function releaseCredential(
  provider: McpFnRemoteCredentialProvider,
  credential: McpFnRemoteCredential,
  context: McpFnRemoteCredentialContext,
): Promise<void> {
  try {
    try { await provider.revoke?.(credential, context); }
    finally { await provider.dispose?.(credential, context); }
  } catch {
    throw new Error("Target credential cleanup failed");
  }
}
