/**
 * Versioned DataFn request protocol: parse envelopes and collect structural
 * resource selectors for routing and authorization.
 *
 * This module inspects only protocol-defined selector positions. It does not
 * recursively search application records, filters, or other domain JSON.
 */

import { resolveJoinStoreResources } from "./joins.js";
import type { DatafnSchema } from "./types.js";

import { err, ok, type DatafnEnvelope } from "./errors.js";

export const DATAFN_REQUEST_PROTOCOL_VERSION = "1" as const;

export const DATAFN_REQUEST_PROTOCOL_VERSIONS = [
  DATAFN_REQUEST_PROTOCOL_VERSION,
] as const;

export type DatafnRequestProtocolVersion =
  (typeof DATAFN_REQUEST_PROTOCOL_VERSIONS)[number];

export const DATAFN_REQUEST_ACTIONS = [
  "status",
  "query",
  "mutation",
  "transact",
  "search",
  "seed",
  "clone",
  "pull",
  "push",
  "reconcile",
] as const;

export type DatafnRequestAction = (typeof DATAFN_REQUEST_ACTIONS)[number];

const DATAFN_REQUEST_ACTION_SET = new Set<string>(DATAFN_REQUEST_ACTIONS);

export function isDatafnRequestAction(value: unknown): value is DatafnRequestAction {
  return typeof value === "string" && DATAFN_REQUEST_ACTION_SET.has(value);
}

/**
 * Canonical inventory of protocol selector positions. Tests and docs share this
 * so extractor coverage cannot silently drift from accepted envelope shapes.
 */
export const DATAFN_STRUCTURAL_SELECTOR_POSITIONS = {
  status: [],
  query: ["resource"],
  mutation: ["resource"],
  transact: [
    "steps[].resource",
    "steps[].query.resource",
    "steps[].mutation.resource",
  ],
  search: ["resources[]", "filters object keys", "temporalByResource object keys"],
  seed: [],
  clone: ["tables[]", "page.table"],
  pull: ["cursors object keys"],
  push: ["mutations[].resource"],
  reconcile: ["resources[]"],
} as const satisfies Record<DatafnRequestAction, readonly string[]>;

export type DatafnResourceSelector = string & {
  readonly __brand: "DatafnResourceSelector";
};

export type ParsedDatafnQuery = {
  readonly resource: DatafnResourceSelector;
};

export type ParsedDatafnMutation = {
  readonly resource: DatafnResourceSelector;
};

export type ParsedDatafnTransactStep =
  | { readonly type: "query"; readonly query: ParsedDatafnQuery }
  | { readonly type: "mutation"; readonly mutation: ParsedDatafnMutation };

export type ParsedDatafnRequest =
  | {
      readonly kind: "status";
      readonly protocolVersion: DatafnRequestProtocolVersion;
    }
  | {
      readonly kind: "seed";
      readonly protocolVersion: DatafnRequestProtocolVersion;
    }
  | {
      readonly kind: "query";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly form: "single" | "batch";
      readonly queries: readonly ParsedDatafnQuery[];
    }
  | {
      readonly kind: "mutation";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly form: "single" | "batch";
      readonly mutations: readonly ParsedDatafnMutation[];
    }
  | {
      readonly kind: "transact";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly steps: readonly ParsedDatafnTransactStep[];
    }
  | {
      readonly kind: "search";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly resources: readonly DatafnResourceSelector[];
    }
  | {
      readonly kind: "clone";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly resources: readonly DatafnResourceSelector[];
    }
  | {
      readonly kind: "pull";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly resources: readonly DatafnResourceSelector[];
    }
  | {
      readonly kind: "push";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly mutations: readonly ParsedDatafnMutation[];
    }
  | {
      readonly kind: "reconcile";
      readonly protocolVersion: DatafnRequestProtocolVersion;
      readonly resources: readonly DatafnResourceSelector[];
    };

export type StructuralResourceSelection = {
  readonly selectors: readonly DatafnResourceSelector[];
  readonly protocolVersion: DatafnRequestProtocolVersion;
};

