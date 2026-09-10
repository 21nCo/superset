import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { canonicalJson, compareCodeUnits, sha256 } from "./canonical.js";
import { McpFnClientProfileError } from "./errors.js";
import type {
  McpFnListedTool,
  McpFnReportedClient,
  McpFnRequestExtra,
  McpFnSchemaIssue,
} from "./types.js";

export interface McpFnVerifiedClientIdentity {
  /** Stable authenticated subject. Never derived from initialize.clientInfo. */
  subject: string;
  /** Optional non-secret attributes used by product-owned profile selection. */
  attributes?: Record<string, string | number | boolean | null>;
}

export interface McpFnClientProfileHookInput<TContext> {
  context: TContext;
  extra: McpFnRequestExtra;
  verifiedIdentity: McpFnVerifiedClientIdentity;
  reportedClient: McpFnReportedClient;
}

export interface McpFnClientProfileCatalogInput<TContext>
  extends McpFnClientProfileHookInput<TContext> {
  tools: McpFnListedTool[];
}

export interface McpFnClientProfileCallInput<TContext>
  extends McpFnClientProfileHookInput<TContext> {
  tool: McpFnListedTool;
  arguments: Record<string, unknown>;
}

export interface McpFnClientProfile<TContext = undefined> {
  id: string;
  version: string;
  /** Selection is deliberately restricted to verified identity. */
  matches(identity: McpFnVerifiedClientIdentity): boolean | Promise<boolean>;
  projectCatalog?(
    input: McpFnClientProfileCatalogInput<TContext>,
  ): Tool[] | Promise<Tool[]>;
  /** Root argument names owned by the server for each tool. */
  serverOwnedArguments?: Readonly<Record<string, readonly string[]>>;
  enrichArguments?(
    input: McpFnClientProfileCallInput<TContext>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type McpFnClientProfileLifecycleStage =
  | "profile-resolution"
  | "catalog-projection"
  | "argument-enrichment"
  | "input-validation"
  | "handler"
  | "output-validation";

export interface McpFnClientProfileEvidence {
  formatVersion: 1;
  stage: McpFnClientProfileLifecycleStage;
  outcome: "started" | "succeeded" | "failed";
  profile?: { id: string; version: string };
  tool?: string;
  code?: string;
  issues?: McpFnSchemaIssue[];
}

export interface McpFnClientProfilesOptions<TContext = undefined> {
  profiles: readonly McpFnClientProfile<TContext>[];
  resolveVerifiedIdentity(input: {
    context: TContext;
    extra: McpFnRequestExtra;
  }):
    | McpFnVerifiedClientIdentity
    | undefined
    | Promise<McpFnVerifiedClientIdentity | undefined>;
  evidence?(event: McpFnClientProfileEvidence): void | Promise<void>;
}

export interface McpFnCatalogChange {
  kind: "removed" | "modified";
  path: string;
  tool: string;
  beforeHash: string;
  afterHash?: string;
}

export interface McpFnResolvedClientProfile<TContext> {
  context: TContext;
  extra: McpFnRequestExtra;
  verifiedIdentity?: McpFnVerifiedClientIdentity;
  reportedClient: McpFnReportedClient;
  profile?: McpFnClientProfile<TContext>;
}

function assertProfileMetadata(profile: McpFnClientProfile<unknown>): void {
  for (const [label, value] of [
    ["id", profile.id],
    ["version", profile.version],
  ] as const) {
    if (!value || value.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(value)) {
      throw new McpFnClientProfileError(
        "MCPFN_INVALID_CLIENT_PROFILE",
        `Client profile ${label} must be a non-empty stable identifier`,
      );
    }
  }
}

export function validateMcpFnClientProfiles<TContext>(
  options: McpFnClientProfilesOptions<TContext>,
): void {
  const ids = new Set<string>();
  for (const profile of options.profiles) {
    assertProfileMetadata(profile as McpFnClientProfile<unknown>);
    const key = `${profile.id}@${profile.version}`;
    if (ids.has(key)) {
      throw new McpFnClientProfileError(
        "MCPFN_DUPLICATE_CLIENT_PROFILE",
        `Duplicate client profile ${key}`,
      );
    }
    ids.add(key);
    if (
      Object.keys(profile.serverOwnedArguments ?? {}).length &&
      !profile.enrichArguments
    ) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ENRICHER_REQUIRED",
        `Client profile ${key} declares server-owned arguments without an enricher`,
      );
    }
  }
}

