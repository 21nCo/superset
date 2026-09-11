import { describe, expect, it } from "vitest";
import {
  createMcpAuthorizationCompatibilityHandler,
  normalizeMcpClientRegistration,
  type McpFnNormalizedClientRegistration,
} from "@mcpfn/auth";

import {
  createHostedAuthorizationFixtures,
  runHostedAuthorizationRegression,
} from "../src/index.js";

describe("hosted role-3 regression harness", () => {
  it("keeps registration and request inputs independent across named hosts and grant errors", async () => {
    const issuer = "https://login.example.com";
    const resource = "https://mcp.example.com/mcp";
    const registrations = new Map<string, McpFnNormalizedClientRegistration>();
    const handler = createMcpAuthorizationCompatibilityHandler({
      issuer,
      clients: {
        resolve: async (clientId) => registrations.get(clientId) ?? null,
      },
      allowedResources: [resource],
      capabilities: { requireRefreshResource: true },
      supportedScopes: ["mcp:read"],
      authorize: async (input) => {
        const callback = new URL(input.redirectUri);
        callback.searchParams.set("code", `${input.client.clientId}-code`);
        if (input.state) callback.searchParams.set("state", input.state);
        return Response.redirect(callback, 302);
      },
      tokenAuthority: {
        exchangeAuthorizationCode: async () => ({
          access_token: "role3-access-token",
          token_type: "Bearer",
          refresh_token: "role3-refresh-token",
        }),
        refreshToken: async () => ({
          access_token: "role3-refreshed-token",
          token_type: "Bearer",
          refresh_token: "role3-rotated-token",
        }),
      },
    });
    const fixtures = createHostedAuthorizationFixtures({ issuer, resource });
    const drift = fixtures.find((fixture) => fixture.id === "chatgpt-unregistered-redirect")!;
    expect(drift.registration.metadata.redirect_uris).not.toContain(
      drift.authorization.redirectUri,
    );

    const results = await runHostedAuthorizationRegression({
      issuer,
      async prepareRegistration(fixture) {
        registrations.set(fixture.clientId, normalizeMcpClientRegistration(fixture));
      },
      request: handler,
    }, fixtures);

    expect(results).toHaveLength(6);
    expect(results.filter((result) => result.status !== "passed")).toEqual([]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "claude-client-metadata-extensible-grants",
        phase: "token-refresh",
      }),
      expect.objectContaining({
        id: "chatgpt-unregistered-redirect",
        errorCode: "invalid_request",
        phase: "authorization-request",
      }),
      expect.objectContaining({
        id: "actual-unsupported-token-grant",
        errorCode: "unsupported_grant_type",
        phase: "token-exchange",
      }),
    ]));
  });
  it.each(["throw", "no-redirect", "missing-code", "wrong-state", "wrong-callback", "empty-token", "token-redirect"])("fails broken hosted flow: %s", async (fault) => {
    const issuer = "https://login.example.com";
    const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
    const results = await runHostedAuthorizationRegression({
      issuer, prepareRegistration: async () => {},
      request: async (request) => {
        if (fault === "throw") throw new Error("transport aborted");
        if (new URL(request.url).pathname.endsWith("authorize")) {
          if (fault === "no-redirect") return new Response("", { status: 200 });
          const callback = new URL(fault === "wrong-callback" ? "https://evil.example/callback" : fixture.authorization.redirectUri);
          if (fault !== "missing-code") callback.searchParams.set("code", "real-code");
          callback.searchParams.set("state", fault === "wrong-state" ? "wrong" : fixture.authorization.state);
          return Response.redirect(callback, 302);
        }
        expect(request.redirect).toBe("manual");
        if (fault === "token-redirect") return Response.redirect("https://evil.example/token", 307);
        return Response.json(fault === "empty-token" ? {} : { access_token: "valid-token", token_type: "Bearer", refresh_token: "valid-refresh" });
      },
    }, [fixture]);
    expect(results[0]?.status).toBe("failed");
  });

});

it.each(["status", "state", "destination"])("rejects malformed OAuth rejection %s", async (fault) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
  fixture.expected = { outcome: "rejected", errorCode: "invalid_request" };
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {},
    request: async () => {
      if (fault === "status") return Response.json({ error: "invalid_request" });
      const callback = new URL(fault === "destination" ? "https://evil.example/cb" : fixture.authorization.redirectUri);
      callback.searchParams.set("error", "invalid_request");
      callback.searchParams.set("state", fault === "state" ? "wrong" : fixture.authorization.state);
      return Response.redirect(callback, 302);
    },
  }, [fixture]);
  expect(results[0]?.status).toBe("failed");
});
