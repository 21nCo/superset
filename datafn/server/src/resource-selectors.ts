import type { DatafnSchema } from "./core-types.js";

/** Version of the structural request-envelope contract used by this module. */
export const DATAFN_PROTOCOL_ENVELOPE_VERSION = 1 as const;

export type DatafnProtocolEnvelopeVersion =
  typeof DATAFN_PROTOCOL_ENVELOPE_VERSION;

export type DatafnResourceSelector = string;

export type DatafnSelectorAction =
  | "status"
  | "query"
  | "mutation"
  | "transact"
  | "seed"
  | "clone"
  | "pull"
  | "push"
  | "reconcile"
  | "search";

/**
 * Transport-neutral input for security-sensitive selector extraction.
 * `action` must come from the matched DataFn route, never from request data.
 */
export interface DatafnResourceSelectorEnvelope {
  readonly version: number;
  readonly action: DatafnSelectorAction;
  readonly payload: unknown;
}

/** A structurally parsed envelope whose selectors have been schema-validated. */
export interface DatafnParsedResourceSelectorEnvelope {
  readonly version: DatafnProtocolEnvelopeVersion;
  readonly action: DatafnSelectorAction;
  readonly selectors: readonly DatafnResourceSelector[];
}

export type DatafnResourceSelectorErrorCode =
  | "DATAFN_UNSUPPORTED_ENVELOPE_VERSION"
  | "DFQL_INVALID"
  | "DFQL_UNKNOWN_RESOURCE";

export class DatafnResourceSelectorError extends Error {
  readonly code: DatafnResourceSelectorErrorCode;
  readonly path: string;

  constructor(
    code: DatafnResourceSelectorErrorCode,
    message: string,
    path = "$",
  ) {
    super(message);
    this.name = "DatafnResourceSelectorError";
    this.code = code;
    this.path = path;
  }
}

function invalid(message: string, path = "$"): never {
  throw new DatafnResourceSelectorError("DFQL_INVALID", message, path);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("Invalid DataFn protocol shape: expected object", path);
  }
  return value as Record<string, unknown>;
}

function selectorAt(
  value: unknown,
  path: string,
  knownResources: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(
      "Invalid DataFn resource selector: expected non-empty string",
      path,
    );
  }
  if (!knownResources.has(value)) {
    throw new DatafnResourceSelectorError(
      "DFQL_UNKNOWN_RESOURCE",
      `Unknown resource: ${value}`,
      path,
    );
  }
  return value;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid("Invalid DataFn protocol shape: expected array", path);
  }
  return value;
}

/**
 * Parses only protocol structure that can carry resource selectors. It never
 * descends into application records, filters, values, relations, or metadata.
 */
export function parseDatafnResourceSelectorEnvelope(
  envelope: DatafnResourceSelectorEnvelope,
  schema: DatafnSchema,
): DatafnParsedResourceSelectorEnvelope {
  if (envelope.version !== DATAFN_PROTOCOL_ENVELOPE_VERSION) {
    throw new DatafnResourceSelectorError(
      "DATAFN_UNSUPPORTED_ENVELOPE_VERSION",
      `Unsupported DataFn protocol envelope version: ${String(envelope.version)}`,
      "version",
    );
  }

  const knownResources = new Set(
    schema.resources.map((resource) => resource.name),
  );
  const selectors: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, path: string) => {
    const selector = selectorAt(value, path, knownResources);
    if (!seen.has(selector)) {
      seen.add(selector);
      selectors.push(selector);
    }
  };
  const addAll = () => {
    for (const resource of schema.resources)
      add(resource.name, "schema.resources");
  };
  const parseOperation = (value: unknown, path: string) => {
    const operation = objectAt(value, path);
    add(operation.resource, `${path}.resource`);
  };
  const parseOperationBody = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        parseOperation(entry, `${path}[${index}]`),
      );
      return;
    }
    parseOperation(value, path);
  };

  switch (envelope.action) {
    case "query":
    case "mutation":
      parseOperationBody(envelope.payload, "payload");
      break;
    case "transact": {
      const payload = objectAt(envelope.payload, "payload");
      const steps = arrayAt(payload.steps, "payload.steps");
      steps.forEach((value, index) => {
        const path = `payload.steps[${index}]`;
        const step = objectAt(value, path);
        const hasQuery = step.query !== undefined;
        const hasMutation = step.mutation !== undefined;
        if (hasQuery && hasMutation) {
          invalid(
            "Invalid DataFn transaction step: expected one operation",
            path,
          );
        }
        if (hasQuery) parseOperation(step.query, `${path}.query`);
        else if (hasMutation) parseOperation(step.mutation, `${path}.mutation`);
        else parseOperation(step, path);
      });
      break;
    }
    case "push": {
      const payload = objectAt(envelope.payload, "payload");
      arrayAt(payload.mutations, "payload.mutations").forEach(
        (mutation, index) =>
          parseOperation(mutation, `payload.mutations[${index}]`),
      );
      break;
    }
    case "search": {
      const payload = objectAt(envelope.payload, "payload");
      if (payload.resources === undefined) addAll();
      else
        arrayAt(payload.resources, "payload.resources").forEach(
          (resource, index) => add(resource, `payload.resources[${index}]`),
        );
      break;
    }
    case "reconcile": {
      const payload = objectAt(envelope.payload, "payload");
      arrayAt(payload.resources, "payload.resources").forEach(
        (resource, index) => add(resource, `payload.resources[${index}]`),
      );
      break;
    }
    case "clone": {
      const payload = objectAt(envelope.payload, "payload");
      if (payload.tables === undefined) addAll();
      else
        arrayAt(payload.tables, "payload.tables").forEach((resource, index) =>
          add(resource, `payload.tables[${index}]`),
        );
      break;
    }
    case "pull":
      objectAt(envelope.payload, "payload");
      addAll();
      break;
    case "status":
    case "seed":
      objectAt(envelope.payload, "payload");
      break;
    default: {
      const exhaustive: never = envelope.action;
      invalid(`Unsupported DataFn action: ${String(exhaustive)}`, "action");
    }
  }

  return Object.freeze({
    version: DATAFN_PROTOCOL_ENVELOPE_VERSION,
    action: envelope.action,
    selectors: Object.freeze(selectors),
  });
}

/**
 * Supported security-sensitive integration point for gateways and plugins.
 * Returns normalized, stable-order, deduplicated resource names.
 */
export function extractDatafnResourceSelectors(
  envelope: DatafnResourceSelectorEnvelope,
  schema: DatafnSchema,
): readonly DatafnResourceSelector[] {
  return parseDatafnResourceSelectorEnvelope(envelope, schema).selectors;
}
