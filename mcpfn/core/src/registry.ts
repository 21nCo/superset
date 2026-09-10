import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type {
  CallToolResult,
  CompleteResult,
  CreateTaskResult,
  GetPromptResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { McpFnOutputValidationError, McpFnValidationError } from "./errors.js";
import { compareCodeUnits } from "./canonical.js";
import {
  unsupportedUriTemplateOperator,
  uriTemplatesOverlap,
} from "./uri-template.js";
import type {
  McpFnListedTool,
  McpFnObjectSchema,
  McpFnPromptDefinition,
  McpFnRequestExtra,
  McpFnResourceDefinition,
  McpFnResourceTemplateDefinition,
  McpFnTaskRequestExtra,
  McpFnToolDefinition,
  McpFnValidationIssue,
} from "./types.js";

interface RegisteredTool<TContext> {
  definition: McpFnToolDefinition<TContext>;
  validateInput: ValidateFunction;
  validateOutput?: ValidateFunction;
}

interface RegisteredPrompt<TContext> {
  definition: McpFnPromptDefinition<TContext>;
  validateArguments: ValidateFunction;
}

interface RegisteredTemplate<TContext> {
  definition: McpFnResourceTemplateDefinition<TContext>;
  template: UriTemplate;
}

type ResourceMatch<TContext> =
  | { kind: "resource"; definition: McpFnResourceDefinition<TContext> }
  | {
      kind: "template";
      definition: McpFnResourceTemplateDefinition<TContext>;
      variables: Record<string, string | string[]>;
    };

function formatErrors(errors: ErrorObject[] | null | undefined): McpFnValidationIssue[] {
  return (errors ?? []).map((error) => {
    const additionalProperty = (error.params as Record<string, unknown>).additionalProperty;
    return {
      path: error.instancePath || "/",
      schemaPath: error.schemaPath,
      message: error.message ?? "Schema validation failed",
      keyword: error.keyword,
      ...(typeof additionalProperty === "string" ? { additionalProperty } : {}),
    };
  });
}

function assertName(kind: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new McpFnValidationError(
      `Invalid MCP ${kind} name ${JSON.stringify(name)}`,
    );
  }
}

function assertSubscriptionCallbacks(
  kind: "Resource" | "Resource template",
  name: string,
  subscribe: unknown,
  unsubscribe: unknown,
): void {
  if (
    (subscribe === undefined) !== (unsubscribe === undefined) ||
    (subscribe !== undefined && typeof subscribe !== "function") ||
    (unsubscribe !== undefined && typeof unsubscribe !== "function")
  ) {
    throw new McpFnValidationError(
      `${kind} ${name} must define subscribe and unsubscribe together as functions`,
    );
  }
}

function assertUri(kind: string, uri: string): void {
  try {
    new URL(uri);
  } catch {
    throw new McpFnValidationError(`Invalid MCP ${kind} URI ${JSON.stringify(uri)}`);
  }
}

interface PromptSchemaInventory {
  descriptions: Map<string, string>;
  propertySchemas: Map<string, unknown[]>;
  required: Set<string>;
}

function mergePromptSchemaInventory(
  target: PromptSchemaInventory,
  source: PromptSchemaInventory,
): void {
  for (const [name, description] of source.descriptions) {
    if (!target.descriptions.has(name)) target.descriptions.set(name, description);
  }
  for (const [name, schemas] of source.propertySchemas) {
    target.propertySchemas.set(name, [...(target.propertySchemas.get(name) ?? []), ...schemas]);
  }
  for (const name of source.required) target.required.add(name);
}

function resolveLocalSchemaReference(
  root: McpFnObjectSchema,
  reference: string,
): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return (current as Record<string, unknown>)[key];
  }, root);
}

