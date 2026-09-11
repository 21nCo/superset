import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpFnClientRegistrationSource } from "@mcpfn/auth";
import {
  derivePkceS256Challenge,
  redactOAuthValue,
} from "@superfunctions/oauth-core";

export interface McpFnHostedRegistrationFixture {
  clientId: string;
  source: McpFnClientRegistrationSource;
  metadata: OAuthClientMetadata;
}

export interface McpFnHostedAuthorizationRequestFixture {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeVerifier: string;
}

export interface McpFnHostedTokenRequestFixture {
  grantType: string;
  code?: string;
  refreshToken?: string;
  refreshAfterExchange?: boolean;
}

export interface McpFnHostedAuthorizationCase {
  id: string;
  host: "chatgpt" | "claude" | "generic";
  registration: McpFnHostedRegistrationFixture;
  authorization: McpFnHostedAuthorizationRequestFixture;
  token?: McpFnHostedTokenRequestFixture;
  expected: {
    outcome: "allowed" | "rejected";
    errorCode?: string;
    phase?: "client-registration" | "authorization-request" | "token-exchange" | "token-refresh";
  };
}

export interface McpFnHostedAuthorizationTargetAdapter {
  issuer: string;
  prepareRegistration(fixture: McpFnHostedRegistrationFixture): Promise<void>;
  request(request: Request): Promise<Response>;
}

export interface McpFnHostedAuthorizationCaseResult {
  formatVersion: 1;
  id: string;
  host: McpFnHostedAuthorizationCase["host"];
  status: "passed" | "failed";
  phase: "client-registration" | "authorization-request" | "token-exchange" | "token-refresh";
  layer: "mcpfn-preflight" | "authorization-server";
  responseStatus?: number;
  errorCode?: string;
  error?: string;
}

export interface McpFnHostedAuthorizationFixtureOptions {
  issuer: string;
  resource: string;
  chatgptRedirectUri?: string;
  claudeRedirectUri?: string;
}

/**
 * Provider-shaped role-3 fixtures. Registration metadata and authorization
 * requests are separate objects so redirect, grant, and deployment drift can
 * fail instead of being generated from one self-consistent source.
 */
export function createHostedAuthorizationFixtures(
  options: McpFnHostedAuthorizationFixtureOptions,
): McpFnHostedAuthorizationCase[] {
  const issuer = new URL(options.issuer);
  const resource = new URL(options.resource).toString();
  const chatgptRedirect = options.chatgptRedirectUri ??
    "https://chatgpt.com/connector_platform_oauth_redirect";
  const claudeRedirect = options.claudeRedirectUri ??
    "https://claude.example.com/oauth/callback";
  const verifier = "mcpfn-role3-shared-pkce-verifier-000000000000000000000000";
  const registration = (
    clientId: string,
    source: McpFnClientRegistrationSource,
    redirectUri: string,
    grantTypes: string[],
  ): McpFnHostedRegistrationFixture => ({
    clientId,
    source,
    metadata: {
      client_name: `McpFn ${source} fixture`,
      redirect_uris: [redirectUri],
      response_types: ["code"],
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
    },
  });
  const authorization = (
    clientId: string,
    redirectUri: string,
  ): McpFnHostedAuthorizationRequestFixture => ({
    clientId,
    redirectUri,
    resource,
    scopes: ["mcp:read"],
    state: "mcpfn-role3-state",
    codeVerifier: verifier,
  });
  const chatgptId = "chatgpt-client";
  const claudeId = new URL("/client-metadata/claude", issuer).toString();
  const dcrId = "dcr-client";
  const supported = ["authorization_code", "refresh_token"];
  return [
    {
      id: "chatgpt-pre-registered-code-pkce",
      host: "chatgpt",
      registration: registration(chatgptId, "pre-registered", chatgptRedirect, supported),
      authorization: authorization(chatgptId, chatgptRedirect),
      token: {
        grantType: "authorization_code",
        code: "chatgpt-code",
        refreshAfterExchange: true,
      },
      expected: { outcome: "allowed" },
    },
    {
      id: "claude-client-metadata-extensible-grants",
      host: "claude",
      registration: registration(claudeId, "client-metadata-document", claudeRedirect, [
        ...supported,
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "urn:ietf:params:oauth:grant-type:device_code",
        "urn:example:params:oauth:grant-type:extension",
      ]),
      authorization: authorization(claudeId, claudeRedirect),
      token: {
        grantType: "authorization_code",
        code: "claude-code",
        refreshAfterExchange: true,
      },
      expected: { outcome: "allowed" },
    },
    {
      id: "dynamic-registration-code-pkce",
      host: "generic",
      registration: registration(dcrId, "dynamic", "http://127.0.0.1/callback", supported),
      authorization: authorization(dcrId, "http://127.0.0.1/callback"),
      token: { grantType: "authorization_code", code: "dcr-code" },
      expected: { outcome: "allowed" },
    },
    {
      id: "chatgpt-unregistered-redirect",
      host: "chatgpt",
      registration: registration(chatgptId, "pre-registered", chatgptRedirect, supported),
      authorization: authorization(chatgptId, `${chatgptRedirect}/drift`),
      expected: {
        outcome: "rejected",
        errorCode: "invalid_request",
        phase: "authorization-request",
      },
    },
    {
      id: "incompatible-registration-grants",
      host: "generic",
      registration: registration(
        "incompatible-client",
        "pre-registered",
        "https://client.example.com/callback",
        ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      ),
      authorization: authorization(
        "incompatible-client",
        "https://client.example.com/callback",
      ),
      expected: {
        outcome: "rejected",
        errorCode: "invalid_client",
        phase: "authorization-request",
      },
    },
    {
      id: "actual-unsupported-token-grant",
      host: "generic",
      registration: registration(
        "unsupported-token-client",
        "pre-registered",
        "https://client.example.com/callback",
        supported,
      ),
      authorization: authorization(
        "unsupported-token-client",
        "https://client.example.com/callback",
      ),
      token: { grantType: "urn:example:unsupported-token-grant" },
      expected: {
        outcome: "rejected",
        errorCode: "unsupported_grant_type",
        phase: "token-exchange",
      },
    },
  ];
}

