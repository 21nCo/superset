import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpAuthorizationCompatibilityHandler,
  createMcpFnOAuthClientProvider,
  createOAuthResourceServerHandler,
  McpFnHostedAuthorizationError,
  normalizeMcpClientRegistration,
} from "@mcpfn/auth";
import { createMcpFnClient, streamableHttpTarget } from "@mcpfn/client";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";
import { derivePkceS256Challenge } from "@superfunctions/oauth-core";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// Adapted from PR #150: prove named hosted OAuth flows reach an MCP tool.
import { createHostedAuthorizationFixtures, type McpFnHostedAuthorizationCase } from "../src/index.js";

interface StartedHost {
  origin: string;
  close(): Promise<void>;
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  return new Request(`http://${request.headers.host}${request.url ?? "/"}`, {
    method,
    headers,
    ...(["GET", "HEAD"].includes(method)
      ? {}
      : { body: Buffer.concat(chunks), duplex: "half" }),
  } as RequestInit);
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.end(Buffer.from(await response.arrayBuffer()));
}

async function startHandler(handler: (request: Request) => Promise<Response>): Promise<StartedHost> {
  const server = createServer((incoming, outgoing) => {
    void webRequest(incoming)
      .then(handler)
      .then((response) => writeWebResponse(response, outgoing))
      .catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("hosted authorization fixture did not bind");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function registrationFromCase(authCase: McpFnHostedAuthorizationCase) {
  return normalizeMcpClientRegistration(authCase.registration);
}

async function startHostedRole3(authCase: McpFnHostedAuthorizationCase): Promise<{
  origin: string;
  resource: string;
  close(): Promise<void>;
}> {
  const pending = new Map<string, { challenge: string; clientId: string; scopes: string[] }>();
  const access = new Map<string, AuthInfo>();
  const mcp = createMcpFnServer({
    info: { name: `${authCase.host}-hosted-role3`, version: "1.0.0" },
    registry: new McpFnRegistry().register({
      name: "identity",
      description: "Return the authenticated hosted-role-3 identity.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => structuredResult({ host: authCase.host }),
    }),
  });
  const mcpHandler = await mcp.createWebStandardHandler({ enableJsonResponse: true });
  let dispatch: (request: Request) => Promise<Response> = async () =>
    new Response("hosted fixture is starting", { status: 503 });
  const started = await startHandler((request) => dispatch(request));
  const origin = started.origin;
  const hosted = createMcpAuthorizationCompatibilityHandler({
    issuer: origin,
    allowInsecureLoopbackIssuer: true,
    clients: {
      resolve: async (clientId) => {
        const registration = registrationFromCase(authCase);
        return clientId === registration.clientId ? registration : null;
      },
    },
    supportedScopes: ["mcp:read"],
    capabilities: { requireResource: false, requireState: true },
    clientMetadataDocuments: { enabled: true },
    authorize: async (input) => {
      const code = randomUUID();
      pending.set(code, {
        challenge: input.codeChallenge,
        clientId: input.client.clientId,
        scopes: input.scopes,
      });
      const redirect = new URL(input.redirectUri);
      redirect.searchParams.set("code", code);
      if (input.state) redirect.searchParams.set("state", input.state);
      return new Response(null, {
        status: 302,
        headers: { location: redirect.toString() },
      });
    },
    tokenAuthority: {
      exchangeAuthorizationCode: async (input) => {
        const record = pending.get(input.code);
        if (!record) {
          throw new McpFnHostedAuthorizationError("invalid_grant", "Authorization code is invalid");
        }
        pending.delete(input.code);
        if (derivePkceS256Challenge(input.codeVerifier) !== record.challenge) {
          throw new McpFnHostedAuthorizationError("invalid_grant", "PKCE verification failed");
        }
        const token = `atk_${randomUUID()}`;
        access.set(token, {
          token,
          clientId: record.clientId,
          scopes: record.scopes.length ? record.scopes : ["mcp:read"],
          resource: new URL(`${origin}/mcp`),
          expiresAt: Math.floor(Date.now() / 1_000) + 300,
        });
        return { access_token: token, token_type: "Bearer", expires_in: 300 };
      },
    },
  });
  const protectedHandler = createOAuthResourceServerHandler(mcpHandler, {
    resource: `${origin}/mcp`,
    authorizationServers: [origin],
    allowInsecureLoopbackAuthorizationServers: true,
    scopesSupported: ["mcp:read"],
    requiredScopes: ["mcp:read"],
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const record = access.get(token);
        if (!record) throw new Error("Invalid access token");
        return record;
      },
    },
  });
  dispatch = async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return protectedHandler(request);
    }
    return hosted(request);
  };
  return {
    origin,
    resource: `${origin}/mcp`,
    close: async () => {
      await mcp.close();
      await started.close();
    },
  };
}

describe("hosted-server role-3 transport-neutral harness", () => {
  const started: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.allSettled(started.splice(0).map((value) => value.close()));
  });

  for (const host of ["chatgpt", "claude"] as const) {
    it(`${host} completes independently configured registration and authorization-code + PKCE`, async () => {
      const authCase = createHostedAuthorizationFixtures({ issuer: "https://login.example.com", resource: "https://mcp.example.com/mcp" })
        .find((fixture) => fixture.host === host && fixture.expected.outcome === "allowed")!;
      expect(authCase.registration.metadata.redirect_uris).toEqual([
        authCase.authorization.redirectUri,
      ]);
      expect(authCase.registration.metadata.grant_types).toContain("authorization_code");
      const fixture = await startHostedRole3(authCase);
      started.push(fixture);
      let callback: URL | undefined;
      const provider = createMcpFnOAuthClientProvider({
        redirectUrl: authCase.authorization.redirectUri,
        clientMetadata: {
          redirect_uris: [...authCase.registration.metadata.redirect_uris],
          response_types: ["code"],
          grant_types: [...authCase.registration.metadata.grant_types!],
          token_endpoint_auth_method: "none",
          scope: authCase.authorization.scopes.join(" "),
        },
        ...(authCase.registration.source === "client-metadata-document"
          ? { clientMetadataUrl: authCase.registration.clientId }
          : {}),
        openAuthorization: async (url) => {
          const response = await fetch(url, { redirect: "manual" });
          expect(response.status).toBe(302);
          callback = new URL(response.headers.get("location")!);
        },
      });
      if (authCase.registration.source === "pre-registered") {
        await provider.saveClientInformation({ client_id: authCase.registration.clientId });
      }
      const client = createMcpFnClient({
        target: streamableHttpTarget(fixture.resource, { authProvider: provider }),
      });
      try {
        await expect(client.connect()).rejects.toMatchObject({
          code: "MCPFN_AUTHORIZATION_REQUIRED",
        });
        expect(callback?.searchParams.get("code")).toBeTruthy();
        await client.completeAuthorization({
          code: callback!.searchParams.get("code")!,
          state: callback!.searchParams.get("state")!,
        });
        await expect(client.tools.call("identity")).resolves.toMatchObject({
          structuredContent: { host },
        });
      } finally {
        await client.close();
      }
    });

  }
});