function derivePromptSchemaInventory(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): PromptSchemaInventory | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const value = schema as Record<string, unknown>;
  const nonFlatKeywords = [
    "anyOf", "oneOf", "not", "if", "then", "else",
    "patternProperties", "dependentSchemas", "propertyNames",
  ];
  if (nonFlatKeywords.some((keyword) => Object.hasOwn(value, keyword))) return undefined;
  const inventory: PromptSchemaInventory = {
    descriptions: new Map(),
    propertySchemas: new Map(),
    required: new Set(),
  };
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref)) return undefined;
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return undefined;
    const nextReferences = new Set(references).add(value.$ref);
    const referencedInventory = derivePromptSchemaInventory(referenced, root, nextReferences);
    if (!referencedInventory) return undefined;
    mergePromptSchemaInventory(inventory, referencedInventory);
  }
  if (value.allOf !== undefined) {
    if (!Array.isArray(value.allOf)) return undefined;
    for (const member of value.allOf) {
      const memberInventory = derivePromptSchemaInventory(member, root, references);
      if (!memberInventory) return undefined;
      mergePromptSchemaInventory(inventory, memberInventory);
    }
  }
  const properties = value.properties;
  if (properties !== undefined && (
    typeof properties !== "object" || properties === null || Array.isArray(properties)
  )) return undefined;
  if (value.required !== undefined && !Array.isArray(value.required)) return undefined;
  const required = Array.isArray(value.required)
    ? value.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const name of required) inventory.required.add(name);
  const propertySchemas = (properties ?? {}) as Record<string, unknown>;
  for (const [name, propertySchema] of Object.entries(propertySchemas)) {
    inventory.propertySchemas.set(name, [
      ...(inventory.propertySchemas.get(name) ?? []),
      propertySchema,
    ]);
    if (propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema) &&
      typeof (propertySchema as { description?: unknown }).description === "string") {
      inventory.descriptions.set(
        name,
        (propertySchema as { description: string }).description,
      );
    }
  }
  return inventory;
}

function intersectStringCandidates(
  left: Set<string> | undefined,
  right: Set<string> | undefined,
): Set<string> | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Set([...left].filter((candidate) => right.has(candidate)));
}

function finiteStringCandidates(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): Set<string> | undefined {
  if (typeof schema === "boolean") return schema ? undefined : new Set();
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return new Set();
  const value = schema as Record<string, unknown>;
  let candidates: Set<string> | undefined;
  if (typeof value.type === "string" && value.type !== "string") return new Set();
  if (Array.isArray(value.type) && !value.type.includes("string")) return new Set();
  if (Object.hasOwn(value, "const")) {
    candidates = typeof value.const === "string" ? new Set([value.const]) : new Set();
  }
  if (Array.isArray(value.enum)) {
    candidates = intersectStringCandidates(
      candidates,
      new Set(value.enum.filter((entry): entry is string => typeof entry === "string")),
    );
  }
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref)) return new Set();
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return new Set();
    candidates = intersectStringCandidates(
      candidates,
      finiteStringCandidates(referenced, root, new Set(references).add(value.$ref)),
    );
  }
  if (Array.isArray(value.allOf)) {
    for (const member of value.allOf) {
      candidates = intersectStringCandidates(
        candidates,
        finiteStringCandidates(member, root, references),
      );
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(value[keyword])) continue;
    let union: Set<string> | undefined = new Set();
    for (const member of value[keyword]) {
      const memberCandidates = finiteStringCandidates(member, root, references);
      if (!memberCandidates) {
        union = undefined;
        break;
      }
      for (const candidate of memberCandidates) union.add(candidate);
    }
    candidates = intersectStringCandidates(candidates, union);
  }
  return candidates;
}

function schemaMayAcceptString(
  schema: unknown,
  root: McpFnObjectSchema,
  references = new Set<string>(),
): boolean {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const value = schema as Record<string, unknown>;
  const finiteCandidates = finiteStringCandidates(schema, root, references);
  if (finiteCandidates?.size === 0) return false;
  if (value.$ref !== undefined) {
    if (typeof value.$ref !== "string" || references.has(value.$ref)) return false;
    const referenced = resolveLocalSchemaReference(root, value.$ref);
    if (!referenced) return false;
    const nextReferences = new Set(references).add(value.$ref);
    if (!schemaMayAcceptString(referenced, root, nextReferences)) return false;
  }
  if (typeof value.type === "string" && value.type !== "string") return false;
  if (Array.isArray(value.type) && !value.type.includes("string")) return false;
  if (Object.hasOwn(value, "const") && typeof value.const !== "string") return false;
  if (Array.isArray(value.enum) && !value.enum.some((entry) => typeof entry === "string")) {
    return false;
  }
  if (Array.isArray(value.allOf) &&
    !value.allOf.every((member) => schemaMayAcceptString(member, root, references))) return false;
  if (Array.isArray(value.anyOf) &&
    !value.anyOf.some((member) => schemaMayAcceptString(member, root, references))) return false;
  if (Array.isArray(value.oneOf) &&
    !value.oneOf.some((member) => schemaMayAcceptString(member, root, references))) return false;
  return true;
}