/** Run the independently-configured hosted-authorization matrix. */
export async function runHostedAuthorizationRegression(
  target: McpFnHostedAuthorizationTargetAdapter,
  fixtures: readonly McpFnHostedAuthorizationCase[],
): Promise<McpFnHostedAuthorizationCaseResult[]> {
  const results: McpFnHostedAuthorizationCaseResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runHostedCase(target, fixture));
  }
  return results;
}

async function runHostedCase(
  target: McpFnHostedAuthorizationTargetAdapter,
  fixture: McpFnHostedAuthorizationCase,
): Promise<McpFnHostedAuthorizationCaseResult> {
  let phase: McpFnHostedAuthorizationCaseResult["phase"] = "client-registration";
  try {
    await target.prepareRegistration(structuredClone(fixture.registration));
    phase = "authorization-request";
    const authorization = new URL("authorize", ensureTrailingSlash(target.issuer));
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", fixture.authorization.clientId);
    authorization.searchParams.set("redirect_uri", fixture.authorization.redirectUri);
    authorization.searchParams.set(
      "code_challenge",
      derivePkceS256Challenge(fixture.authorization.codeVerifier),
    );
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("state", fixture.authorization.state);
    authorization.searchParams.set("resource", fixture.authorization.resource);
    authorization.searchParams.set("scope", fixture.authorization.scopes.join(" "));
    const authorizationResponse = await target.request(new Request(authorization, {
      redirect: "manual",
    }));
    const authorizationError = await oauthError(authorizationResponse);
    if (authorizationError) {
      return assessHostedCase(fixture, phase, authorizationResponse.status, authorizationError);
    }
    if (!isRedirect(authorizationResponse.status)) {
      throw new Error(`Authorization request did not redirect (HTTP ${authorizationResponse.status})`);
    }
    const code = validatedRedirectCode(authorizationResponse, fixture);
    if (fixture.token) {
      phase = "token-exchange";
      const tokenBody = new URLSearchParams({
        grant_type: fixture.token.grantType,
        client_id: fixture.authorization.clientId,
      });
      if (fixture.token.grantType === "authorization_code") {
        tokenBody.set("code", code);
        tokenBody.set("redirect_uri", fixture.authorization.redirectUri);
        tokenBody.set("code_verifier", fixture.authorization.codeVerifier);
        tokenBody.set("resource", fixture.authorization.resource);
      } else if (fixture.token.refreshToken) {
        tokenBody.set("refresh_token", fixture.token.refreshToken);
      }
      const tokenResponse = await target.request(new Request(
        new URL("token", ensureTrailingSlash(target.issuer)),
        {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenBody,
        },
      ));
      const tokenError = await oauthError(tokenResponse);
      if (tokenError) return assessHostedCase(fixture, phase, tokenResponse.status, tokenError);
      if (!tokenResponse.ok) throw new Error(`Token request returned HTTP ${tokenResponse.status}`);
      const tokenSet = await validatedTokenSet(tokenResponse);
      if (fixture.token.refreshAfterExchange) {
        if (typeof tokenSet.refresh_token !== "string" || !tokenSet.refresh_token) {
          throw new Error("Authorization-code response did not include a refresh token");
        }
        phase = "token-refresh";
        const refreshResponse = await target.request(new Request(
          new URL("token", ensureTrailingSlash(target.issuer)),
          {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: fixture.authorization.clientId,
              refresh_token: tokenSet.refresh_token,
              resource: fixture.authorization.resource,
            }),
          },
        ));
        const refreshError = await oauthError(refreshResponse);
        if (refreshError) {
          return assessHostedCase(fixture, phase, refreshResponse.status, refreshError);
        }
        if (!refreshResponse.ok) {
          throw new Error(`Refresh request returned HTTP ${refreshResponse.status}`);
        }
        await validatedTokenSet(refreshResponse);
      }
    }
    return assessHostedCase(fixture, phase, 200);
  } catch (error) {
    const safe = redactOAuthValue(error) as Record<string, unknown>;
    const code = typeof safe.code === "string" ? safe.code : undefined;
    const message = typeof safe.message === "string" ? safe.message : String(safe);
    return assessHostedCase(fixture, phase, undefined, code, message);
  }
}

