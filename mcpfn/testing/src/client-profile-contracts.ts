import { createHash } from "node:crypto";

import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpFnSchemaIssue } from "@mcpfn/core";
import type { McpFnTarget } from "@mcpfn/client";
import { redactOAuthValue } from "@superfunctions/oauth-core";

import { stableJson } from "./assertions.js";
import { McpFnTestClient, type McpFnTestClientOptions } from "./client.js";

export type McpFnFixtureSideEffect =
  | "read-only"
  | "idempotent"
  | "non-idempotent";

export interface McpFnClientProfileFixtureExpectation {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  errorCode?: string;
  lifecycleStage?: string;
  validationIssue?: Partial<
    Pick<
      McpFnSchemaIssue,
      | "instancePath"
      | "schemaPath"
      | "keyword"
      | "rejectedProperty"
      | "missingProperty"
    >
  >;
}

export interface McpFnClientProfileFixture {
  name: string;
  tool: string;
  /** Values are executed but never copied into compatibility reports. */
  arguments?: Record<string, unknown>;
  sideEffect: McpFnFixtureSideEffect;
  source?: "minimal-valid" | "captured-failure";
  expect?: McpFnClientProfileFixtureExpectation;
}

export interface McpFnSchemaPortabilityPolicy {
  /** Treat otherwise-valid compatibility-reducing keywords as failures. */
  warningsAsErrors?: boolean;
  /** Suppress warnings for explicitly reviewed keywords. */
  allowKeywords?: readonly string[];
}

export interface McpFnSchemaPortabilityIssue {
  severity: "error" | "warning";
  code:
    | "schema-invalid"
    | "schema-dialect-unsupported"
    | "schema-portability-warning";
  path: string;
  keyword?: string;
  message: string;
}

export interface McpFnClientProfileSnapshotTool {
  name: string;
  hash: string;
}

export interface McpFnClientProfileSnapshot {
  formatVersion: 1;
  kind: "mcpfn.client-profile-snapshot";
  profile: { id: string; version: string };
  catalogHash: string;
  tools: McpFnClientProfileSnapshotTool[];
}

export interface McpFnClientProfileSnapshotChange {
  kind: "added" | "removed" | "modified";
  tool: string;
  beforeHash?: string;
  afterHash?: string;
}

export interface McpFnClientProfileSnapshotDiff {
  compatible: boolean;
  changes: McpFnClientProfileSnapshotChange[];
  summary: { added: number; removed: number; modified: number };
}

export interface McpFnClientProfileContractCase {
  id: string;
  version: string;
  target: McpFnTarget;
  clientInfo?: Implementation;
  capabilities?: ClientCapabilities;
  client?: Omit<McpFnTestClientOptions, "capabilities">;
  fixtures?: readonly McpFnClientProfileFixture[];
  expectedSnapshot?: McpFnClientProfileSnapshot;
  portability?: McpFnSchemaPortabilityPolicy;
}

export interface RunMcpFnClientProfileContractsOptions {
  profiles: readonly McpFnClientProfileContractCase[];
  /** Explicit opt-in for fixtures that could mutate state. Defaults to false. */
  allowSideEffects?: boolean;
  /** Aggregate JSON size cap. Defaults to 1 MiB. */
  maxReportBytes?: number;
}

export interface McpFnClientProfileFixtureResult {
  name: string;
  tool: string;
  source: "minimal-valid" | "captured-failure";
  status: "passed" | "failed" | "incomplete";
  code?: string;
  error?: string;
}

export interface McpFnClientProfileContractResult {
  profile: { id: string; version: string };
  status: "complete" | "incomplete";
  ok: boolean;
  phase?: "connect" | "catalog" | "fixtures" | "close";
  snapshot?: McpFnClientProfileSnapshot;
  snapshotMatches?: boolean;
  portability: McpFnSchemaPortabilityIssue[];
  fixtures: McpFnClientProfileFixtureResult[];
  error?: string;
}

export interface McpFnClientProfileContractReport {
  formatVersion: 1;
  kind: "mcpfn.client-profile-contract-report";
  status: "complete" | "incomplete";
  ok: boolean;
  profiles: McpFnClientProfileContractResult[];
  droppedProfiles: number;
  incompleteReason?: string;
}

