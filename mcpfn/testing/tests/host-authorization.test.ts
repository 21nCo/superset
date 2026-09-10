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
    expect(results.every((result) => result.status === "passed")).toBe(true);
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
});