function assessHostedCase(
  fixture: McpFnHostedAuthorizationCase,
  phase: McpFnHostedAuthorizationCaseResult["phase"],
  responseStatus?: number,
  errorCode?: string,
  error?: string,
): McpFnHostedAuthorizationCaseResult {
  const observedOutcome = errorCode || error ? "rejected" : "allowed";
  const expected = fixture.expected;
  const passed = !error && observedOutcome === expected.outcome &&
    (expected.errorCode === undefined || expected.errorCode === errorCode) &&
    (expected.phase === undefined || expected.phase === phase);
  return {
    formatVersion: 1,
    id: fixture.id,
    host: fixture.host,
    status: passed ? "passed" : "failed",
    phase,
    layer: phase === "client-registration" ? "mcpfn-preflight" : "authorization-server",
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(errorCode ? { errorCode } : {}),
    ...(!passed || error ? {
      error: error ??
        `Expected ${expected.outcome}${expected.errorCode ? `:${expected.errorCode}` : ""}, received ${observedOutcome}${errorCode ? `:${errorCode}` : ""}`,
    } : {}),
  };
}

async function oauthError(response: Response): Promise<string | undefined> {
  const location = response.headers.get("location");
  if (location) {
    const code = new URL(location).searchParams.get("error");
    if (code) return code;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  const body = await response.clone().json().catch(() => undefined) as
    | { error?: unknown }
    | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

function validatedRedirectCode(response: Response, fixture: McpFnHostedAuthorizationCase): string {
  const location = response.headers.get("location");
  if (!location) throw new Error("Authorization callback is missing");
  const callback = new URL(location);
  const expected = new URL(fixture.authorization.redirectUri);
  const codes = callback.searchParams.getAll("code");
  const states = callback.searchParams.getAll("state");
  if (codes.length !== 1 || !codes[0] || states.length !== 1 || states[0] !== fixture.authorization.state) {
    throw new Error("Authorization callback code or state is invalid");
  }
  callback.searchParams.delete("code");
  callback.searchParams.delete("state");
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash !== expected.hash ||
      [...expected.searchParams.keys()].some((key) =>
        JSON.stringify(callback.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key)))) {
    throw new Error("Authorization callback destination is invalid");
  }
  return codes[0];
}

async function validatedTokenSet(response: Response): Promise<{ refresh_token?: unknown }> {
  const value = await response.clone().json() as Record<string, unknown> | null;
  if (!value || typeof value.access_token !== "string" || !value.access_token ||
      typeof value.token_type !== "string" || !value.token_type) {
    throw new Error("Token response is missing an access token or token type");
  }
  return value;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function ensureTrailingSlash(value: string): URL {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