const DISALLOWED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function asSelector(value: string): DatafnResourceSelector {
  return value as DatafnResourceSelector;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // A polluted Object.prototype must not provide absent protocol fields.
  return !["resource", "resources", "protocolVersion", "query", "mutation", "steps",
    "mutations", "operation", "filters", "temporalByResource", "tables", "page", "table", "cursors"]
    .some((key) => key in value && !Object.prototype.hasOwnProperty.call(value, key));
}

function invalid(message: string, path: string): DatafnEnvelope<never> {
  return err("DFQL_INVALID", message, { path });
}

function unsupportedVersion(value: string, path: string): DatafnEnvelope<never> {
  return err(
    "DATAFN_UNSUPPORTED_PROTOCOL_VERSION",
    `Unsupported DataFn request protocol version: ${value}`,
    { path },
  );
}

function normalizeSelector(value: unknown, path: string): DatafnEnvelope<DatafnResourceSelector> {
  if (typeof value !== "string") {
    return invalid("Invalid DFQL: resource selector must be a string", path);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return invalid("Invalid DFQL: resource selector must be a non-empty string", path);
  }
  return ok(asSelector(trimmed));
}

class SelectorBuilder {
  private readonly seen = new Set<string>();
  private readonly list: DatafnResourceSelector[] = [];

  add(value: unknown, path: string): DatafnEnvelope<void> {
    const normalized = normalizeSelector(value, path);
    if (!normalized.ok) return normalized;
    if (!this.seen.has(normalized.result)) {
      this.seen.add(normalized.result);
      this.list.push(normalized.result);
    }
    return ok(undefined);
  }

  addAll(values: unknown, path: string): DatafnEnvelope<void> {
    if (!Array.isArray(values)) {
      return invalid("Invalid DFQL: resource selectors must be an array", path);
    }
    for (let i = 0; i < values.length; i++) {
      const added = this.add(values[i], `${path}[${i}]`);
      if (!added.ok) return added;
    }
    return ok(undefined);
  }

  addMapKeys(value: unknown, path: string, excluded?: string): DatafnEnvelope<void> {
    if (value === undefined) return ok(undefined);
    if (!isPlainObject(value)) {
      return invalid("Invalid DFQL: expected object", path);
    }
    for (const key of Object.keys(value)) {
      if (key === excluded) continue;
      if (DISALLOWED_KEYS.has(key)) {
        return invalid(`Disallowed key: ${key}`, path);
      }
      const added = this.add(key, `${path}.${key}`);
      if (!added.ok) return added;
    }
    return ok(undefined);
  }

  snapshot(): readonly DatafnResourceSelector[] {
    return Object.freeze([...this.list]);
  }
}

function readProtocolVersion(
  payload: unknown,
  path = "protocolVersion",
): DatafnEnvelope<DatafnRequestProtocolVersion> {
  if (!isPlainObject(payload) || !Object.prototype.hasOwnProperty.call(payload, "protocolVersion") || payload.protocolVersion === undefined) {
    return ok(DATAFN_REQUEST_PROTOCOL_VERSION);
  }
  if (typeof payload.protocolVersion !== "string") {
    return invalid(
      "Invalid DFQL: protocolVersion must be a string",
      path,
    );
  }
  if (
    !(DATAFN_REQUEST_PROTOCOL_VERSIONS as readonly string[]).includes(
      payload.protocolVersion,
    )
  ) {
    return unsupportedVersion(payload.protocolVersion, path);
  }
  return ok(payload.protocolVersion as DatafnRequestProtocolVersion);
}

function parseQueryEnvelope(
  query: unknown,
  path: string,
): DatafnEnvelope<ParsedDatafnQuery> {
  if (!isPlainObject(query)) {
    return invalid("Invalid DFQL: expected object", path);
  }
  const version = readProtocolVersion(query, `${path}.protocolVersion`);
  if (!version.ok) return version;
  for (const key of Object.keys(query)) {
    if (DISALLOWED_KEYS.has(key)) {
      return invalid(`Disallowed key: ${key}`, path);
    }
  }
  const resource = normalizeSelector(Object.prototype.hasOwnProperty.call(query, "resource") ? query.resource : undefined, `${path}.resource`);
  if (!resource.ok) return resource;
  return ok({ resource: resource.result });
}

