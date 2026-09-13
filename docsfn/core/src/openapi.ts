import { parse as parseYaml } from "yaml";
import { createDiagnostic, createDocsError } from "./diagnostics";
import { deriveLogicalPathFromSourcePath, normalizeSlug, stripSourceExtension } from "./routing";
import type { DocsDiagnostic } from "./types";

const HTTP_METHOD_ORDER = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

const HTTP_METHOD_SET = new Set<string>(HTTP_METHOD_ORDER);

export type OpenApiSourceFormat = "json" | "yaml";

export interface CanonicalOpenApiExample {
  name: string;
  summary?: string;
  description?: string;
  value: unknown;
}

export interface CanonicalOpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: unknown;
  schemaType?: string;
  example?: unknown;
}

export interface CanonicalOpenApiRequestBodyMedia {
  mediaType: string;
  schema?: unknown;
  example?: unknown;
  examples: CanonicalOpenApiExample[];
}

export interface CanonicalOpenApiRequestBody {
  required: boolean;
  description?: string;
  content: CanonicalOpenApiRequestBodyMedia[];
}

export interface CanonicalOpenApiResponse {
  statusCode: string;
  description?: string;
  content: CanonicalOpenApiRequestBodyMedia[];
}

export interface CanonicalOpenApiOperation {
  id: string;
  operationId?: string;
  method: Uppercase<(typeof HTTP_METHOD_ORDER)[number]>;
  methodLower: (typeof HTTP_METHOD_ORDER)[number];
  path: string;
  routePath: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: CanonicalOpenApiParameter[];
  requestBody?: CanonicalOpenApiRequestBody;
  responses: CanonicalOpenApiResponse[];
  deprecated: boolean;
}

export interface CanonicalOpenApiTagGroup {
  slug: string;
  name: string;
  description?: string;
  routePath: string;
  operationIds: string[];
}

export interface CanonicalOpenApiSchemaRecord {
  name: string;
  slug: string;
  routePath: string;
  description?: string;
  schema: unknown;
}

export interface CanonicalOpenApiServer {
  url: string;
  description?: string;
}

export interface CanonicalOpenApiRoutes {
  overview: string;
  tags: Record<string, string>;
  operations: Record<string, string>;
  schemas: Record<string, string>;
  all: string[];
}

export interface CanonicalOpenApiReference {
  schemaVersion: 1;
  sourceId: string;
  sourcePath: string;
  sourceFormat: OpenApiSourceFormat;
  openapiVersion: string;
  title: string;
  description?: string;
  version?: string;
  info: {
    title: string;
    description?: string;
    version?: string;
  };
  servers: CanonicalOpenApiServer[];
  tags: CanonicalOpenApiTagGroup[];
  operations: CanonicalOpenApiOperation[];
  schemas: CanonicalOpenApiSchemaRecord[];
  routes: CanonicalOpenApiRoutes;
  diagnostics: DocsDiagnostic[];
  sourceMeta: {
    etag?: string;
    sha256?: string;
    updatedAt?: string;
    remoteUrl?: string;
  };
}

export interface ParseOpenApiSourceInput {
  sourceId: string;
  sourcePath: string;
  body: string;
  absolutePath?: string;
}

export interface NormalizeOpenApiReferenceInput {
  sourceId: string;
  sourcePath: string;
  parsed: unknown;
  sourceFormat: OpenApiSourceFormat;
  fallbackTitle: string;
  basePath?: string;
  sourceMeta?: CanonicalOpenApiReference["sourceMeta"];
}

export interface BuildOpenApiReferenceInput {
  sourceId: string;
  sourcePath: string;
  body: string;
  fallbackTitle: string;
  basePath?: string;
  absolutePath?: string;
  sourceMeta?: CanonicalOpenApiReference["sourceMeta"];
}

const OPENAPI_VERSION_REGEX = /^3(?:\.\d+){1,2}$/;

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function normalizeBasePath(basePath: string | undefined): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  let end = prefixed.length;
  while (end > 1 && prefixed.charCodeAt(end - 1) === 47) end -= 1;
  return prefixed.slice(0, end);
}

function normalizeRouteSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll("{", "")
    .replaceAll("}", "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "item";
}

function toObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function resolveSourceFormat(sourcePath: string): OpenApiSourceFormat {
  const normalized = normalizeSlug(sourcePath).toLowerCase();
  if (normalized.endsWith(".json")) {
    return "json";
  }
  return "yaml";
}

function createOpenApiParseError(input: {
  message: string;
  sourceId: string;
  sourcePath: string;
  absolutePath?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}) {
  return createDocsError({
    code: "DOCS_OPENAPI_PARSE_FAILED",
    message: input.message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_OPENAPI_PARSE_FAILED",
        message: input.message,
        location: {
          sourceId: input.sourceId,
          absolutePath: input.absolutePath,
        },
        details: {
          sourcePath: input.sourcePath,
          ...(input.details ?? {}),
        },
      }),
    ],
    cause: input.cause,
  });
}

function parseJson(source: ParseOpenApiSourceInput): unknown {
  try {
    return JSON.parse(source.body);
  } catch (error) {
    throw createOpenApiParseError({
      message: `OpenAPI JSON source ${source.sourcePath} could not be parsed`,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      absolutePath: source.absolutePath,
      details: {
        parser: "json",
        error: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  }
}

function parseYamlSource(source: ParseOpenApiSourceInput): unknown {
  try {
    return parseYaml(source.body);
  } catch (error) {
    throw createOpenApiParseError({
      message: `OpenAPI YAML source ${source.sourcePath} could not be parsed`,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      absolutePath: source.absolutePath,
      details: {
        parser: "yaml",
        error: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  }
}

function normalizeExamples(value: unknown): CanonicalOpenApiExample[] {
  const record = toObject(value);
  return Object.keys(record)
    .sort(compareStrings)
    .map((name) => {
      const item = toObject(record[name]);
      return {
        name,
        summary: typeof item.summary === "string" ? item.summary : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
        value: "value" in item ? item.value : undefined,
      };
    });
}

function normalizeMediaContent(value: unknown): CanonicalOpenApiRequestBodyMedia[] {
  const contentRecord = toObject(value);
  return Object.keys(contentRecord)
    .sort(compareStrings)
    .map((mediaType) => {
      const media = toObject(contentRecord[mediaType]);
      return {
        mediaType,
        schema: media.schema,
        example: media.example,
        examples: normalizeExamples(media.examples),
      };
    });
}

function resolveLocalReference(
  value: unknown,
  document: Record<string, unknown>,
  input: NormalizeOpenApiReferenceInput
): unknown {
  let resolved = value;
  const visited = new Set<string>();
  const overrides: Record<string, string> = {};
  while (typeof toObject(resolved).$ref === "string") {
    if (typeof document.openapi === "string" && Number(document.openapi.split(".")[1]) >= 1) {
      for (const key of ["summary", "description"]) {
        if (!Object.hasOwn(overrides, key) && typeof toObject(resolved)[key] === "string") overrides[key] = toObject(resolved)[key] as string;
      }
    }
    const reference = toObject(resolved).$ref as string;
    if (!reference.startsWith("#/") || visited.has(reference)) {
      throw createOpenApiParseError({
        message: `unsupported or cyclic local reference ${reference}`,
        sourceId: input.sourceId,
        sourcePath: input.sourcePath,
      });
    }
    visited.add(reference);
    resolved = document;
    let pointer: string;
    try { pointer = decodeURIComponent(reference.slice(2)); }
    catch { throw createOpenApiParseError({ message: `malformed local reference ${reference}`, sourceId: input.sourceId, sourcePath: input.sourcePath }); }
    for (const segment of pointer.split("/")) {
      if (/~(?![01])/.test(segment)) throw createOpenApiParseError({ message: `malformed local reference ${reference}`, sourceId: input.sourceId, sourcePath: input.sourcePath });
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      const object = toObject(resolved);
      resolved = Object.prototype.hasOwnProperty.call(object, key)
        ? object[key]
        : undefined;
    }
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw createOpenApiParseError({
        message: `unresolved local reference ${reference}`,
        sourceId: input.sourceId,
        sourcePath: input.sourcePath,
      });
    }
  }
  return Object.keys(overrides).length ? { ...toObject(resolved), ...overrides } : resolved;
}

function normalizeParameter(value: unknown): CanonicalOpenApiParameter {
  const parameter = toObject(value);
  const schema = toObject(parameter.schema);
  const fromRef =
    typeof parameter.$ref === "string"
      ? parameter.$ref.split("/").filter(Boolean).at(-1)
      : undefined;

  return {
    name:
      typeof parameter.name === "string" && parameter.name.length > 0
        ? parameter.name
        : fromRef ?? "param",
    in: typeof parameter.in === "string" && parameter.in.length > 0 ? parameter.in : "query",
    required: Boolean(parameter.required),
    description:
      typeof parameter.description === "string" ? parameter.description : undefined,
    schema: Object.keys(schema).length > 0 ? schema : undefined,
    schemaType: typeof schema.type === "string" ? schema.type : undefined,
    example: "example" in parameter ? parameter.example : undefined,
  };
}

function normalizeRequestBody(value: unknown): CanonicalOpenApiRequestBody | undefined {
  const requestBody = toObject(value);
  if (Object.keys(requestBody).length === 0) {
    return undefined;
  }

  return {
    required: Boolean(requestBody.required),
    description:
      typeof requestBody.description === "string" ? requestBody.description : undefined,
    content: normalizeMediaContent(requestBody.content),
  };
}

function normalizeResponses(value: unknown, document: Record<string, unknown>, input: NormalizeOpenApiReferenceInput): CanonicalOpenApiResponse[] {
  const responses = toObject(value);
  return Object.keys(responses)
    .sort(compareStrings)
    .map((statusCode) => {
      const response = toObject(resolveLocalReference(responses[statusCode], document, input));
      return {
        statusCode,
        description:
          typeof response.description === "string" ? response.description : undefined,
        content: normalizeMediaContent(response.content),
      };
    });
}

function operationSort(left: CanonicalOpenApiOperation, right: CanonicalOpenApiOperation): number {
  const methodWeight =
    HTTP_METHOD_ORDER.indexOf(left.methodLower) -
    HTTP_METHOD_ORDER.indexOf(right.methodLower);
  if (methodWeight !== 0) {
    return methodWeight;
  }
  const pathComparison = compareStrings(left.path, right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }
  return compareStrings(left.id, right.id);
}

function buildApiRootPath(basePath: string, sourcePath: string): string {
  const logicalPath = deriveLogicalPathFromSourcePath(stripSourceExtension(sourcePath));
  if (!logicalPath) {
    return `${basePath}/api`.replace(/\/{2,}/g, "/");
  }
  return `${basePath}/api/${logicalPath}`.replace(/\/{2,}/g, "/");
}

function assertUniqueGeneratedRoutes(
  entries: Array<{ routePath: string }>,
  kind: string,
  input: NormalizeOpenApiReferenceInput
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.routePath)) {
      throw createOpenApiParseError({
        message: `OpenAPI source ${input.sourcePath} generates duplicate ${kind} route ${entry.routePath}`,
        sourceId: input.sourceId,
        sourcePath: input.sourcePath,
        details: { routePath: entry.routePath, routeKind: kind },
      });
    }
    seen.add(entry.routePath);
  }
}

function assertOpenApi3x(parsed: Record<string, unknown>, input: NormalizeOpenApiReferenceInput): string {
  const version =
    typeof parsed.openapi === "string" && parsed.openapi.length > 0
      ? parsed.openapi
      : "";
  if (!OPENAPI_VERSION_REGEX.test(version) || !version.startsWith("3.")) {
    throw createOpenApiParseError({
      message: `unsupported OpenAPI version ${version || "unknown"} for ${input.sourcePath}; only 3.x is supported`,
      sourceId: input.sourceId,
      sourcePath: input.sourcePath,
      details: {
        openapi: parsed.openapi,
      },
    });
  }
  return version;
}

export function parseOpenApiSource(input: ParseOpenApiSourceInput): {
  sourceFormat: OpenApiSourceFormat;
  parsed: unknown;
} {
  const sourceFormat = resolveSourceFormat(input.sourcePath);
  const parsed = sourceFormat === "json" ? parseJson(input) : parseYamlSource(input);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw createOpenApiParseError({
      message: `OpenAPI source ${input.sourcePath} must parse to an object`,
      sourceId: input.sourceId,
      sourcePath: input.sourcePath,
      absolutePath: input.absolutePath,
      details: {
        parsedType: Array.isArray(parsed) ? "array" : typeof parsed,
      },
    });
  }

  assertAcyclicParsedSource(parsed, input);

  return {
    sourceFormat,
    parsed,
  };
}

function assertAcyclicParsedSource(value: unknown, input: ParseOpenApiSourceInput): void {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const stack: Array<{ node: object; children: unknown[]; index: number }> = [];

  const push = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    if (visiting.has(node)) {
      throw createOpenApiParseError({
        message: `OpenAPI source ${input.sourcePath} contains a cyclic reference`,
        sourceId: input.sourceId,
        sourcePath: input.sourcePath,
        absolutePath: input.absolutePath,
        details: {
          parser: "cycle",
        },
      });
    }
    visiting.add(node);
    stack.push({
      node,
      children: Array.isArray(node) ? node : Object.values(node),
      index: 0,
    });
  };

  push(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.children.length) {
      visiting.delete(frame.node);
      visited.add(frame.node);
      stack.pop();
      continue;
    }
    const child = frame.children[frame.index];
    frame.index += 1;
    push(child);
  }
}

