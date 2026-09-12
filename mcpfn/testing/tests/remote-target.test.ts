import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthProviderMcpHandler } from "@mcpfn/auth";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";

import {
  authenticatedHttpTarget,
  McpFnTestClient,
  createMcpFnTargetSuiteJUnit,
  runMcpFnTargetSuite,
  type McpFnRemoteCredentialProvider,
} from "../src/index.js";

describe("authenticated remote MCP targets", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });


  it("rejects plaintext remote credentials and removes descriptor query values", () => {
    const credential = { headers: { authorization: "Bearer secret" } };
    expect(() => authenticatedHttpTarget("http://example.com/mcp", { credential })).toThrow(/HTTPS/);
    expect(authenticatedHttpTarget("https://example.com/mcp?credential=secret", { credential }).describe().url)
      .toBe("https://example.com/mcp");
  });

  it("checks visible tools without a manifest and reports cleanup failures", async () => {
    const fixture = await startAuthenticatedServer("cleanup-secret");
    closeCallbacks.push(fixture.close);
    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget(fixture.url, { credential: {
        acquire: () => ({ headers: { authorization: "Bearer cleanup-secret" } }),
        revoke: () => { throw new Error("revoke failed: cleanup-secret"); },
      } }), expectedToolNames: ["missing-tool"],
    });
    expect(report.ok).toBe(false);
    expect(report.failure?.message).toContain("Tool inventory mismatch");
    expect(report.incompleteReason).toContain("Target cleanup failed");
    expect(JSON.stringify(report)).not.toContain("cleanup-secret");
  });
  it("scrubs reflected opaque credentials from JSON and JUnit", async () => {
    const secret = "opaque-7Qx9";
    const fixture = await startAuthenticatedServer(secret, true);
    closeCallbacks.push(fixture.close);
    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget(fixture.url, { credential: { headers: { authorization: `Bearer ${secret}` } } }),
      scenarios: [{ name: "reflection", tool: "identity", expect: { structuredContent: { echo: "different" } } }],
    });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(createMcpFnTargetSuiteJUnit(report)).not.toContain(secret);
  });

  it("uses URL plus a real auth-provider adapter without server or registry types in the consumer", async () => {
    const fixture = await startAuthenticatedServer("remote-secret");
    closeCallbacks.push(fixture.close);
    const lifecycle: string[] = [];
    const credential = lifecycleProvider("remote-secret", lifecycle);

    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget(fixture.url, { credential }),
      scenarios: [{
        name: "call authenticated identity",
        tool: "identity",
        expect: { structuredContent: { authenticated: true } },
      }],
    });

    expect(report).toMatchObject({
      ok: true,
      target: {
        kind: "authenticated-streamable-http",
        authenticated: true,
      },
      runtime: {
        reportSchemaVersion: "1.0.0",
        packages: { testing: expect.stringMatching(/^\d+\.\d+\.\d+/) },
      },
      passed: 1,
    });
    expect(JSON.stringify(report)).not.toContain("remote-secret");
    expect(lifecycle).toEqual(["acquire", "revoke", "dispose"]);
  });

  it("returns a redacted layer-classified report and releases credentials on initialization failure", async () => {
    const fixture = await startAuthenticatedServer("expected-secret");
    closeCallbacks.push(fixture.close);
    const lifecycle: string[] = [];

    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget(fixture.url, {
        credential: lifecycleProvider("wrong-secret", lifecycle),
      }),
      scenarios: [{ name: "never reached", kind: "initialize" }],
    });

    expect(report).toMatchObject({
      ok: false,
      status: "incomplete",
      failure: {
        code: expect.any(String),
        phase: expect.any(String),
        layer: "resource-server",
      },
    });
    expect(report.results).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("wrong-secret");
    expect(lifecycle).toEqual(["acquire", "revoke", "dispose"]);
  });

  it("memoizes concurrent closes so credentials are revoked and disposed exactly once", async () => {
    const fixture = await startAuthenticatedServer("close-secret");
    closeCallbacks.push(fixture.close);
    const lifecycle: string[] = [];
    const client = await McpFnTestClient.connectTarget(
      authenticatedHttpTarget(fixture.url, {
        credential: lifecycleProvider("close-secret", lifecycle),
      }),
    );

    await Promise.all([client.close(), client.close(), client.close()]);
    expect(lifecycle).toEqual(["acquire", "revoke", "dispose"]);
  });

  it("rejects credentialed redirects without forwarding the credential", async () => {
    let destinationRequests = 0;
    const destination = createServer((_request, response) => {
      destinationRequests += 1;
      response.writeHead(200).end();
    });
    await listen(destination);
    closeCallbacks.push(() => closeServer(destination));
    const destinationAddress = destination.address() as AddressInfo;
    const redirect = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${destinationAddress.port}/mcp`,
      }).end();
    });
    await listen(redirect);
    closeCallbacks.push(() => closeServer(redirect));
    const redirectAddress = redirect.address() as AddressInfo;

    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget(
        `http://127.0.0.1:${redirectAddress.port}/mcp`,
        { credential: { headers: { authorization: "Bearer redirect-secret" } } },
      ),
    });

    expect(report.ok).toBe(false);
    expect(destinationRequests).toBe(0);
    expect(JSON.stringify(report)).not.toContain("redirect-secret");
  });

  it("bounds and validates credential header input before transport initialization", async () => {
    const acquire = vi.fn(() => ({ headers: {} }));
    const revoke = vi.fn();
    const dispose = vi.fn();
    const report = await runMcpFnTargetSuite({
      target: authenticatedHttpTarget("http://127.0.0.1:1/mcp", {
        credential: { acquire, revoke, dispose },
      }),
    });
    expect(report.failure?.message).toContain("at least one credential header");
    expect(acquire).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function lifecycleProvider(
  token: string,
  lifecycle: string[],
): McpFnRemoteCredentialProvider {
  return {
    acquire: async () => {
      lifecycle.push("acquire");
      return { kind: "oauth", headers: { authorization: `Bearer ${token}` } };
    },
    revoke: async () => { lifecycle.push("revoke"); },
    dispose: async () => { lifecycle.push("dispose"); },
  };
}

async function startAuthenticatedServer(expectedToken: string, echo = false): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const mcp = createMcpFnServer({
    info: { name: "authenticated-external-fixture", version: "1.0.0" },
    registry: new McpFnRegistry().register({
      name: "identity",
      description: "Return the authenticated state.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => structuredResult(echo ? { echo: expectedToken } : { authenticated: true }),
    }),
  });
  const mcpHandler = await mcp.createWebStandardHandler({ enableJsonResponse: true });
  let protectedHandler: ((request: Request) => Promise<Response>) | undefined;
  const server = createServer(async (request, response) => {
    try {
      await sendWebResponse(
        response,
        await protectedHandler!(await toWebRequest(request)),
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  protectedHandler = createAuthProviderMcpHandler(mcpHandler, {
    resource: url,
    provider: {
      async authenticateBearer(token) {
        if (token !== expectedToken) return null;
        return {
          id: "fixture-session",
          type: "api-key",
          subject: { actorId: "fixture", actorType: "service" },
          scopes: ["mcp:test"],
          resourceIds: [url],
        };
      },
    },
  });
  return {
    url,
    close: async () => {
      await mcp.close();
      await closeServer(server);
    },
  };
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return new Request(
    new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`),
    {
      method: request.method,
      headers: new Headers(Object.entries(request.headers).flatMap(([name, value]) =>
        Array.isArray(value)
          ? value.map((entry) => [name, entry] as [string, string])
          : value === undefined ? [] : [[name, value] as [string, string]],
      )),
      ...(body.length ? { body } : {}),
    },
  );
}

async function sendWebResponse(response: ServerResponse, web: Response): Promise<void> {
  response.writeHead(web.status, Object.fromEntries(web.headers));
  response.end(Buffer.from(await web.arrayBuffer()));
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}


it.each(["", "   "])("rejects blank credential headers without corrupting reports (%j)", async (value) => {
  const report = await runMcpFnTargetSuite({ target: authenticatedHttpTarget("http://127.0.0.1:1/mcp", { credential: { headers: { "x-api-key": value } } }) });
  expect(report.ok).toBe(false);
  expect(report.failure?.message).toContain("must not be blank");
  expect(JSON.stringify(report).length).toBeLessThan(10000);
});

it("redacts invalid-header cleanup errors and credential-shaped fields", async () => {
  const { redactTargetCredentials } = await import("../src/remote-target.js");
  const target = authenticatedHttpTarget("http://127.0.0.1:1/mcp", { credential: {
    acquire: () => ({ headers: { host: "opaque-invalid-credential" } }),
    revoke: () => { throw new Error("opaque-invalid-credential"); },
  } });
  const report = await runMcpFnTargetSuite({ target });
  expect(report.ok).toBe(false);
  expect(JSON.stringify(report)).not.toContain("opaque-invalid-credential");
  expect(JSON.stringify(redactTargetCredentials(target, { access_token: "unrelated-secret" }))).not.toContain("unrelated-secret");
});

it("retains released values for a report scope and forgets them when that scope ends", async () => {
  const { beginTargetCredentialRedaction, redactTargetCredentials } = await import("../src/remote-target.js");
  const fixture = await startAuthenticatedServer("rotated-opaque-value");
  const target = authenticatedHttpTarget(fixture.url, { credential: { headers: { authorization: "Bearer rotated-opaque-value" } } });
  const finish = beginTargetCredentialRedaction(target);
  try {
    const client = await McpFnTestClient.connectTarget(target);
    await client.close();
    expect(redactTargetCredentials(target, "rotated-opaque-value")).toBe("[REDACTED]");
    finish();
    expect(redactTargetCredentials(target, "rotated-opaque-value")).toBe("rotated-opaque-value");
  } finally { finish(); await fixture.close(); }
});

it("preserves report collections and fixed keys while scrubbing payload keys", async () => {
  const { redactRemoteCredential } = await import("../src/remote-target.js");
  const report = { target: { kind: "http" }, results: Array.from({ length: 501 }, (_, index) => ({ index, structuredContent: { target: "target" } })), count: 501 };
  const result = redactRemoteCredential({ headers: { "x-api-key": "target" } }, report, { preserveKeys: true });
  expect(result.target).toEqual({ kind: "http" });
  expect(result.results).toHaveLength(501);
  expect(result.count).toBe(501);
  expect(result.results[0].structuredContent).toEqual({ "[REDACTED]": "[REDACTED]" });
});
it("rejects non-string headers and releases the acquired lease", async () => {
  const dispose = vi.fn();
  const target = authenticatedHttpTarget("http://127.0.0.1:1/mcp", { credential: { acquire: () => ({ headers: { "x-api-key": 123456 } as any }), dispose } });
  const report = await runMcpFnTargetSuite({ target });
  expect(report.ok).toBe(false);
  expect(dispose).toHaveBeenCalledOnce();
  expect(report.failure?.message).toContain("must be strings");
});
it("retries failed cleanup without repeating successful disposal", async () => {
  const { acquireRemoteCredential } = await import("../src/remote-target.js");
  const revoke = vi.fn().mockRejectedValueOnce(new Error("retry")).mockResolvedValue(undefined);
  const dispose = vi.fn();
  const lease = await acquireRemoteCredential({ acquire: () => ({ headers: { "x-api-key": "secret" } }), revoke, dispose }, { url: "https://test/mcp", requestId: "test" });
  await expect(lease.release()).rejects.toThrow(/cleanup failed/);
  await expect(lease.release()).resolves.toBeUndefined();
  await lease.release();
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledOnce();
});
it("handles long authorization whitespace without backtracking", async () => {
  const { redactRemoteCredential } = await import("../src/remote-target.js");
  expect(redactRemoteCredential({ headers: { authorization: `Bearer${" ".repeat(100000)}opaque` } }, "opaque")).toBe("[REDACTED]");
});

it("retries authenticated handle revocation after a strict close fails", async () => {
  const fixture = await startAuthenticatedServer("retry-secret");
  const revoke = vi.fn().mockRejectedValueOnce(new Error("retry-secret")).mockResolvedValue(undefined);
  const dispose = vi.fn();
  const target = authenticatedHttpTarget(fixture.url, { credential: { acquire: () => ({ headers: { authorization: "Bearer retry-secret" } }), revoke, dispose } });
  try {
    const handle = await target.open({ requestId: "retry", diagnostic: async () => {} } as any);
    await expect(handle.close!()).rejects.toThrow(/cleanup failed/);
    await expect(handle.close!()).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  } finally { await fixture.close(); }
});

it("redacts dynamic inspector keys without corrupting result statuses", async () => {
  const { redactRemoteCredential, McpFnRedactionLimitError } = await import("../src/remote-target.js");
  const credential = { headers: { "x-api-key": "passed" } };
  const report = { kind: "mcpfn.target-suite-report", ok: true, results: [{ status: "passed", name: "passed" }], timeline: [{ details: { passed: "passed" } }] };
  const redacted = redactRemoteCredential(credential, report, { preserveKeys: true });
  expect(createMcpFnTargetSuiteJUnit({ ...redacted, target: { kind: "custom" }, runtime: { node: process.version }, status: "complete", total: 1, passed: 1, failed: 0, incomplete: 0, droppedResults: 0, droppedObservedEvents: 0, droppedTimelineEvents: 0 } as any)).not.toContain("<failure");
  expect(redacted.results[0]).toEqual({ status: "passed", name: "[REDACTED]" });
  const snapshot = { kind: "mcpfn.inspector-snapshot", timeline: [{ event: { passed: { status: "passed" } } }] };
  expect(JSON.stringify(redactRemoteCredential(credential, snapshot, { preserveKeys: true }))).not.toContain("passed");
  let deep: any = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
  expect(() => redactRemoteCredential(credential, deep)).toThrow(McpFnRedactionLimitError);
  expect(() => redactRemoteCredential(credential, new Array(1_000_000))).toThrow(McpFnRedactionLimitError);
});

it("retains failed pre-handle releases for a cleanup retry", async () => {
  const revoke = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
  const target = authenticatedHttpTarget("http://127.0.0.1:1/mcp", { credential: {
    acquire: () => ({ headers: undefined } as any), revoke,
  } });
  await expect(target.open({ requestId: "invalid", diagnostic: async () => {} })).rejects.toThrow(/cleanup failed/);
  await target.cleanup!();
  expect(revoke).toHaveBeenCalledTimes(2);
});
it("releases malformed credentials even when inspection fails", async () => {
  const revoke = vi.fn();
  const target = authenticatedHttpTarget("http://127.0.0.1:1/mcp", { credential: {
    acquire: () => ({ headers: undefined } as any), revoke,
  } });
  await expect(target.open({ requestId: "invalid", diagnostic: async () => {} })).rejects.toThrow();
  expect(revoke).toHaveBeenCalledOnce();
});