function parseMutationEnvelope(
  mutation: unknown,
  path: string,
): DatafnEnvelope<ParsedDatafnMutation> {
  if (!isPlainObject(mutation)) {
    return invalid("Invalid DFQL: mutation must be object", path);
  }
  const version = readProtocolVersion(mutation, `${path}.protocolVersion`);
  if (!version.ok) return version;
  for (const key of Object.keys(mutation)) {
    if (DISALLOWED_KEYS.has(key)) {
      return invalid(`Disallowed key: ${key}`, path);
    }
  }
  const resource = normalizeSelector(Object.prototype.hasOwnProperty.call(mutation, "resource") ? mutation.resource : undefined, `${path}.resource`);
  if (!resource.ok) return resource;
  return ok({ resource: resource.result });
}

function parseQueryPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (typeof payload !== "object" || payload === null) {
    return invalid("Invalid DFQL: expected object or array", "$");
  }
  const isBatch = Array.isArray(payload);
  const queries = isBatch ? payload : [payload];
  const parsed: ParsedDatafnQuery[] = [];
  for (let i = 0; i < queries.length; i++) {
    const path = isBatch ? `$[${i}]` : "$";
    const query = parseQueryEnvelope(queries[i], path);
    if (!query.ok) return query;
    parsed.push(query.result);
  }
  return ok({
    kind: "query",
    protocolVersion,
    form: isBatch ? "batch" : "single",
    queries: Object.freeze(parsed),
  });
}

function parseMutationPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (typeof payload !== "object" || payload === null) {
    return invalid("Invalid DFQL: expected object or array", "$");
  }
  const isBatch = Array.isArray(payload);
  const mutations = isBatch ? payload : [payload];
  const parsed: ParsedDatafnMutation[] = [];
  for (let i = 0; i < mutations.length; i++) {
    const path = isBatch ? `$[${i}]` : "$";
    const mutation = parseMutationEnvelope(mutations[i], path);
    if (!mutation.ok) return mutation;
    parsed.push(mutation.result);
  }
  return ok({
    kind: "mutation",
    protocolVersion,
    form: isBatch ? "batch" : "single",
    mutations: Object.freeze(parsed),
  });
}

function parseTransactStep(
  step: unknown,
  path: string,
): DatafnEnvelope<ParsedDatafnTransactStep> {
  if (!isPlainObject(step)) {
    return invalid("Invalid DFQL: step must be object", path);
  }
  const version = readProtocolVersion(step, `${path}.protocolVersion`);
  if (!version.ok) return version;
  for (const key of Object.keys(step)) {
    if (DISALLOWED_KEYS.has(key)) {
      return invalid(`Disallowed key: ${key}`, path);
    }
  }
  const hasQuery = step.query !== undefined;
  const hasMutation = step.mutation !== undefined;
  if (hasQuery && hasMutation) {
    return invalid("Invalid DFQL: step must be a query or mutation", path);
  }
  if (hasQuery) {
    const query = parseQueryEnvelope(step.query, `${path}.query`);
    if (!query.ok) return query;
    return ok({ type: "query", query: query.result });
  }
  if (hasMutation) {
    const mutation = parseMutationEnvelope(step.mutation, `${path}.mutation`);
    if (!mutation.ok) return mutation;
    return ok({ type: "mutation", mutation: mutation.result });
  }
  if (typeof step.resource === "string" && typeof step.operation === "string") {
    const mutation = parseMutationEnvelope(step, path);
    if (!mutation.ok) return mutation;
    return ok({ type: "mutation", mutation: mutation.result });
  }
  if (typeof step.resource === "string") {
    const query = parseQueryEnvelope(step, path);
    if (!query.ok) return query;
    return ok({ type: "query", query: query.result });
  }
  return invalid("Invalid DFQL: step must be a query or mutation", path);
}

function parseTransactPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected 'steps' array", "steps");
  }
  if (!Array.isArray(payload.steps)) {
    return invalid("Invalid DFQL: expected 'steps' array", "steps");
  }
  const steps: ParsedDatafnTransactStep[] = [];
  for (let i = 0; i < payload.steps.length; i++) {
    const step = parseTransactStep(payload.steps[i], `steps[${i}]`);
    if (!step.ok) return step;
    steps.push(step.result);
  }
  return ok({
    kind: "transact",
    protocolVersion,
    steps: Object.freeze(steps),
  });
}

function parseSearchPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid request: expected object", "$");
  }
  const selectors = new SelectorBuilder();
  if (payload.resources !== undefined) {
    const added = selectors.addAll(payload.resources, "resources");
    if (!added.ok) return added;
  }
  const filterKeys = selectors.addMapKeys(payload.filters, "filters");
  if (!filterKeys.ok) return filterKeys;
  const temporalKeys = selectors.addMapKeys(
    payload.temporalByResource,
    "temporalByResource",
  );
  if (!temporalKeys.ok) return temporalKeys;
  return ok({
    kind: "search",
    protocolVersion,
    resources: selectors.snapshot(),
  });
}

function parseClonePayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected object", "$");
  }
  const selectors = new SelectorBuilder();
  if (payload.tables !== undefined) {
    const added = selectors.addAll(payload.tables, "tables");
    if (!added.ok) return added;
  }
  if (payload.page !== undefined) {
    if (!isPlainObject(payload.page)) {
      return invalid("Invalid DFQL: page must be object", "page");
    }
    const added = selectors.add(payload.page.table, "page.table");
    if (!added.ok) return added;
  }
  return ok({
    kind: "clone",
    protocolVersion,
    resources: selectors.snapshot(),
  });
}

function parsePullPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
  schema?: Pick<DatafnSchema, "resources" | "relations">,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected object", "$");
  }
  const selectors = new SelectorBuilder();
  if (payload.cursors !== undefined) {
    if (!isPlainObject(payload.cursors)) return invalid("Invalid DFQL: expected object", "cursors");
    const joins = resolveJoinStoreResources(schema?.relations ?? []);
    for (const key of Object.keys(payload.cursors)) {
      if (key === "__datafn_actor_feed__") continue;
      if (DISALLOWED_KEYS.has(key)) return invalid(`Disallowed key: ${key}`, "cursors");
      const endpoints = joins.get(key);
      // Preserve a real resource even if its name collides with a join key.
      const resources = endpoints ? [...endpoints, ...(schema?.resources.some(resource => resource.name === key) ? [key] : [])] : [key];
      const added = selectors.addAll(resources, `cursors.${key}`);
      if (!added.ok) return added;
    }
  }
  return ok({
    kind: "pull",
    protocolVersion,
    resources: selectors.snapshot(),
  });
}

function parsePushPayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected object", "$");
  }
  if (!Array.isArray(payload.mutations)) {
    return invalid("Invalid DFQL: mutations must be array", "mutations");
  }
  const mutations: ParsedDatafnMutation[] = [];
  for (let i = 0; i < payload.mutations.length; i++) {
    const mutation = parseMutationEnvelope(
      payload.mutations[i],
      `mutations[${i}]`,
    );
    if (!mutation.ok) return mutation;
    mutations.push(mutation.result);
  }
  return ok({
    kind: "push",
    protocolVersion,
    mutations: Object.freeze(mutations),
  });
}

function parseReconcilePayload(
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected object", "$");
  }
  if (payload.resources === undefined) {
    return invalid("Invalid DFQL: resources must be array", "resources");
  }
  const selectors = new SelectorBuilder();
  const added = selectors.addAll(payload.resources, "resources");
  if (!added.ok) return added;
  return ok({
    kind: "reconcile",
    protocolVersion,
    resources: selectors.snapshot(),
  });
}