export function normalizeOpenApiReference(
  input: NormalizeOpenApiReferenceInput
): CanonicalOpenApiReference {
  const parsed = toObject(input.parsed);
  const diagnostics: DocsDiagnostic[] = [];
  const openapiVersion = assertOpenApi3x(parsed, input);

  if (parsed.webhooks) {
    diagnostics.push(
      createDiagnostic({
        code: "DOCS_ARTIFACT_INVALID",
        severity: "warning",
        message: `OpenAPI source ${input.sourcePath} includes webhooks which are not rendered by docsfn yet`,
        details: {
          sourceId: input.sourceId,
          sourcePath: input.sourcePath,
          unsupported: "webhooks",
        },
      })
    );
  }

  const info = toObject(parsed.info);
  const title =
    (typeof info.title === "string" && info.title) || input.fallbackTitle;
  const basePath = normalizeBasePath(input.basePath);
  const apiRootPath = buildApiRootPath(basePath, input.sourcePath);

  const servers = (Array.isArray(parsed.servers) ? parsed.servers : [])
    .map((value) => toObject(value))
    .filter((value) => typeof value.url === "string" && value.url.length > 0)
    .map((server) => ({
      url: String(server.url),
      description: typeof server.description === "string" ? server.description : undefined,
    }))
    .sort((left, right) => compareStrings(left.url, right.url));

  const operationIds = new Set<string>();
  const operations: CanonicalOpenApiOperation[] = [];
  const tagMap = new Map<string, { description?: string; operationIds: string[] }>();

  const declaredTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  for (const tag of declaredTags) {
    const normalized = toObject(tag);
    if (typeof normalized.name !== "string" || normalized.name.length === 0) {
      continue;
    }
    const name = normalized.name;
    tagMap.set(name, {
      description:
        typeof normalized.description === "string" ? normalized.description : undefined,
      operationIds: [],
    });
  }

  const paths = toObject(parsed.paths);
  for (const pathKey of Object.keys(paths).sort(compareStrings)) {
    const pathItem = resolveLocalReference(paths[pathKey], parsed, input);
    if (typeof pathItem !== "object" || pathItem === null || Array.isArray(pathItem)) {
      throw createOpenApiParseError({
        message: `OpenAPI source ${input.sourcePath} has malformed path operations at ${pathKey}`,
        sourceId: input.sourceId,
        sourcePath: input.sourcePath,
      });
    }

    const pathRecord = pathItem as Record<string, unknown>;
    const pathParameters = Array.isArray(pathRecord.parameters)
      ? pathRecord.parameters.map((value) => normalizeParameter(resolveLocalReference(value, parsed, input)))
      : [];

    for (const method of Object.keys(pathRecord).sort(compareStrings)) {
      if (!HTTP_METHOD_SET.has(method.toLowerCase())) {
        continue;
      }

      const methodLower = method.toLowerCase() as (typeof HTTP_METHOD_ORDER)[number];
      const operationRaw = pathRecord[method];
      if (
        typeof operationRaw !== "object" ||
        operationRaw === null ||
        Array.isArray(operationRaw)
      ) {
        throw createOpenApiParseError({
          message: `OpenAPI source ${input.sourcePath} has malformed ${method.toUpperCase()} ${pathKey} operation`,
          sourceId: input.sourceId,
          sourcePath: input.sourcePath,
        });
      }

      const operation = operationRaw as Record<string, unknown>;
      const explicitOperationId =
        typeof operation.operationId === "string" && operation.operationId.length > 0
          ? operation.operationId
          : undefined;

      const operationId = explicitOperationId ?? `${methodLower}:${pathKey}`;
      if (operationIds.has(operationId)) {
        throw createOpenApiParseError({
          message: `OpenAPI source ${input.sourcePath} has duplicate operationId ${operationId}`,
          sourceId: input.sourceId,
          sourcePath: input.sourcePath,
        });
      }
      operationIds.add(operationId);

      const pathSlug = normalizeRouteSlug(pathKey);
      const operationSlug = explicitOperationId
        ? normalizeRouteSlug(explicitOperationId)
        : pathSlug;
      const routePath = `${apiRootPath}/operations/${methodLower}-${operationSlug}`;

      const localParameters = Array.isArray(operation.parameters)
        ? operation.parameters.map((value) => normalizeParameter(resolveLocalReference(value, parsed, input)))
        : [];
      const mergedParameterMap = new Map<string, CanonicalOpenApiParameter>();
      for (const parameter of [...pathParameters, ...localParameters]) {
        mergedParameterMap.set(`${parameter.in}:${parameter.name}`, parameter);
      }

      const operationTags = Array.isArray(operation.tags)
        ? operation.tags.filter((value): value is string => typeof value === "string")
        : [];
      const normalizedTags = (operationTags.length > 0 ? operationTags : ["default"])
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .sort(compareStrings);

      operations.push({
        id: operationId,
        operationId: explicitOperationId,
        method: methodLower.toUpperCase() as Uppercase<(typeof HTTP_METHOD_ORDER)[number]>,
        methodLower,
        path: pathKey,
        routePath,
        summary: typeof operation.summary === "string" ? operation.summary : undefined,
        description:
          typeof operation.description === "string" ? operation.description : undefined,
        tags: normalizedTags,
        parameters: [...mergedParameterMap.values()].sort((left, right) => {
          const locationComparison = compareStrings(left.in, right.in);
          if (locationComparison !== 0) {
            return locationComparison;
          }
          return compareStrings(left.name, right.name);
        }),
        requestBody: normalizeRequestBody(resolveLocalReference(operation.requestBody, parsed, input)),
        responses: normalizeResponses(operation.responses, parsed, input),
        deprecated: Boolean(operation.deprecated),
      });

      for (const tagName of normalizedTags) {
        const current = tagMap.get(tagName) ?? { operationIds: [] as string[] };
        current.operationIds.push(operationId);
        tagMap.set(tagName, current);
      }
    }
  }

  const sortedOperations = [...operations].sort(operationSort);
  assertUniqueGeneratedRoutes(sortedOperations, "operation", input);

  const tags: CanonicalOpenApiTagGroup[] = [...tagMap.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([name, value]) => ({
      slug: normalizeRouteSlug(name),
      name,
      description: value.description,
      routePath: `${apiRootPath}/tags/${normalizeRouteSlug(name)}`,
      operationIds: [...new Set(value.operationIds)].sort(compareStrings),
    }));
  assertUniqueGeneratedRoutes(tags, "tag", input);

  const schemaRecord = toObject(toObject(parsed.components).schemas);
  const schemas: CanonicalOpenApiSchemaRecord[] = Object.keys(schemaRecord)
    .sort(compareStrings)
    .map((name) => {
      const schema = schemaRecord[name];
      const schemaObject = toObject(schema);
      return {
        name,
        slug: normalizeRouteSlug(name),
        routePath: `${apiRootPath}/schemas/${normalizeRouteSlug(name)}`,
        description:
          typeof schemaObject.description === "string" ? schemaObject.description : undefined,
        schema,
      };
    });
  assertUniqueGeneratedRoutes(schemas, "schema", input);

  const routes: CanonicalOpenApiRoutes = {
    overview: apiRootPath,
    tags: Object.fromEntries(tags.map((tag) => [tag.slug, tag.routePath])),
    operations: Object.fromEntries(
      sortedOperations.map((operation) => [operation.id, operation.routePath])
    ),
    schemas: Object.fromEntries(schemas.map((schema) => [schema.name, schema.routePath])),
    all: [
      apiRootPath,
      ...tags.map((tag) => tag.routePath),
      ...sortedOperations.map((operation) => operation.routePath),
      ...schemas.map((schema) => schema.routePath),
    ].sort(compareStrings),
  };

  return {
    schemaVersion: 1,
    sourceId: input.sourceId,
    sourcePath: normalizeSlug(input.sourcePath),
    sourceFormat: input.sourceFormat,
    openapiVersion,
    title,
    description: typeof info.description === "string" ? info.description : undefined,
    version: typeof info.version === "string" ? info.version : undefined,
    info: {
      title,
      description: typeof info.description === "string" ? info.description : undefined,
      version: typeof info.version === "string" ? info.version : undefined,
    },
    servers,
    tags,
    operations: sortedOperations,
    schemas,
    routes,
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(`${left.code}:${left.message}`, `${right.code}:${right.message}`)
    ),
    sourceMeta: {
      etag: input.sourceMeta?.etag,
      sha256: input.sourceMeta?.sha256,
      updatedAt: input.sourceMeta?.updatedAt,
      remoteUrl: input.sourceMeta?.remoteUrl,
    },
  };
}

