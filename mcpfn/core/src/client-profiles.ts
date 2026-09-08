import type { ClientCapabilities, Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpFnRequestExtra } from "./types.js";

/** Identity derived from authenticated, server-trusted state, never initialization metadata. */
export interface McpFnVerifiedClientIdentity {
  id: string;
  attributes?: Record<string, unknown>;
}

export interface McpFnClientInitialization {
  clientInfo?: Implementation;
  capabilities?: ClientCapabilities;
}

export interface McpFnClientProfile {
  id: string;
  version?: string;
  verifiedIdentity?: McpFnVerifiedClientIdentity;
  initialization: McpFnClientInitialization;
}

export interface McpFnClientProfileInput<TContext> {
  verifiedIdentity?: McpFnVerifiedClientIdentity;
  initialization: McpFnClientInitialization;
  context: TContext;
  extra: McpFnRequestExtra;
}

export interface McpFnClientProfileHooks<TContext> {
  verifiedIdentity?(context: TContext, extra: McpFnRequestExtra):
    McpFnVerifiedClientIdentity | undefined | Promise<McpFnVerifiedClientIdentity | undefined>;
  selectProfile?(input: McpFnClientProfileInput<TContext>):
    { id: string; version?: string } | Promise<{ id: string; version?: string }>;
  projectCatalog?(input: {
    tools: Tool[];
    profile: McpFnClientProfile;
    context: TContext;
    extra: McpFnRequestExtra;
  }): Tool[] | Promise<Tool[]>;
  enrichArguments?(input: {
    tool: Tool;
    arguments: Record<string, unknown>;
    profile: McpFnClientProfile;
    context: TContext;
    extra: McpFnRequestExtra;
  }): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export const MCPFN_GENERIC_CLIENT_PROFILE_ID = "mcpfn/generic";