const PORTABILITY_KEYWORDS = new Set([
  "$dynamicAnchor",
  "$dynamicRef",
  "dependentSchemas",
  "prefixItems",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function boundedError(value: unknown): string {
  const redacted = String(
    redactOAuthValue(value instanceof Error ? value.message : value),
  );
  return redacted.slice(0, 512);
}

function assertProfileReference(id: string, version: string): void {
  for (const [label, value] of [
    ["id", id],
    ["version", version],
  ] as const) {
    if (typeof value !== "string" || !value || value.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(value)) {
      throw new Error(
        `Client profile ${label} must be a non-empty stable identifier`,
      );
    }
  }
}

export function createMcpFnClientProfileSnapshot(
  profile: { id: string; version: string },
  tools: readonly Tool[],
): McpFnClientProfileSnapshot {
  assertProfileReference(profile.id, profile.version);
  const normalized = [...tools]
    .map((tool) => structuredClone(tool))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  if (normalized.some((tool, index) => index > 0 && tool.name === normalized[index - 1].name)) {
    throw new Error("Effective catalog contains duplicate tool names");
  }
  return {
    formatVersion: 1,
    kind: "mcpfn.client-profile-snapshot",
    profile: { ...profile },
    catalogHash: hash(normalized),
    tools: normalized.map((tool) => ({ name: tool.name, hash: hash(tool) })),
  };
}

export function validateMcpFnClientProfileSnapshot(
  value: unknown,
): McpFnClientProfileSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Client profile snapshot must be an object");
  }
  const snapshot = value as Partial<McpFnClientProfileSnapshot>;
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.kind !== "mcpfn.client-profile-snapshot"
  ) {
    throw new Error("Unsupported client profile snapshot format");
  }
  if (!snapshot.profile)
    throw new Error("Client profile snapshot requires profile metadata");
  assertProfileReference(snapshot.profile.id, snapshot.profile.version);
  if (
    typeof snapshot.catalogHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.catalogHash)
  ) {
    throw new Error("Client profile snapshot requires a SHA-256 catalogHash");
  }
  if (!Array.isArray(snapshot.tools))
    throw new Error("Client profile snapshot tools must be an array");
  let prior = "";
  for (const tool of snapshot.tools) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !tool.name ||
      !/^[a-f0-9]{64}$/.test(tool.hash)
    ) {
      throw new Error("Client profile snapshot contains an invalid tool entry");
    }
    if (tool.name <= prior)
      throw new Error(
        "Client profile snapshot tools must be sorted and unique",
      );
    prior = tool.name;
  }
  return snapshot as McpFnClientProfileSnapshot;
}

export function diffMcpFnClientProfileSnapshots(
  beforeValue: unknown,
  afterValue: unknown,
): McpFnClientProfileSnapshotDiff {
  const before = validateMcpFnClientProfileSnapshot(beforeValue);
  const after = validateMcpFnClientProfileSnapshot(afterValue);
  if (before.profile.id !== after.profile.id) {
    throw new Error("Cannot diff snapshots for different client profile ids");
  }
  const beforeByName = new Map(
    before.tools.map((tool) => [tool.name, tool.hash]),
  );
  const afterByName = new Map(
    after.tools.map((tool) => [tool.name, tool.hash]),
  );
  const names = [
    ...new Set([...beforeByName.keys(), ...afterByName.keys()]),
  ].sort();
  const changes: McpFnClientProfileSnapshotChange[] = [];
  for (const tool of names) {
    const beforeHash = beforeByName.get(tool);
    const afterHash = afterByName.get(tool);
    if (!beforeHash) changes.push({ kind: "added", tool, afterHash });
    else if (!afterHash) changes.push({ kind: "removed", tool, beforeHash });
    else if (beforeHash !== afterHash) {
      changes.push({ kind: "modified", tool, beforeHash, afterHash });
    }
  }
  const summary = {
    added: changes.filter(({ kind }) => kind === "added").length,
    removed: changes.filter(({ kind }) => kind === "removed").length,
    modified: changes.filter(({ kind }) => kind === "modified").length,
  };
  return { compatible: summary.removed === 0, changes, summary };
}