function parseObjectAction(
  action: DatafnRequestAction,
  payload: unknown,
  protocolVersion: DatafnRequestProtocolVersion,
  schema?: Pick<DatafnSchema, "resources" | "relations">,
): DatafnEnvelope<ParsedDatafnRequest> {
  switch (action) {
    case "status":
      return ok({ kind: "status", protocolVersion });
    case "seed":
      if (payload !== null && payload !== undefined && !isPlainObject(payload)) {
        return invalid("Invalid DFQL: expected object", "$");
      }
      return ok({ kind: "seed", protocolVersion });
    case "query":
      return parseQueryPayload(payload, protocolVersion);
    case "mutation":
      return parseMutationPayload(payload, protocolVersion);
    case "transact":
      return parseTransactPayload(payload, protocolVersion);
    case "search":
      return parseSearchPayload(payload, protocolVersion);
    case "clone":
      return parseClonePayload(payload, protocolVersion);
    case "pull":
      return parsePullPayload(payload, protocolVersion, schema);
    case "push":
      return parsePushPayload(payload, protocolVersion);
    case "reconcile":
      return parseReconcilePayload(payload, protocolVersion);
    default: {
      const exhaustive: never = action;
      return err(
        "DFQL_UNSUPPORTED",
        `Unsupported DataFn action: ${String(exhaustive)}`,
        { path: "$" },
      );
    }
  }
}

/**
 * Parse an unknown request payload into a versioned, discriminated protocol
 * envelope. Application records and filter operands are not inspected.
 */
export function parseDatafnRequest(
  action: string,
  payload: unknown,
  options: { schema?: Pick<DatafnSchema, "resources" | "relations"> } = {},
): DatafnEnvelope<ParsedDatafnRequest> {
  if (!isDatafnRequestAction(action)) {
    return err("DFQL_UNSUPPORTED", `Unsupported DataFn action: ${action}`, {
      path: "$",
    });
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && !isPlainObject(payload)) {
    return invalid("Invalid DFQL: expected plain protocol object", "$");
  }
  if (isPlainObject(payload)) {
    for (const key of Object.keys(payload)) {
      if (DISALLOWED_KEYS.has(key)) return invalid(`Disallowed key: ${key}`, "$");
    }
  }
  const protocolVersion = readProtocolVersion(
    Array.isArray(payload) ? undefined : payload,
  );
  if (!protocolVersion.ok) return protocolVersion;
  return parseObjectAction(action, payload, protocolVersion.result, options.schema);
}

/**
 * Visit a parsed protocol envelope and return normalized, deduplicated
 * structural resource selectors. This function is exhaustive over
 * {@link ParsedDatafnRequest}.
 */
export function collectStructuralResourceSelectors(
  request: ParsedDatafnRequest,
): StructuralResourceSelection {
  const selectors = new SelectorBuilder();
  switch (request.kind) {
    case "status":
    case "seed":
      break;
    case "query":
      for (const query of request.queries) {
        void selectors.add(query.resource, "resource");
      }
      break;
    case "mutation":
      for (const mutation of request.mutations) {
        void selectors.add(mutation.resource, "resource");
      }
      break;
    case "transact":
      for (const step of request.steps) {
        switch (step.type) {
          case "query":
            void selectors.add(step.query.resource, "resource");
            break;
          case "mutation":
            void selectors.add(step.mutation.resource, "resource");
            break;
          default: {
            const exhaustive: never = step;
            throw new Error(
              `Unhandled DataFn transact step: ${JSON.stringify(exhaustive)}`,
            );
          }
        }
      }
      break;
    case "search":
    case "clone":
    case "pull":
    case "reconcile":
      for (const resource of request.resources) {
        void selectors.add(resource, "resource");
      }
      break;
    case "push":
      for (const mutation of request.mutations) {
        void selectors.add(mutation.resource, "resource");
      }
      break;
    default: {
      const exhaustive: never = request;
      throw new Error(
        `Unhandled DataFn protocol variant: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return {
    selectors: selectors.snapshot(),
    protocolVersion: request.protocolVersion,
  };
}

/**
 * Gateway convenience API: parse an unknown payload and return structural
 * resource selectors. Returned selectors are inputs to product policy; this
 * function does not grant access or choose placement.
 */
export function extractStructuralResourceSelectors(
  action: string,
  payload: unknown,
  options: { schema?: Pick<DatafnSchema, "resources" | "relations"> } = {},
): DatafnEnvelope<StructuralResourceSelection> {
  const parsed = parseDatafnRequest(action, payload, options);
  if (!parsed.ok) return parsed;
  return ok(collectStructuralResourceSelectors(parsed.result));
}
