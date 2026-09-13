import { digestJson } from "./canonical.js";
import { ReviewFnError } from "./errors.js";
import type { FindingSeverity, Requirement, ReviewFnConfig, ReviewPolicy } from "./types.js";

const categories = new Set<Requirement["category"]>(["behavior", "architecture", "compatibility", "test", "migration", "documentation", "non_goal", "other"]);
const severities = new Set<FindingSeverity>(["critical", "high", "medium", "low", "info"]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `${name} contains unknown fields: ${unknown.join(", ")}.`);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `${name} must be a positive integer.`);
  return value as number;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `${name} must be an array of non-empty strings.`);
  }
  return value;
}

export function validateConfig(input: unknown): ReviewFnConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Configuration must be an object.");
  const value = input as Record<string, unknown>;
  rejectUnknown(value, ["version", "profile", "harness", "inference", "context", "review", "execution", "output", "retention", "fallback"], "configuration");
  if (value.version !== 1) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Only configuration version 1 is supported.");
  const config = structuredClone(value) as unknown as ReviewFnConfig;
  if (!config.profile || typeof config.profile !== "string") throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "profile is required.");
  if (!config.harness || typeof config.harness.adapter !== "string" || typeof config.harness.version !== "string") throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "harness.adapter and harness.version are required.");
  rejectUnknown(object(config.harness, "harness"), ["adapter", "version", "executable"], "harness");
  if (!config.inference || !config.inference.provider || !config.inference.model || !config.inference.auth) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "inference provider, model, and auth are required.");
  rejectUnknown(object(config.inference, "inference"), ["provider", "model", "auth", "credentialEnv"], "inference");
  if (!Array.isArray(config.context) || config.context.length === 0) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "At least one context adapter is required.");
  for (const [index, item] of config.context.entries()) {
    rejectUnknown(object(item, `context[${index}]`), ["adapter", "account", "expectedWorkspace", "issue", "paths"], `context[${index}]`);
    if (!item.adapter || typeof item.adapter !== "string") throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `context[${index}].adapter is required.`);
    if (item.paths !== undefined) strings(item.paths, `context[${index}].paths`);
  }
  if (!config.review || !Array.isArray(config.review.categories) || config.review.categories.some((entry) => !categories.has(entry))) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "review.categories contains an unsupported category.");
  rejectUnknown(object(config.review, "review"), ["categories", "evidenceRequired"], "review");
  if (!config.execution || typeof config.execution.adapter !== "string" || !Array.isArray(config.execution.tests)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "execution adapter and tests are required.");
  rejectUnknown(object(config.execution, "execution"), ["adapter", "tests", "timeoutMs", "maxOutputBytes"], "execution");
  for (const [index, command] of config.execution.tests.entries()) strings(command, `execution.tests[${index}]`);
  positiveInteger(config.execution.timeoutMs, "execution.timeoutMs");
  positiveInteger(config.execution.maxOutputBytes, "execution.maxOutputBytes");
  if (!config.output || !Array.isArray(config.output.destinations) || !["advisory", "gate"].includes(config.output.mode)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "output destinations and mode are required.");
  rejectUnknown(object(config.output, "output"), ["destinations", "mode"], "output");
  if (config.output.mode !== "advisory") throw new ReviewFnError("REVIEWFN_GATE_NOT_AUTHORIZED", "ReviewFn 0.1 is advisory-only; gate mode requires a separately calibrated and authorized release.");
  if (config.output.destinations.some((entry) => !["local", "github"].includes(entry))) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "output.destinations contains an unsupported destination.");
  if (!config.retention) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "retention is required.");
  rejectUnknown(object(config.retention, "retention"), ["reportDays", "transcriptDays", "testLogDays"], "retention");
  positiveInteger(config.retention.reportDays, "retention.reportDays");
  positiveInteger(config.retention.transcriptDays, "retention.transcriptDays");
  positiveInteger(config.retention.testLogDays, "retention.testLogDays");
  if (!Array.isArray(config.fallback)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "fallback must be an array.");
  for (const [index, fallback] of config.fallback.entries()) {
    rejectUnknown(object(fallback, `fallback[${index}]`), ["harness", "provider", "model", "auth"], `fallback[${index}]`);
    for (const key of ["harness", "provider", "model", "auth"] as const) if (!fallback[key]) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `fallback[${index}].${key} is required.`);
  }
  return config;
}

export function validatePolicy(input: unknown): ReviewPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Policy must be an object.");
  rejectUnknown(input as Record<string, unknown>, ["version", "mode", "requiredCategories", "blockingSeverities", "allowRepositoryTightening", "sourceAuthority", "limits", "retention"], "policy");
  const policy = structuredClone(input) as ReviewPolicy;
  if (policy.version !== 1 || !["advisory", "gate"].includes(policy.mode)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Unsupported policy version or mode.");
  if (policy.mode !== "advisory") throw new ReviewFnError("REVIEWFN_GATE_NOT_AUTHORIZED", "ReviewFn 0.1 policy is advisory-only; gate mode requires a separately calibrated and authorized release.");
  if (!Array.isArray(policy.requiredCategories) || policy.requiredCategories.some((entry) => !categories.has(entry))) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Policy has an unsupported required category.");
  if (!Array.isArray(policy.blockingSeverities) || policy.blockingSeverities.some((entry) => !severities.has(entry))) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Policy has an unsupported blocking severity.");
  rejectUnknown(object(policy.sourceAuthority, "sourceAuthority"), ["acceptedTypes", "commentsMayClarify", "waiverAuthorities"], "sourceAuthority");
  rejectUnknown(object(policy.limits, "limits"), ["contextMaxSources", "contextMaxBytes", "contextMaxDepth", "harnessTimeoutMs", "testTimeoutMs", "maxOutputBytes", "maxFindings"], "limits");
  rejectUnknown(object(policy.retention, "retention"), ["reportDays", "transcriptDays", "testLogDays"], "retention");
  for (const [name, value] of Object.entries(policy.limits)) positiveInteger(value, `limits.${name}`);
  for (const [name, value] of Object.entries(policy.retention)) positiveInteger(value, `retention.${name}`);
  return policy;
}

export function applyRepositoryPolicy(base: ReviewPolicy, repository: ReviewPolicy): ReviewPolicy {
  validatePolicy(base);
  validatePolicy(repository);
  if (!base.allowRepositoryTightening) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Repository policy extensions are disabled by the trusted policy.");
  for (const category of base.requiredCategories) if (!repository.requiredCategories.includes(category)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Repository policy removed required category ${category}.`);
  for (const severity of base.blockingSeverities) if (!repository.blockingSeverities.includes(severity)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Repository policy removed blocking severity ${severity}.`);
  for (const [name, limit] of Object.entries(base.limits)) {
    if (repository.limits[name as keyof ReviewPolicy["limits"]] > limit) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Repository policy increased ${name}.`);
  }
  return structuredClone(repository);
}

export function policyDigest(policy: ReviewPolicy): string {
  return digestJson(validatePolicy(policy));
}