function createDialectValidator(dialect: string) {
  const normalized = dialect.replace(/#$/, "");
  if (
    normalized === "http://json-schema.org/draft-07/schema" ||
    normalized === "https://json-schema.org/draft-07/schema"
  )
    return new Ajv({ allErrors: true, strict: false, validateFormats: false });
  if (
    normalized === "http://json-schema.org/draft/2019-09/schema" ||
    normalized === "https://json-schema.org/draft/2019-09/schema"
  )
    return new Ajv2019({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
  if (
    normalized === "http://json-schema.org/draft/2020-12/schema" ||
    normalized === "https://json-schema.org/draft/2020-12/schema"
  )
    return new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
  return undefined;
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function walkSchema(
  value: unknown,
  path: string,
  visit: (keyword: string, path: string) => void,
): void {
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  for (const keyword of Object.keys(schema)) {
    visit(keyword, `${path}/${pointerSegment(keyword)}`);
  }
  for (const mapKeyword of [
    "$defs",
    "definitions",
    "dependencies",
    "dependentSchemas",
    "patternProperties",
    "properties",
  ]) {
    const entries = schema[mapKeyword];
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      continue;
    for (const [name, child] of Object.entries(
      entries as Record<string, unknown>,
    )) {
      walkSchema(child, `${path}/${mapKeyword}/${pointerSegment(name)}`, visit);
    }
  }
  for (const arrayKeyword of ["allOf", "anyOf", "oneOf", "prefixItems", "items"]) {
    const entries = schema[arrayKeyword];
    if (!Array.isArray(entries)) continue;
    entries.forEach((child, index) =>
      walkSchema(child, `${path}/${arrayKeyword}/${index}`, visit),
    );
  }
  for (const schemaKeyword of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "contentSchema",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    const child = schema[schemaKeyword];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      walkSchema(child, `${path}/${schemaKeyword}`, visit);
    }
  }
}

export function validateMcpFnSchemaPortability(
  schema: unknown,
  path: string,
  policy: McpFnSchemaPortabilityPolicy = {},
): McpFnSchemaPortabilityIssue[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [
      {
        severity: "error",
        code: "schema-invalid",
        path,
        message: "Tool schema must be an object",
      },
    ];
  }
  const declared = (schema as Record<string, unknown>).$schema;
  const dialect =
    typeof declared === "string"
      ? declared
      : "https://json-schema.org/draft/2020-12/schema";
  const validator = createDialectValidator(dialect);
  if (!validator) {
    return [
      {
        severity: "error",
        code: "schema-dialect-unsupported",
        path: `${path}/$schema`,
        message: boundedError(`Unsupported JSON Schema dialect ${dialect}`),
      },
    ];
  }
  const issues: McpFnSchemaPortabilityIssue[] = [];
  try {
    validator.compile(schema);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "schema-invalid",
      path,
      message: boundedError(error),
    });
  }
  const allowed = new Set(policy.allowKeywords ?? []);
  walkSchema(schema, path, (keyword, keywordPath) => {
    if (!PORTABILITY_KEYWORDS.has(keyword) || allowed.has(keyword)) return;
    issues.push({
      severity: policy.warningsAsErrors ? "error" : "warning",
      code: "schema-portability-warning",
      path: keywordPath,
      keyword,
      message: `${keyword} is valid but may reduce client portability`,
    });
  });
  return issues.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function extractError(
  result: CallToolResult,
): Record<string, unknown> | undefined {
  const structured = result.structuredContent as
    | Record<string, unknown>
    | undefined;
  if (structured?.error && typeof structured.error === "object") {
    return structured.error as Record<string, unknown>;
  }
  const text = result.content.find((content) => content.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed.error && typeof parsed.error === "object"
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function fixtureFailure(
  result: CallToolResult,
  fixture: McpFnClientProfileFixture,
): string | undefined {
  const expected = fixture.expect;
  if (fixture.source === "captured-failure" && !result.isError) return "Captured failure did not reproduce an error";
  if (!expected)
    return result.isError ? "Tool returned isError=true" : undefined;
  if (
    expected.isError !== undefined &&
    Boolean(result.isError) !== expected.isError
  ) {
    return `Expected isError=${expected.isError}, received ${Boolean(result.isError)}`;
  }
  if (
    expected.structuredContent !== undefined &&
    stableJson(result.structuredContent) !==
      stableJson(expected.structuredContent)
  )
    return "Structured content did not match the fixture expectation";
  const error = extractError(result);
  if (expected.errorCode !== undefined && error?.code !== expected.errorCode) {
    return "Error code did not match the declared expectation";
  }
  const details =
    error?.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined;
  if (
    expected.lifecycleStage !== undefined &&
    details?.lifecycleStage !== expected.lifecycleStage
  )
    return `Expected lifecycle stage ${expected.lifecycleStage}`;
  if (expected.validationIssue) {
    const issues = Array.isArray(details?.issues)
      ? (details.issues as Record<string, unknown>[])
      : [];
    const matched = issues.some((issue) =>
      Object.entries(expected.validationIssue!).every(
        ([key, value]) => issue[key] === value,
      ),
    );
    if (!matched)
      return "Expected structured validation issue was not reported";
  }
  return undefined;
}

async function runProfileCase(
  profileCase: McpFnClientProfileContractCase,
  allowSideEffects: boolean,
): Promise<McpFnClientProfileContractResult> {
  const profile = { id: profileCase.id, version: profileCase.version };
  let client: McpFnTestClient | undefined;
  let result: McpFnClientProfileContractResult = {
    profile,
    status: "complete",
    ok: false,
    portability: [],
    fixtures: [],
  };
  try {
    try {
      client = await McpFnTestClient.connectTarget(
        profileCase.target,
        profileCase.clientInfo ?? {
          name: "mcpfn-profile-suite",
          version: "1.0.0",
        },
        { ...profileCase.client, capabilities: profileCase.capabilities },
      );
    } catch (error) {
      return { ...result, phase: "connect", error: boundedError(error) };
    }
    let tools: Tool[] | undefined;
    try {
      tools = await client.listTools();
      const repeatedTools = await client.listTools();
      if (stableJson(tools) !== stableJson(repeatedTools)) {
        throw new Error(
          "Effective catalog changed across identical profile list requests",
        );
      }
      result.snapshot = createMcpFnClientProfileSnapshot(profile, tools);
      result.snapshotMatches = profileCase.expectedSnapshot
        ? stableJson(result.snapshot) ===
          stableJson(profileCase.expectedSnapshot)
        : undefined;
      for (const tool of tools) {
        result.portability.push(
          ...validateMcpFnSchemaPortability(
            tool.inputSchema,
            `tools/${tool.name}/inputSchema`,
            profileCase.portability,
          ),
        );
        if (tool.outputSchema) {
          result.portability.push(
            ...validateMcpFnSchemaPortability(
              tool.outputSchema,
              `tools/${tool.name}/outputSchema`,
              profileCase.portability,
            ),
          );
        }
      }
    } catch (error) {
      tools = undefined;
      result = { ...result, phase: "catalog", error: boundedError(error) };
    }
    if (tools) {
      const advertised = new Set(tools.map(({ name }) => name));
      for (const fixture of profileCase.fixtures ?? []) {
        const base = {
          name: fixture.name,
          tool: fixture.tool,
          source: fixture.source ?? ("minimal-valid" as const),
        };
        if (!advertised.has(fixture.tool)) {
          result.fixtures.push({
            ...base,
            status: "failed",
            code: "fixture-tool-not-advertised",
            error:
              "Fixture references a tool absent from the effective catalog",
          });
          continue;
        }
        if (fixture.sideEffect !== "read-only" && !allowSideEffects) {
          result.fixtures.push({
            ...base,
            status: "incomplete",
            code: "side-effect-not-authorized",
            error:
              "Fixture was not executed because side effects were not explicitly allowed",
          });
          continue;
        }
        try {
          const callResult = await client.callTool(
            fixture.tool,
            fixture.arguments ?? {},
          );
          const failure = fixtureFailure(callResult, fixture);
          result.fixtures.push(
            failure
              ? {
                  ...base,
                  status: "failed",
                  code: "fixture-expectation-failed",
                  error: failure,
                }
              : { ...base, status: "passed" },
          );
        } catch (error) {
          result.fixtures.push({
            ...base,
            status: "failed",
            code: "fixture-call-failed",
            error: "Tool invocation failed; argument values and exception text are omitted",
          });
        }
      }
      const incomplete = result.fixtures.some(
        ({ status }) => status === "incomplete",
      );
      const failed =
        result.fixtures.some(({ status }) => status === "failed") ||
        result.portability.some(({ severity }) => severity === "error") ||
        result.snapshotMatches === false;
      result = {
        ...result,
        phase: result.snapshotMatches === false || result.portability.some(({ severity }) => severity === "error")
          ? "catalog" : failed || incomplete ? "fixtures" : undefined,
        status: incomplete ? "incomplete" : "complete",
        ok: !failed && !incomplete,
        ...(result.snapshotMatches === false
          ? {
              error:
                "Effective catalog does not match the reviewed profile snapshot",
            }
          : {}),
      };
    }
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (error) {
        result = {
          ...result,
          ok: false,
          phase: result.phase ?? "close",
          error: result.error ? `${result.error}; target cleanup failed`.slice(0, 512) : "Target cleanup failed",
        };
      }
    }
  }
  return result;
}

/** Exercise every profile through the production target/client list-and-call lifecycle. */
export async function runMcpFnClientProfileContracts(
  options: RunMcpFnClientProfileContractsOptions,
): Promise<McpFnClientProfileContractReport> {
  const maxReportBytes = options.maxReportBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes < 2_048) {
    throw new Error("maxReportBytes must be an integer of at least 2048");
  }
  if (!Array.isArray(options.profiles) || options.profiles.length === 0) {
    throw new Error(
      "At least one generic or configured client profile is required",
    );
  }
  if (options.profiles.length > 100)
    throw new Error("At most 100 client profiles may be tested");
  const keys = new Set<string>();
  for (const profile of options.profiles) {
    assertProfileReference(profile.id, profile.version);
    const key = `${profile.id}@${profile.version}`;
    if (keys.has(key)) throw new Error(`Duplicate client profile case ${key}`);
    keys.add(key);
    if (profile.expectedSnapshot)
      validateMcpFnClientProfileSnapshot(profile.expectedSnapshot);
    for (const fixture of profile.fixtures ?? []) {
      if (fixture.source === "captured-failure" && (!fixture.expect || fixture.expect.isError === false ||
          !(fixture.expect.isError === true || fixture.expect.errorCode || fixture.expect.lifecycleStage ||
            (fixture.expect.validationIssue && Object.keys(fixture.expect.validationIssue).length)))) {
        throw new Error(`Captured-failure fixture ${fixture.name} requires meaningful error expectations`);
      }
      if (!fixture.name || !fixture.tool || !["read-only", "idempotent", "non-idempotent"].includes(fixture.sideEffect)) {
        throw new Error(`Client profile ${key} contains an invalid fixture`);
      }
    }
  }
  const profiles: McpFnClientProfileContractResult[] = [];
  for (const profile of [...options.profiles].sort((left, right) => {
    const leftKey = `${left.id}@${left.version}`;
    const rightKey = `${right.id}@${right.version}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    profiles.push(
      await runProfileCase(profile, options.allowSideEffects === true),
    );
  }
  const report: McpFnClientProfileContractReport = {
    formatVersion: 1,
    kind: "mcpfn.client-profile-contract-report",
    status: profiles.some(({ status }) => status === "incomplete")
      ? "incomplete"
      : "complete",
    ok: profiles.every(({ ok }) => ok),
    profiles,
    droppedProfiles: 0,
  };
  if (
    new TextEncoder().encode(JSON.stringify(report)).byteLength <=
    maxReportBytes
  )
    return report;
  report.ok = false;
  report.status = "incomplete";
  report.incompleteReason =
    "Report content exceeded maxReportBytes and was truncated";
  while (
    new TextEncoder().encode(JSON.stringify(report)).byteLength >
      maxReportBytes &&
    report.profiles.length > 0
  ) {
    report.profiles.pop();
    report.droppedProfiles += 1;
  }
  if (
    new TextEncoder().encode(JSON.stringify(report)).byteLength > maxReportBytes
  ) {
    throw new Error("The minimum client profile report exceeds maxReportBytes");
  }
  return report;
}
