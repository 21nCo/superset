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
  /** Defaults to true. Set false only when hooks do not use initialization metadata. */
  requiresReportedClient?: boolean;
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
    if (typeof value !== "string" || !value || value.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(value)) {
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
    if (!profile || typeof profile !== "object" || typeof profile.matches !== "function") {
      throw new McpFnClientProfileError("MCPFN_INVALID_CLIENT_PROFILE", "Profiles require metadata and a matcher");
    }
    assertProfileMetadata(profile as McpFnClientProfile<unknown>);
    const ownership = profile.serverOwnedArguments;
    if (ownership !== undefined && (!ownership || typeof ownership !== "object" || Array.isArray(ownership) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(ownership)) ||
        Object.entries(ownership).some(([tool, names]) => !tool || !Array.isArray(names) ||
          names.some((name) => typeof name !== "string" || !name || ["__proto__", "constructor", "prototype"].includes(name)) ||
          new Set(names).size !== names.length))) {
      throw new McpFnClientProfileError("MCPFN_INVALID_CLIENT_PROFILE", "Server-owned arguments must map tools to unique root property names");
    }
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
  if (typeof verifiedIdentity.subject !== "string" || !verifiedIdentity.subject || verifiedIdentity.subject.length > 256) {
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
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" ||
        !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || tool.inputSchema.type !== "object") {
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
    const ownedFields = new Set(profile.serverOwnedArguments?.[visibleTool.name] ?? []);
    const canonicalShape = rootShape(canonicalTool.inputSchema, ownedFields);
    const visibleShape = rootShape(visibleTool.inputSchema, ownedFields);
    const canonicalProperties = canonicalShape.properties;
    const canonicalRequired = canonicalShape.required;
    const visibleProperties = visibleShape.properties;
    const visibleRequired = visibleShape.required;
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
    const ownedFields = new Set(profile.serverOwnedArguments?.[visibleTool.name] ?? []);
    const canonicalShape = rootShape(canonicalTool.inputSchema, ownedFields);
    const visibleShape = rootShape(visibleTool.inputSchema, ownedFields);
    const visibleRequired = visibleShape.required;
    const visibleProperties = visibleShape.properties;
    const owned = new Set(
      profile.serverOwnedArguments?.[visibleTool.name] ?? [],
    );
    if (owned.size && (canonicalShape.ownershipSensitive || visibleShape.ownershipSensitive)) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Server-owned fields cannot be hidden under conditional or whole-object constraints");
    }
    for (const name of Object.keys(canonicalShape.properties)) {
      if (!owned.has(name) && !Object.hasOwn(visibleProperties, name)) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Projected catalog hides ${visibleTool.name}.${name} without trusted enrichment`,
          { tool: visibleTool.name, property: name },
        );
      }
    }
    for (const [name, schema] of Object.entries(visibleProperties)) {
      if (!Object.hasOwn(canonicalShape.properties, name) || canonicalJson(schema) !== canonicalJson(canonicalShape.properties[name])) {
        throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", `Projected model-owned property ${visibleTool.name}.${name} must retain its canonical schema`);
      }
    }
    if ([...visibleRequired].some((name) => !canonicalShape.required.has(name))) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Projected catalogs cannot add required model-owned fields");
    }
    for (const required of canonicalShape.required) {
      if (owned.has(required)) continue;
      if (
        !visibleRequired.has(required)
      ) {
        throw new McpFnClientProfileError(
          "MCPFN_PROFILE_ASYMMETRIC",
          `Projected catalog weakens required ${visibleTool.name}.${required} without trusted enrichment`,
          { tool: visibleTool.name, property: required },
        );
      }
    }
    if (canonicalJson(canonicalShape.constraints) !== canonicalJson(visibleShape.constraints) ||
        canonicalJson(canonicalTool.outputSchema) !== canonicalJson(visibleTool.outputSchema) ||
        taskSupport(canonicalTool) !== taskSupport(visibleTool)) {
      throw new McpFnClientProfileError("MCPFN_PROFILE_ASYMMETRIC", "Projected tools must preserve root constraints, output schemas and task support");
    }

  }
}

export async function buildMcpFnEffectiveCatalog<TContext>(input: {
  canonicalTools: McpFnListedTool[];
  /** Complete registry inventory when canonicalTools has already been visibility-filtered. */
  knownTools?: McpFnListedTool[];
  resolved: McpFnResolvedClientProfile<TContext>;
}): Promise<{ tools: McpFnListedTool[]; changes: McpFnCatalogChange[] }> {
  const canonicalTools = structuredClone(input.canonicalTools);
  const knownTools = structuredClone(input.knownTools ?? input.canonicalTools);
  const profile = input.resolved.profile;
  if (!profile) return { tools: canonicalTools, changes: [] };
  assertTrustedProfileIdentity(input.resolved);
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
  assertProjectedCatalog(
    canonicalTools,
    knownTools,
    projected,
    profile as McpFnClientProfile<unknown>,
  );
  const tools = structuredClone(projected).sort((left, right) => compareCodeUnits(left.name, right.name));
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
  assertTrustedProfileIdentity(input.resolved);
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

function assertTrustedProfileIdentity<T>(resolved: McpFnResolvedClientProfile<T>): void {
  if (typeof resolved.verifiedIdentity?.subject !== "string" || !resolved.verifiedIdentity.subject) {
    throw new McpFnClientProfileError("MCPFN_INVALID_VERIFIED_IDENTITY", "A resolved profile requires a verified identity");
  }
}

function taskSupport(tool: McpFnListedTool): string {
  if (tool.execution === undefined) return "forbidden";
  if (!tool.execution || typeof tool.execution !== "object" || Array.isArray(tool.execution) ||
      (tool.execution.taskSupport !== undefined && !["forbidden", "optional", "required"].includes(tool.execution.taskSupport))) {
    throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Invalid task execution metadata");
  }
  return tool.execution.taskSupport === undefined ? "forbidden" : tool.execution.taskSupport;
}

/** Resolve only root object composition; never traverse argument values. */
function rootShape(root: Record<string, unknown>, owned = new Set<string>()): { properties: Record<string, unknown>; required: Set<string>; constraints: string[]; ownershipSensitive: boolean } {
  const properties: Record<string, unknown> = Object.create(null);
  const required = new Set<string>();
  const constraints = new Set<string>();
  let ownershipSensitive = false;
  const seen = new Set<unknown>();
  // A fragment is relative to its nearest schema resource, including nested $id roots.
  const resources = new WeakMap<object, Record<string, unknown>>();
  const index = (value: unknown, resource: Record<string, unknown>) => {
    if (!value || typeof value !== "object" || resources.has(value)) return;
    if (!Array.isArray(value) && typeof (value as Record<string, unknown>).$id === "string") resource = value as Record<string, unknown>;
    resources.set(value, resource);
    for (const child of Object.values(value)) index(child, resource);
  };
  index(root, root);
  const referenceTarget = (schema: Record<string, unknown>): unknown => {
    let pointer: string;
    try { pointer = decodeURIComponent((schema.$ref as string).slice(1)); }
    catch { throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Invalid schema reference encoding"); }
    let target: unknown = resources.get(schema) ?? root;
    for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = target && typeof target === "object" && Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
    }
    if (target === undefined) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Unresolved schema reference");
    return target;
  };
  // Compare referenced schemas as well as pointer strings. Track resource targets
  // rather than fragment text: identical fragments can name different resources.
  const resolveProperty = (value: unknown, refs = new Set<unknown>()): unknown => {
    if (Array.isArray(value)) return value.map(child => resolveProperty(child, refs));
    if (!value || typeof value !== "object") return value;
    const schema = value as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(schema).map(([key, child]) => [key, resolveProperty(child, refs)]));
    if (typeof schema.$ref === "string" && (schema.$ref === "#" || schema.$ref.startsWith("#/"))) {
      const target = referenceTarget(schema);
      if (!refs.has(target)) result.$ref = resolveProperty(target, new Set([...refs, target]));
    }
    return result;
  };
  // Sort whole branches, retaining the association between their fields and constraints.
  const branchKey = (value: unknown): string => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return canonicalJson(value);
    const schema = value as Record<string, unknown>;
    const shape: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema)) {
      if (["title", "description", "$comment", "examples", "$defs", "definitions"].includes(key)) continue;
      if (key === "properties" && child && typeof child === "object") {
        shape[key] = Object.fromEntries(Object.entries(child).filter(([name]) => !owned.has(name)).map(([name, item]) => [name, resolveProperty(item)]));
      } else if (key === "required" && Array.isArray(child)) {
        shape[key] = child.filter(name => !owned.has(name)).sort(compareCodeUnits);
      } else if (key === "allOf" && Array.isArray(child)) {
        shape[key] = child.map(branchKey).sort(compareCodeUnits);
      } else shape[key] = child;
    }
    return canonicalJson(shape);
  };
  const visit = (value: unknown, path = "root") => {
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    const schema = value as Record<string, unknown>;
    const branchProperties = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties).filter(name => !owned.has(name)).sort(compareCodeUnits) : [];
    const branchRequired = Array.isArray(schema.required) ? schema.required.filter(name => typeof name === "string" && !owned.has(name)).sort(compareCodeUnits) : [];
    constraints.add(canonicalJson({ path, properties: branchProperties, required: branchRequired }));
    for (const [key, value] of Object.entries(schema)) {
      if (["dependencies", "dependentRequired", "dependentSchemas", "if", "then", "else", "anyOf", "oneOf", "not", "const", "enum", "minProperties", "maxProperties", "unevaluatedProperties"].includes(key)) ownershipSensitive = true;
      if (!["properties", "required", "allOf", "$ref", "$defs", "definitions", "title", "description", "$comment", "examples"].includes(key)) {
        constraints.add(canonicalJson({ path, [key]: resolveProperty(value) }));
      }
    }
    if (typeof schema.$ref === "string") {
      if (schema.$ref !== "#" && !schema.$ref.startsWith("#/")) throw new McpFnClientProfileError("MCPFN_INVALID_PROJECTED_CATALOG", "Profile root references must be local JSON pointers");
      visit(referenceTarget(schema), `${path}/$ref`);
    }
    if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) {
        const resolved = resolveProperty(child);
        if (Object.hasOwn(properties, name) && canonicalJson(properties[name]) !== canonicalJson(resolved)) {
          properties[name] = { allOf: [properties[name], resolved] };
        } else properties[name] = resolved;
      }
    }
    if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === "string") required.add(name);
    if (Array.isArray(schema.allOf)) [...schema.allOf].sort((left, right) => compareCodeUnits(branchKey(left), branchKey(right))).forEach((child, index) => visit(child, `${path}/allOf/${index}`));
  };
  visit(root);
  return { properties, required, constraints: [...constraints].sort(compareCodeUnits), ownershipSensitive };
}
