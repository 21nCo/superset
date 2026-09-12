import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import {
  acquireRemoteCredential,
  redactRemoteCredential,
  validateRemoteCredentialHeaders,
  type McpFnRemoteCredential,
  type McpFnRemoteCredentialProvider,
} from "./remote-target.js";
import {
  normalizeMcpFnReportFailure,
  type McpFnReportFailure,
} from "./reports.js";

export const OFFICIAL_CONFORMANCE_VERSION = "0.1.16";

export interface OfficialConformanceOptions {
  url: string;
  suite?: "active" | "all" | "pending";
  scenario?: string;
  expectedFailures?: string;
  outputDir?: string;
  specVersion?: string;
  verbose?: boolean;
  cwd?: string;
  stdio?: "inherit" | "pipe";
  /** Environment names removed before spawning the upstream runner. */
  sensitiveEnvironmentVariables?: readonly string[];
}

export interface OfficialConformanceResult {
  formatVersion: 1;
  kind: "mcpfn.official-conformance-report";
  ok: boolean;
  suiteVersion: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: McpFnReportFailure;
}

export interface AuthenticatedConformanceProxy {
  /** Loopback URL to pass to the official conformance runner. */
  url: string;
  close(): Promise<void>;
}

export interface AuthenticatedConformanceProxyOptions {
  /** Fixed loopback MCP URL. Requests cannot select a different origin or path. */
  url: string;
  /** Headers injected into requests using the proxy's own authority. Values are never logged. */
  headers: HeadersInit;
}

export interface AuthenticatedOfficialConformanceOptions extends OfficialConformanceOptions {
  /** Preferred typed credential lifecycle. */
  credential?: McpFnRemoteCredential | McpFnRemoteCredentialProvider;
  /** Backward-compatible static header input. Prefer credential. */
  headers?: HeadersInit;
}

/**
 * Start a loopback-only streaming proxy for runners that cannot send auth
 * headers. Authenticated requests use one fixed upstream authority and path.
 * Host-manipulation probes are forwarded without injected credentials.
 */
export async function createAuthenticatedConformanceProxy(
  options: AuthenticatedConformanceProxyOptions,
): Promise<AuthenticatedConformanceProxy> {
  const upstream = new URL(options.url);
  if (!["http:", "https:"].includes(upstream.protocol)) {
    throw new TypeError(
      "Authenticated conformance upstream must use HTTP or HTTPS",
    );
  }
  if (upstream.username || upstream.password || upstream.hash) {
    throw new TypeError(
      "Authenticated conformance upstream must not contain userinfo or a fragment",
    );
  }
  const hostname = normalizeLoopbackHostname(upstream.hostname);
  if (!hostname) {
    throw new TypeError(
      "Authenticated conformance upstream must use a literal loopback address",
    );
  }
  const protocol = upstream.protocol === "https:" ? "https:" : "http:";
  const port = upstream.port === "" ? undefined : Number(upstream.port);
  const requestPath = `${upstream.pathname}${upstream.search}`;
  const injected = validateRemoteCredentialHeaders(options.headers);
  const activeRequests = new Set<ReturnType<typeof httpRequest>>();
  const activeSockets = new Set<Socket>();
  let proxyAuthority: string | undefined;
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith("/")) {
      outgoing.writeHead(400).end();
      return;
    }
    const headers: IncomingHttpHeaders = { ...incoming.headers };
    delete headers.connection;
    const usesProxyAuthority = incoming.headers.host === proxyAuthority;
    injected.forEach((value, name) => {
      const normalizedName = name.toLowerCase();
      delete headers[normalizedName];
      if (usesProxyAuthority) headers[normalizedName] = value;
    });
    // Authenticated traffic is pinned to the upstream Host. Host-manipulation
    // probes retain their hostile value, but never receive injected credentials.
    if (usesProxyAuthority) headers.host = upstream.host;
    const transport = protocol === "https:" ? httpsRequest : httpRequest;
    const proxied = transport(
      {
        protocol,
        hostname,
        port,
        path: requestPath,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    activeRequests.add(proxied);
    proxied.once("close", () => activeRequests.delete(proxied));
    proxied.once("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once("aborted", () => proxied.destroy());
    incoming.pipe(proxied);
  });
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Authenticated conformance proxy did not bind a TCP port");
  }
  const url = new URL(
    upstream.pathname + upstream.search,
    `http://127.0.0.1:${address.port}`,
  );
  proxyAuthority = url.host;
  let closePromise: Promise<void> | undefined;
  return {
    url: url.toString(),
    close: () => {
      closePromise ??= (async () => {
        for (const request of activeRequests) request.destroy();
        for (const socket of activeSockets) socket.destroy();
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      return closePromise;
    },
  };
}

function normalizeLoopbackHostname(
  hostname: string,
): "127.0.0.1" | "::1" | undefined {
  if (hostname === "127.0.0.1") return "127.0.0.1";
  if (hostname === "[::1]") return "::1";
  return undefined;
}

function npxInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npx", args };
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    npmExecPath ? path.join(path.dirname(npmExecPath), "npx-cli.js") : undefined,
    path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npx-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npxCli = candidates.find((candidate) => existsSync(candidate));
  if (!npxCli) {
    throw new Error("Unable to locate npm's npx-cli.js for the official MCP conformance runner");
  }
  return { command: process.execPath, args: [npxCli, ...args] };
}