export async function resolveMcpFnClientProfile<TContext>(
  options: McpFnClientProfilesOptions<TContext>,
  input: Omit<
    McpFnResolvedClientProfile<TContext>,
    "verifiedIdentity" | "profile"
  >,
): Promise<McpFnResolvedClientProfile<TContext>> {
  const verifiedIdentity = await options.resolveVerifiedIdentity({
    context: input.context,
    extra: input.extra,
  });
  if (!verifiedIdentity) return { ...input, verifiedIdentity };
  if (!verifiedIdentity.subject || verifiedIdentity.subject.length > 256) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_VERIFIED_IDENTITY",
      "Verified client identity must contain a bounded subject",
    );
  }
  const matches: McpFnClientProfile<TContext>[] = [];
  for (const profile of options.profiles) {
    if (await profile.matches(verifiedIdentity)) matches.push(profile);
  }
  if (matches.length > 1) {
    throw new McpFnClientProfileError(
      "MCPFN_AMBIGUOUS_CLIENT_PROFILE",
      "Verified client identity matched multiple client profiles",
      { profiles: matches.map(({ id, version }) => ({ id, version })) },
    );
  }
  return { ...input, verifiedIdentity, profile: matches[0] };
}

function assertProjectedCatalog(
  canonicalTools: McpFnListedTool[],
  knownTools: McpFnListedTool[],
  projectedTools: McpFnListedTool[],
  profile: McpFnClientProfile<unknown>,
): void {
  const canonical = new Map(canonicalTools.map((tool) => [tool.name, tool]));
  const known = new Map(knownTools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  for (const tool of projectedTools) {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
      throw new McpFnClientProfileError(
        "MCPFN_INVALID_PROJECTED_CATALOG",
        "Projected catalogs may contain only MCP tool definitions",
      );
    }
    if (!canonical.has(tool.name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROJECTED_TOOL_UNKNOWN",
        `Client profile ${profile.id} projected unknown tool ${tool.name}`,
        { tool: tool.name },
      );
    }
    if (seen.has(tool.name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROJECTED_TOOL_DUPLICATE",
        `Client profile ${profile.id} projected duplicate tool ${tool.name}`,
        { tool: tool.name },
      );
    }
    seen.add(tool.name);
  }

  for (const [toolName, ownedNames] of Object.entries(
    profile.serverOwnedArguments ?? {},
  )) {
    const canonicalTool = known.get(toolName);
    if (!canonicalTool) {
      throw new McpFnClientProfileError(
        "MCPFN_SERVER_ARGUMENT_TOOL_UNKNOWN",
        `Client profile ${profile.id} declares server-owned arguments for unknown tool ${toolName}`,
        { tool: toolName },
      );
    }
    if (!canonical.has(toolName)) continue;
    const visibleTool = projectedTools.find((tool) => tool.name === toolName);
    if (!visibleTool) continue;
    const canonicalProperties = canonicalTool.inputSchema.properties ?? {};
    const canonicalRequired = new Set(canonicalTool.inputSchema.required ?? []);
    const visibleProperties = visibleTool.inputSchema.properties ?? {};
    const visibleRequired = new Set(visibleTool.inputSchema.required ?? []);
    for (const name of new Set(ownedNames)) {
      if (
        !Object.hasOwn(canonicalProperties, name) ||
        !canonicalRequired.has(name)
      ) {
        throw new McpFnClientProfileError(
          "MCPFN_SERVER_ARGUMENT_NOT_REQUIRED",
          `Server-owned argument ${toolName}.${name} must be a canonical required property`,
          { tool: toolName, property: name },
        );
      }
      if (Object.hasOwn(visibleProperties, name) || visibleRequired.has(name)) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Server-owned argument ${toolName}.${name} remains model-visible`,
          { tool: toolName, property: name },
        );
      }
    }
  }

  for (const visibleTool of projectedTools) {
    const canonicalTool = canonical.get(visibleTool.name)!;
    const visibleRequired = new Set(visibleTool.inputSchema.required ?? []);
    const visibleProperties = visibleTool.inputSchema.properties ?? {};
    const owned = new Set(
      profile.serverOwnedArguments?.[visibleTool.name] ?? [],
    );
    for (const required of canonicalTool.inputSchema.required ?? []) {
      if (owned.has(required)) continue;
      if (
        !visibleRequired.has(required) ||
        !Object.hasOwn(visibleProperties, required)
      ) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Projected catalog weakens required ${visibleTool.name}.${required} without trusted enrichment`,
          { tool: visibleTool.name, property: required },
        );
      }
    }
  }
}