export function assertPromptSchemaSupportsStringValues(
  schema: McpFnObjectSchema,
  label: string,
): void {
  const inventory = derivePromptSchemaInventory(schema, schema);
  if (!inventory) {
    throw new McpFnValidationError(
      `${label} must use derivable properties, allOf, or local $ref declarations`,
    );
  }
  for (const [name, schemas] of inventory.propertySchemas) {
    const finiteCandidates = finiteStringCandidates({ allOf: schemas }, schema);
    let hasStringWitness = schemas.every(
      (propertySchema) => schemaMayAcceptString(propertySchema, schema),
    );
    if (hasStringWitness && finiteCandidates) {
      const candidateSchema = {
        ...(schema.$defs && typeof schema.$defs === "object" ? { $defs: schema.$defs } : {}),
        ...(schema.definitions && typeof schema.definitions === "object"
          ? { definitions: schema.definitions }
          : {}),
        allOf: schemas,
      };
      let validate: ValidateFunction | undefined;
      try {
        validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(candidateSchema);
      } catch {
        hasStringWitness = false;
      }
      if (validate) {
        hasStringWitness = [...finiteCandidates].some((candidate) => validate!(candidate));
      }
    }
    if (!hasStringWitness) {
      throw new McpFnValidationError(
        `${label} argument ${name} must accept string values`,
      );
    }
  }
}

export function schemaPromptArguments(
  definition: { argumentsSchema?: McpFnObjectSchema },
) {
  const schema = definition.argumentsSchema;
  if (!schema) return undefined;
  const inventory = derivePromptSchemaInventory(schema, schema);
  if (!inventory) return undefined;
  const names = [...new Set([
    ...inventory.propertySchemas.keys(),
    ...inventory.required,
  ])]
    .sort(compareCodeUnits);
  return names.map((name) => {
    return {
      name,
      ...(inventory.descriptions.has(name)
        ? { description: inventory.descriptions.get(name)! }
        : {}),
      ...(inventory.required.has(name) ? { required: true } : {}),
    };
  });
}

function promptSchema<TContext>(definition: McpFnPromptDefinition<TContext>) {
  if (definition.argumentsSchema) return definition.argumentsSchema;
  const properties = Object.fromEntries(
    (definition.arguments ?? []).map((argument) => [
      argument.name,
      { type: "string", ...(argument.description ? { description: argument.description } : {}) },
    ]),
  );
  return {
    type: "object" as const,
    properties,
    required: (definition.arguments ?? [])
      .filter((argument) => argument.required)
      .map((argument) => argument.name),
    additionalProperties: false,
  };
}

export function promptArguments<TContext>(definition: McpFnPromptDefinition<TContext>) {
  return Array.isArray(definition.arguments)
    ? definition.arguments
    : schemaPromptArguments(definition);
}