export function buildOpenApiReference(
  input: BuildOpenApiReferenceInput
): CanonicalOpenApiReference {
  const parsed = parseOpenApiSource({
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    body: input.body,
    absolutePath: input.absolutePath,
  });

  return normalizeOpenApiReference({
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    parsed: parsed.parsed,
    sourceFormat: parsed.sourceFormat,
    fallbackTitle: input.fallbackTitle,
    basePath: input.basePath,
    sourceMeta: input.sourceMeta,
  });
}

export type OpenApiResolvedRoute =
  | { kind: "overview"; route: string }
  | { kind: "tag"; route: string; slug: string }
  | { kind: "operation"; route: string; operationId: string }
  | { kind: "schema"; route: string; schemaName: string };

export function resolveOpenApiRoute(
  reference: CanonicalOpenApiReference,
  route: string
): OpenApiResolvedRoute {
  if (route === reference.routes.overview) {
    return { kind: "overview", route };
  }

  for (const [slug, tagRoute] of Object.entries(reference.routes.tags)) {
    if (tagRoute === route) {
      return {
        kind: "tag",
        route,
        slug,
      };
    }
  }

  for (const [operationId, operationRoute] of Object.entries(reference.routes.operations)) {
    if (operationRoute === route) {
      return {
        kind: "operation",
        route,
        operationId,
      };
    }
  }

  for (const [schemaName, schemaRoute] of Object.entries(reference.routes.schemas)) {
    if (schemaRoute === route) {
      return {
        kind: "schema",
        route,
        schemaName,
      };
    }
  }

  throw createDocsError({
    code: "DOCS_ROUTE_NOT_FOUND",
    message: `API reference route ${route} was not generated`,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_ROUTE_NOT_FOUND",
        message: `API reference route ${route} was not generated`,
      }),
    ],
  });
}