export function buildOfficialConformanceArgs(
  options: OfficialConformanceOptions,
): string[] {
  const args = [
    "--yes",
    `@modelcontextprotocol/conformance@${OFFICIAL_CONFORMANCE_VERSION}`,
    "server",
    "--url",
    options.url,
  ];
  if (options.suite) args.push("--suite", options.suite);
  if (options.scenario) args.push("--scenario", options.scenario);
  if (options.expectedFailures) {
    args.push("--expected-failures", options.expectedFailures);
  }
  if (options.outputDir) args.push("--output-dir", options.outputDir);
  if (options.specVersion) args.push("--spec-version", options.specVersion);
  if (options.verbose) args.push("--verbose");
  return args;
}

export function buildOfficialConformanceEnvironment(
  sensitiveNames: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const sensitive = new Set(sensitiveNames.map((name) => name.toLowerCase()));
  for (const name of Object.keys(environment)) {
    if (sensitive.has(name.toLowerCase())) delete environment[name];
  }
  environment.PATH = [path.dirname(process.execPath), environment.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  return environment;
}

export async function runOfficialConformance(
  options: OfficialConformanceOptions,
): Promise<OfficialConformanceResult> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (nodeMajor < 22) {
    throw new Error(
      `Official MCP conformance ${OFFICIAL_CONFORMANCE_VERSION} requires Node.js 22 or newer; current runtime is ${process.versions.node}`,
    );
  }
  const args = buildOfficialConformanceArgs(options);
  const invocation = npxInvocation(args);
  const childEnvironment = buildOfficialConformanceEnvironment(
    options.sensitiveEnvironmentVariables,
  );

  return await new Promise<OfficialConformanceResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: childEnvironment,
      stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      const failure = normalizeMcpFnReportFailure(error, "upstream-conformance");
      resolve({
        formatVersion: 1,
        kind: "mcpfn.official-conformance-report",
        ok: false,
        suiteVersion: OFFICIAL_CONFORMANCE_VERSION,
        exitCode: 1,
        stdout: "",
        stderr: failure.message,
        failure,
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      const safeStdout = String(redactOAuthValue(stdout, { maxStringLength: 262_144 }));
      const safeStderr = String(redactOAuthValue(stderr, { maxStringLength: 262_144 }));
      const failure = exitCode === 0
        ? undefined
        : normalizeMcpFnReportFailure(
          new Error(safeStderr || safeStdout || `Official conformance exited ${exitCode}`),
          "upstream-conformance",
        );
      resolve({
        formatVersion: 1,
        kind: "mcpfn.official-conformance-report",
        ok: exitCode === 0,
        suiteVersion: OFFICIAL_CONFORMANCE_VERSION,
        exitCode,
        stdout: safeStdout,
        stderr: safeStderr,
        ...(failure ? { failure } : {}),
      });
    });
  });
}

/**
 * Run the pinned official suite against an authenticated MCP endpoint.
 * Always captures stdio (even when inherit is requested) to redact credentials.
 * outputDir is rejected before acquisition; only the returned redacted result is safe to persist.
 */
export async function runAuthenticatedOfficialConformance(
  options: AuthenticatedOfficialConformanceOptions,
): Promise<OfficialConformanceResult> {
  if (options.outputDir !== undefined) throw new TypeError("Authenticated conformance does not support outputDir; serialize the redacted result instead");
  const { headers, credential, ...conformance } = options;
  if ((headers === undefined) === (credential === undefined)) {
    throw new TypeError("Provide exactly one of credential or headers for authenticated conformance");
  }
  const lease = await acquireRemoteCredential(
    credential ?? { headers: headers! },
    {
      url: conformance.url,
      requestId: randomUUID(),
    },
  );
  let proxy: AuthenticatedConformanceProxy | undefined;
  try {
    proxy = await createAuthenticatedConformanceProxy({
      url: conformance.url,
      headers: lease.credential.headers,
    });
    return redactRemoteCredential(lease.credential, await runOfficialConformance({ ...conformance, stdio: "pipe", url: proxy.url }), { preserveKeys: true });
  } finally {
    try {
      await proxy?.close();
    } finally {
      await lease.release();
    }
  }
}