export class McpFnRegistry<TContext = undefined> {
  private readonly ajv: Ajv;
  private readonly tools = new Map<string, RegisteredTool<TContext>>();
  private readonly resources = new Map<string, McpFnResourceDefinition<TContext>>();
  private readonly resourceTemplates = new Map<string, RegisteredTemplate<TContext>>();
  private readonly prompts = new Map<string, RegisteredPrompt<TContext>>();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    // npm workspaces may install ajv-formats with its own compatible Ajv copy.
    // The runtime contract is stable; erase only that duplicate-package type identity.
    addFormats(this.ajv as never);
  }

  register<TDefinition extends McpFnToolDefinition<TContext>>(
    definition: TDefinition,
  ): this {
    assertName("tool", definition.name);
    if (this.tools.has(definition.name)) {
      throw new McpFnValidationError(`Duplicate MCP tool: ${definition.name}`);
    }
    if (!definition.description.trim()) {
      throw new McpFnValidationError(
        `Tool ${definition.name} requires a non-empty description`,
      );
    }
    if (typeof definition.handler !== "function") {
      throw new McpFnValidationError(
        `Tool ${definition.name} requires a handler function`,
      );
    }
    if (definition.inputSchema.type !== "object") {
      throw new McpFnValidationError(
        `Tool ${definition.name} inputSchema must be an object schema`,
      );
    }
    if (
      definition.outputSchema !== undefined &&
      (
        definition.outputSchema === null ||
        typeof definition.outputSchema !== "object" ||
        Array.isArray(definition.outputSchema) ||
        definition.outputSchema.type !== "object"
      )
    ) {
      throw new McpFnValidationError(
        `Tool ${definition.name} outputSchema must be an object schema`,
      );
    }
    const taskSupport = definition.execution?.taskSupport ?? "forbidden";
    if (!["forbidden", "optional", "required"].includes(taskSupport)) {
      throw new McpFnValidationError(
        `Tool ${definition.name} has invalid taskSupport=${String(taskSupport)}`,
      );
    }
    if ((taskSupport === "required" || taskSupport === "optional") && !definition.taskHandler) {
      throw new McpFnValidationError(
        `Tool ${definition.name} declares taskSupport=${taskSupport} but has no taskHandler`,
      );
    }
    if (taskSupport === "forbidden" && definition.taskHandler) {
      throw new McpFnValidationError(
        `Tool ${definition.name} has a taskHandler but forbids task execution`,
      );
    }

    let validateInput: ValidateFunction;
    let validateOutput: ValidateFunction | undefined;
    try {
      validateInput = this.ajv.compile(definition.inputSchema);
      validateOutput = definition.outputSchema !== undefined
        ? this.ajv.compile(definition.outputSchema)
        : undefined;
    } catch (error) {
      throw new McpFnValidationError(
        `Tool ${definition.name} contains an invalid JSON Schema`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    this.tools.set(definition.name, {
      definition,
      validateInput,
      validateOutput,
    });
    return this;
  }

  registerAll(definitions: McpFnToolDefinition<TContext>[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  registerResource(definition: McpFnResourceDefinition<TContext>): this {
    assertUri("resource", definition.uri);
    assertName("resource", definition.name);
    if (typeof definition.read !== "function") {
      throw new McpFnValidationError(
        `Resource ${definition.name} requires a read handler function`,
      );
    }
    if (this.resources.has(definition.uri)) {
      throw new McpFnValidationError(`Duplicate MCP resource: ${definition.uri}`);
    }
    assertSubscriptionCallbacks(
      "Resource",
      definition.name,
      definition.subscribe,
      definition.unsubscribe,
    );
    this.resources.set(definition.uri, definition);
    return this;
  }

  registerResourceTemplate(
    definition: McpFnResourceTemplateDefinition<TContext>,
  ): this {
    assertName("resource template", definition.name);
    if (typeof definition.read !== "function") {
      throw new McpFnValidationError(
        `Resource template ${definition.name} requires a read handler function`,
      );
    }
    if (this.resourceTemplates.has(definition.name)) {
      throw new McpFnValidationError(
        `Duplicate MCP resource template: ${definition.name}`,
      );
    }
    if (typeof definition.uriTemplate !== "string") {
      throw new McpFnValidationError(
        `Invalid resource URI template ${JSON.stringify(definition.uriTemplate)}`,
      );
    }
    const unsupportedOperator = unsupportedUriTemplateOperator(definition.uriTemplate);
    if (unsupportedOperator) {
      throw new McpFnValidationError(
        `Resource template ${definition.name} uses unsupported URI template operator ${unsupportedOperator}`,
      );
    }
    let template: UriTemplate;
    try {
      template = new UriTemplate(definition.uriTemplate);
    } catch (error) {
      throw new McpFnValidationError(
        `Invalid resource URI template ${JSON.stringify(definition.uriTemplate)}`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!template.variableNames.length) {
      throw new McpFnValidationError(
        `Resource template ${definition.name} must contain at least one variable`,
      );
    }
    assertSubscriptionCallbacks(
      "Resource template",
      definition.name,
      definition.subscribe,
      definition.unsubscribe,
    );
    if ([...this.resourceTemplates.values()].some(
      ({ definition: registered }) =>
        uriTemplatesOverlap(registered.uriTemplate, definition.uriTemplate),
    )) {
      throw new McpFnValidationError(
        `Ambiguous MCP resource URI template: ${definition.uriTemplate}`,
      );
    }
    for (const name of Object.keys(definition.complete ?? {})) {
      if (!template.variableNames.includes(name)) {
        throw new McpFnValidationError(
          `Resource template ${definition.name} has a completer for unknown variable ${name}`,
        );
      }
    }
    this.resourceTemplates.set(definition.name, { definition, template });
    return this;
  }

  registerPrompt(definition: McpFnPromptDefinition<TContext>): this {
    assertName("prompt", definition.name);
    if (this.prompts.has(definition.name)) {
      throw new McpFnValidationError(`Duplicate MCP prompt: ${definition.name}`);
    }
    if (typeof definition.get !== "function") {
      throw new McpFnValidationError(
        `Prompt ${definition.name} requires a get handler function`,
      );
    }
    if (
      definition.arguments !== undefined && (
        !Array.isArray(definition.arguments) ||
        definition.arguments.some((argument) =>
          !argument || typeof argument !== "object" || Array.isArray(argument) ||
          typeof argument.name !== "string"
        )
      )
    ) {
      throw new McpFnValidationError(`Prompt ${definition.name} arguments must be an array`);
    }
    for (const argument of definition.arguments ?? []) {
      assertName("prompt argument", argument.name);
      if (argument.description !== undefined && typeof argument.description !== "string") {
        throw new McpFnValidationError(
          `Prompt ${definition.name} argument ${argument.name} description must be a string`,
        );
      }
      if (argument.required !== undefined && typeof argument.required !== "boolean") {
        throw new McpFnValidationError(
          `Prompt ${definition.name} argument ${argument.name} required must be a boolean`,
        );
      }
    }
    if (
      definition.argumentsSchema !== undefined &&
      (
        !definition.argumentsSchema ||
        typeof definition.argumentsSchema !== "object" ||
        Array.isArray(definition.argumentsSchema) ||
        definition.argumentsSchema.type !== "object"
      )
    ) {
      throw new McpFnValidationError(
        `Prompt ${definition.name} argumentsSchema must be an object schema`,
      );
    }
    let validateArguments: ValidateFunction;
    try {
      validateArguments = this.ajv.compile(promptSchema(definition));
    } catch (error) {
      throw new McpFnValidationError(
        `Prompt ${definition.name} contains an invalid arguments JSON Schema`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (definition.argumentsSchema) {
      assertPromptSchemaSupportsStringValues(
        definition.argumentsSchema,
        `Prompt ${definition.name} argumentsSchema`,
      );
    }
    const argumentNames = (promptArguments(definition) ?? []).map(({ name }) => name);
    if (new Set(argumentNames).size !== argumentNames.length) {
      throw new McpFnValidationError(`Prompt ${definition.name} has duplicate arguments`);
    }
    if (definition.arguments && definition.argumentsSchema) {
      const declared = definition.arguments
        .map(({ name, required }) => ({ name, required: required === true }))
        .sort((left, right) => compareCodeUnits(left.name, right.name));
      const schemaDeclared = schemaPromptArguments(definition)!.map(
        ({ name, required }) => ({ name, required: required === true }),
      );
      if (JSON.stringify(declared) !== JSON.stringify(schemaDeclared)) {
        throw new McpFnValidationError(
          `Prompt ${definition.name} arguments and argumentsSchema disagree`,
        );
      }
    }
    for (const name of Object.keys(definition.complete ?? {})) {
      if (!argumentNames.includes(name)) {
        throw new McpFnValidationError(
          `Prompt ${definition.name} has a completer for unknown argument ${name}`,
        );
      }
    }
    this.prompts.set(definition.name, { definition, validateArguments });
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  hasOutputSchema(name: string): boolean {
    return Boolean(this.tools.get(name)?.validateOutput);
  }

  definitions(): McpFnToolDefinition<TContext>[] {
    return [...this.tools.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  resourceDefinitions(): McpFnResourceDefinition<TContext>[] {
    return [...this.resources.values()].sort((left, right) => compareCodeUnits(left.uri, right.uri));
  }

  resourceTemplateDefinitions(): McpFnResourceTemplateDefinition<TContext>[] {
    return [...this.resourceTemplates.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  promptDefinitions(): McpFnPromptDefinition<TContext>[] {
    return [...this.prompts.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  capabilities(options: { listChanged?: boolean } = {}): ServerCapabilities {
    const capabilities: ServerCapabilities = {};
    if (this.tools.size) capabilities.tools = { listChanged: options.listChanged ?? true };
    if (this.resources.size || this.resourceTemplates.size) {
      capabilities.resources = {
        listChanged: options.listChanged ?? true,
        subscribe: [...this.resources.values()].some((value) => value.subscribe) ||
          [...this.resourceTemplates.values()].some(({ definition }) => definition.subscribe),
      };
    }
    if (this.prompts.size) capabilities.prompts = { listChanged: options.listChanged ?? true };
    if (
      [...this.resourceTemplates.values()].some(({ definition }) => definition.complete) ||
      [...this.prompts.values()].some(({ definition }) => definition.complete)
    ) capabilities.completions = {};
    if (this.definitions().some((definition) => {
      const support = definition.execution?.taskSupport;
      return support === "optional" || support === "required";
    })) capabilities.tasks = { requests: { tools: { call: {} } } };
    return capabilities;
  }

  listTools(): McpFnListedTool[] {
    return this.definitions().map((definition) => ({
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      description: definition.description,
      inputSchema: definition.inputSchema as McpFnListedTool["inputSchema"],
      ...(definition.outputSchema
        ? { outputSchema: definition.outputSchema as McpFnListedTool["outputSchema"] }
        : {}),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
      ...(definition.execution ? { execution: definition.execution } : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
  }

  async listResources(
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<Resource[]> {
    const resources: Resource[] = this.resourceDefinitions().map((definition) => ({
      uri: definition.uri,
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
    for (const { definition } of this.resourceTemplates.values()) {
      if (definition.list) resources.push(...(await definition.list(context, extra)).resources);
    }
    return resources.sort((left, right) => compareCodeUnits(left.uri, right.uri));
  }

  listResourceTemplates(): ResourceTemplate[] {
    return this.resourceTemplateDefinitions().map((definition) => ({
      uriTemplate: definition.uriTemplate,
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
  }

  listPrompts() {
    return this.promptDefinitions().map((definition) => ({
      name: definition.name,
      ...(definition.title ? { title: definition.title } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      ...(promptArguments(definition) ? { arguments: promptArguments(definition) } : {}),
      ...(definition.icons ? { icons: definition.icons } : {}),
      ...(definition.metadata ? { _meta: definition.metadata } : {}),
    }));
  }

  private normalizeAndValidateArgs(
    registered: RegisteredTool<TContext>,
    args: unknown,
  ): { args: Record<string, unknown>; issues?: ReturnType<typeof formatErrors> } {
    const normalizedArgs = args ?? {};
    if (!registered.validateInput(normalizedArgs)) {
      return {
        args: normalizedArgs && typeof normalizedArgs === "object" && !Array.isArray(normalizedArgs)
          ? normalizedArgs as Record<string, unknown>
          : {},
        issues: formatErrors(registered.validateInput.errors),
      };
    }
    return { args: normalizedArgs as Record<string, unknown> };
  }

  async callTool(
    name: string,
    args: unknown,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<CallToolResult> {
    const registered = this.tools.get(name);
    if (!registered) throw new McpFnValidationError(`Unknown MCP tool: ${name}`, { name });
    const normalized = this.normalizeAndValidateArgs(registered, args);
    if (normalized.issues) {
      if (registered.definition.handleInvalidArguments) {
        return this.finalizeResult(
          registered,
          await registered.definition.handleInvalidArguments(
            normalized.args,
            normalized.issues,
            context,
            extra,
          ),
        );
      }
      throw new McpFnValidationError(`Invalid arguments for ${name}`, { issues: normalized.issues });
    }
    return this.finalizeResult(
      registered,
      await registered.definition.handler(normalized.args, context, extra),
    );
  }

  taskSupport(name: string) {
    return this.tools.get(name)?.definition.execution?.taskSupport ?? "forbidden";
  }

  async createToolTask(
    name: string,
    args: unknown,
    context: TContext,
    extra: McpFnTaskRequestExtra,
  ): Promise<CreateTaskResult> {
    const registered = this.tools.get(name);
    if (!registered) throw new McpFnValidationError(`Unknown MCP tool: ${name}`, { name });
    const normalized = this.normalizeAndValidateArgs(registered, args);
    if (normalized.issues) {
      throw new McpFnValidationError(`Invalid arguments for ${name}`, { issues: normalized.issues });
    }
    if (!registered.definition.taskHandler) {
      throw new McpFnValidationError(`Tool ${name} does not support task execution`);
    }
    const taskStore = new Proxy(extra.taskStore, {
      get: (target, property, receiver) => {
        if (property === "storeTaskResult") {
          return async (
            taskId: string,
            status: "completed" | "failed",
            result: CallToolResult,
          ) => target.storeTaskResult(
            taskId,
            status,
            this.finalizeResult(registered, result),
          );
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return registered.definition.taskHandler.createTask(
      normalized.args,
      context,
      { ...extra, taskStore },
    );
  }

  private matchResource(uri: string): ResourceMatch<TContext> | undefined {
    const exact = this.resources.get(uri);
    if (exact) return { kind: "resource", definition: exact };
    for (const { definition, template } of this.resourceTemplates.values()) {
      const variables = template.match(uri);
      if (variables) return { kind: "template", definition, variables };
    }
    return undefined;
  }

  async readResource(
    uri: string,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<ReadResourceResult> {
    const match = this.matchResource(uri);
    if (!match) throw new McpFnValidationError(`Unknown MCP resource: ${uri}`);
    const url = new URL(uri);
    return match.kind === "resource"
      ? match.definition.read(url, context, extra)
      : match.definition.read(url, match.variables, context, extra);
  }

  async changeSubscription(
    uri: string,
    subscribed: boolean,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<void> {
    const match = this.matchResource(uri);
    if (!match) throw new McpFnValidationError(`Unknown MCP resource: ${uri}`);
    const url = new URL(uri);
    if (match.kind === "resource") {
      const callback = subscribed ? match.definition.subscribe : match.definition.unsubscribe;
      if (!callback) {
        throw new McpFnValidationError(
          `Resource ${uri} does not support ${subscribed ? "subscriptions" : "unsubscription"}`,
        );
      }
      await callback(url, context, extra);
      return;
    }
    const callback = subscribed ? match.definition.subscribe : match.definition.unsubscribe;
    if (!callback) {
      throw new McpFnValidationError(
        `Resource ${uri} does not support ${subscribed ? "subscriptions" : "unsubscription"}`,
      );
    }
    await callback(url, match.variables, context, extra);
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<GetPromptResult> {
    const registered = this.prompts.get(name);
    if (!registered) throw new McpFnValidationError(`Unknown MCP prompt: ${name}`);
    const normalized = args ?? {};
    if (!registered.validateArguments(normalized)) {
      throw new McpFnValidationError(`Invalid arguments for prompt ${name}`, {
        issues: formatErrors(registered.validateArguments.errors),
      });
    }
    return registered.definition.get(normalized, context, extra);
  }

  async complete(
    ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
    argument: { name: string; value: string },
    completionContext: Record<string, string> | undefined,
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<CompleteResult> {
    const empty = { completion: { values: [], total: 0, hasMore: false } };
    if (ref.type === "ref/prompt") {
      const prompt = this.prompts.get(ref.name);
      if (!prompt) throw new McpFnValidationError(`Unknown MCP prompt: ${ref.name}`);
      return prompt.definition.complete?.[argument.name]?.(
        argument.value,
        completionContext,
        context,
        extra,
      ) ?? empty;
    }
    const template = [...this.resourceTemplates.values()]
      .find(({ definition }) => definition.uriTemplate === ref.uri);
    if (!template) {
      if (this.resources.has(ref.uri)) return empty;
      throw new McpFnValidationError(`Unknown MCP resource template: ${ref.uri}`);
    }
    return template.definition.complete?.[argument.name]?.(
      argument.value,
      completionContext,
      context,
      extra,
    ) ?? empty;
  }

  private finalizeResult(
    registered: RegisteredTool<TContext>,
    result: CallToolResult,
  ): CallToolResult {
    if (registered.validateOutput && result.isError) {
      const { structuredContent: _omitted, ...errorWithoutStructuredContent } = result;
      return errorWithoutStructuredContent;
    }
    if (registered.validateOutput) {
      if (!result.structuredContent) {
        throw new McpFnOutputValidationError(
          `Tool ${registered.definition.name} declares outputSchema but returned no structuredContent`,
        );
      }
      if (!registered.validateOutput(result.structuredContent)) {
        throw new McpFnOutputValidationError(
          `Invalid output from ${registered.definition.name}`,
          { issues: formatErrors(registered.validateOutput.errors) },
        );
      }
    }
    return result;
  }
}