export async function buildMcpFnEffectiveCatalog<TContext>(input: {
  canonicalTools: McpFnListedTool[];
  /** Complete registry inventory when canonicalTools has already been visibility-filtered. */
  knownTools?: McpFnListedTool[];
  resolved: McpFnResolvedClientProfile<TContext>;
}): Promise<{ tools: McpFnListedTool[]; changes: McpFnCatalogChange[] }> {
  const canonicalTools = structuredClone(input.canonicalTools).sort(
    (left, right) => compareCodeUnits(left.name, right.name),
  );
  const knownTools = structuredClone(input.knownTools ?? input.canonicalTools);
  const profile = input.resolved.profile;
  if (!profile) return { tools: canonicalTools, changes: [] };
  const projected = profile.projectCatalog
    ? await profile.projectCatalog({
        context: input.resolved.context,
        extra: input.resolved.extra,
        verifiedIdentity: input.resolved.verifiedIdentity!,
        reportedClient: input.resolved.reportedClient,
        tools: structuredClone(canonicalTools),
      })
    : canonicalTools;
  if (!Array.isArray(projected)) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_PROJECTED_CATALOG",
      `Client profile ${profile.id} did not return a tool array`,
    );
  }
  const tools = structuredClone(projected).sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  assertProjectedCatalog(
    canonicalTools,
    knownTools,
    tools,
    profile as McpFnClientProfile<unknown>,
  );
  const projectedByName = new Map(tools.map((tool) => [tool.name, tool]));
  const changes: McpFnCatalogChange[] = [];
  for (const canonical of canonicalTools) {
    const effective = projectedByName.get(canonical.name);
    if (!effective) {
      changes.push({
        kind: "removed",
        path: `tools.${canonical.name}`,
        tool: canonical.name,
        beforeHash: sha256(canonical),
      });
    } else if (canonicalJson(canonical) !== canonicalJson(effective)) {
      changes.push({
        kind: "modified",
        path: `tools.${canonical.name}`,
        tool: canonical.name,
        beforeHash: sha256(canonical),
        afterHash: sha256(effective),
      });
    }
  }
  return { tools, changes };
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpFnClientProfileError(
      "MCPFN_INVALID_PROFILE_ARGUMENTS",
      "Tool arguments must be an object before trusted enrichment",
    );
  }
  return value as Record<string, unknown>;
}

export async function enrichMcpFnClientProfileCall<TContext>(input: {
  resolved: McpFnResolvedClientProfile<TContext>;
  tool: McpFnListedTool;
  arguments: unknown;
}): Promise<Record<string, unknown>> {
  const original = objectArguments(input.arguments ?? {});
  const profile = input.resolved.profile;
  if (!profile) return original;
  const owned = new Set(profile.serverOwnedArguments?.[input.tool.name] ?? []);
  for (const name of owned) {
    if (Object.hasOwn(original, name)) {
      throw new McpFnClientProfileError(
        "MCPFN_FORGED_SERVER_ARGUMENT",
        `Model arguments may not provide server-owned property ${name}`,
        { tool: input.tool.name, rejectedProperty: name },
      );
    }
  }
  if (!profile.enrichArguments) return original;
  const enriched = objectArguments(
    await profile.enrichArguments({
      context: input.resolved.context,
      extra: input.resolved.extra,
      verifiedIdentity: input.resolved.verifiedIdentity!,
      reportedClient: input.resolved.reportedClient,
      tool: structuredClone(input.tool),
      arguments: structuredClone(original),
    }),
  );
  for (const [name, value] of Object.entries(original)) {
    if (owned.has(name)) continue;
    if (
      !Object.hasOwn(enriched, name) ||
      canonicalJson(enriched[name]) !== canonicalJson(value)
    ) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ARGUMENT_MUTATION",
        `Trusted enrichment may not alter model-owned property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  for (const name of Object.keys(enriched)) {
    if (!Object.hasOwn(original, name) && !owned.has(name)) {
      throw new McpFnClientProfileError(
        "MCPFN_PROFILE_ARGUMENT_MUTATION",
        `Trusted enrichment added undeclared property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  for (const name of owned) {
    if (!Object.hasOwn(enriched, name)) {
      throw new McpFnClientProfileError(
        "MCPFN_MISSING_TRUSTED_CONTEXT",
        `Trusted enrichment did not provide server-owned property ${name}`,
        { tool: input.tool.name, property: name },
      );
    }
  }
  return enriched;
}
