import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminCapabilityAdapter,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminJsonSchema,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import type {
  DocsFnAdminConfig,
  DocsFnBuildView,
  DocsFnOperatorService,
  DocsFnPageInput,
  DocsFnSiteView,
} from "./operator-service.js";

export * from "./operator-service.js";

type IdInput = { id: string };
type SiteUpsertInput = { id: string; name: string; config: DocsFnAdminConfig };
type BuildListInput = DocsFnPageInput & { siteId?: string };
type RunBuildInput = { siteId: string; preview?: boolean };
type Page<T> = { items: T[]; nextCursor: string | null };
type Item<T> = { item: T };
type Accepted = { accepted: true };
type AcceptedItem<T> = Accepted & { item: T };

const scopeSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    installationId: { type: "string" },
    workspaceId: { type: "string" },
    projectId: { type: "string" },
    environmentId: { type: ["string", "null"] },
  },
  required: ["installationId", "workspaceId", "projectId", "environmentId"],
  additionalProperties: false,
};
const pageInputSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    cursor: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};
const idSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};
const siteViewSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    scope: scopeSchema,
    name: { type: "string" },
    title: { type: "string" },
    basePath: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "scope", "name", "title", "basePath", "createdAt", "updatedAt"],
  additionalProperties: false,
};
const buildViewSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    scope: scopeSchema,
    siteId: { type: "string" },
    status: { type: "string", enum: ["succeeded", "failed"] },
    pageCount: { type: "integer", minimum: 0 },
    postCount: { type: "integer", minimum: 0 },
    apiCount: { type: "integer", minimum: 0 },
    hasError: { type: "boolean" },
    createdAt: { type: "string" },
  },
  required: [
    "id", "scope", "siteId", "status", "pageCount", "postCount", "apiCount", "hasError", "createdAt",
  ],
  additionalProperties: false,
};
const stringOrStrings: AdminJsonSchema = {
  oneOf: [
    { type: "string", minLength: 1 },
    { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
  ],
};
const configSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    site: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        basePath: { type: "string", pattern: "^/" },
        canonicalUrl: { type: "string", minLength: 1 },
        defaultLocale: { type: "string", minLength: 1 },
        showFooter: { type: "boolean" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    compat: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["none", "fumadocs-v15"] },
        allowRawHtml: { type: "boolean", const: false },
      },
      required: ["preset"],
      additionalProperties: false,
    },
    content: {
      type: "object",
      properties: {
        root: { type: "string", minLength: 1 },
        docsDir: stringOrStrings,
        pagesDir: { type: "string", minLength: 1 },
        blogDir: { type: "string", minLength: 1 },
        apiDir: { type: "string", minLength: 1 },
        assetsDir: { type: "string", minLength: 1 },
        metaFileName: { type: "string", minLength: 1 },
      },
      required: ["root"],
      additionalProperties: false,
    },
  },
  required: ["schemaVersion", "site", "content"],
  additionalProperties: false,
};
const siteUpsertSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    config: configSchema,
  },
  required: ["id", "name", "config"],
  additionalProperties: false,
};
const buildListSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    ...pageInputSchema.properties,
    siteId: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};
const runBuildSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    siteId: { type: "string", minLength: 1 },
    preview: { type: "boolean" },
  },
  required: ["siteId"],
  additionalProperties: false,
};

function pageSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: item },
      nextCursor: { type: ["string", "null"] },
    },
    required: ["items", "nextCursor"],
    additionalProperties: false,
  };
}
function itemSchema(item: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: { item },
    required: ["item"],
    additionalProperties: false,
  };
}
function acceptedSchema(item?: AdminObjectSchema): AdminObjectSchema {
  return {
    type: "object",
    properties: { accepted: { type: "boolean", const: true }, ...(item ? { item } : {}) },
    required: item ? ["accepted", "item"] : ["accepted"],
    additionalProperties: false,
  };
}
function operation<TInput, TOutput>() {
  return <const TId extends string>(
    value: AdminOperationDefinition<TInput, TOutput> & { readonly id: TId },
  ): AdminOperationDefinition<TInput, TOutput> & { readonly id: TId } => value;
}

const readSafety = {
  classification: "read",
  idempotent: true,
  requiresConfirmation: false,
  audit: "optional",
} as const;
const writeSafety = {
  classification: "write",
  idempotent: true,
  requiresConfirmation: false,
  audit: "required",
} as const;

const operations = [
  operation<DocsFnPageInput, Page<DocsFnSiteView>>()({
    id: "docsfn.sites.list",
    title: "List sites",
    description: "List DocsFn sites.",
    inputSchema: pageInputSchema,
    outputSchema: pageSchema(siteViewSchema),
    route: { method: "GET", path: "/resources/sites" },
    permission: "docsfn.sites.read",
    minimumScope: "project",
    safety: readSafety,
    pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 100 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "sites", collection: true },
  }),
  operation<IdInput, Item<DocsFnSiteView>>()({
    id: "docsfn.sites.get",
    title: "Get site",
    description: "Get DocsFn site metadata.",
    inputSchema: idSchema,
    outputSchema: itemSchema(siteViewSchema),
    route: { method: "GET", path: "/resources/sites/:id" },
    permission: "docsfn.sites.read",
    minimumScope: "project",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "sites", idInput: "id" },
  }),
  operation<SiteUpsertInput, AcceptedItem<DocsFnSiteView>>()({
    id: "docsfn.sites.upsert",
    title: "Upsert site",
    description: "Create or update a DocsFn site configuration.",
    inputSchema: siteUpsertSchema,
    outputSchema: acceptedSchema(siteViewSchema),
    route: { method: "POST", path: "/resources/sites/actions/upsert" },
    permission: "docsfn.sites.write",
    minimumScope: "project",
    safety: writeSafety,
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    target: { resource: "sites", idInput: "id" },
  }),
  operation<IdInput, Accepted>()({
    id: "docsfn.sites.delete",
    title: "Delete site",
    description: "Delete a DocsFn site configuration.",
    inputSchema: idSchema,
    outputSchema: acceptedSchema(),
    route: { method: "POST", path: "/resources/sites/actions/delete" },
    permission: "docsfn.sites.delete",
    minimumScope: "project",
    safety: {
      classification: "destructive",
      idempotent: true,
      requiresConfirmation: true,
      confirmation: {
        risk: "high",
        method: "recent-auth",
        reason: "Deleting a docs site removes its operator configuration.",
        maxAgeSeconds: 300,
      },
      audit: "required",
    },
    mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    target: { resource: "sites", idInput: "id" },
  }),
  operation<BuildListInput, Page<DocsFnBuildView>>()({
    id: "docsfn.builds.list",
    title: "List builds",
    description: "List DocsFn build results.",
    inputSchema: buildListSchema,
    outputSchema: pageSchema(buildViewSchema),
    route: { method: "GET", path: "/resources/builds" },
    permission: "docsfn.builds.read",
    minimumScope: "project",
    safety: readSafety,
    pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 100 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "builds", collection: true },
  }),
  operation<IdInput, Item<DocsFnBuildView>>()({
    id: "docsfn.builds.get",
    title: "Get build",
    description: "Get one DocsFn build result without internal error details.",
    inputSchema: idSchema,
    outputSchema: itemSchema(buildViewSchema),
    route: { method: "GET", path: "/resources/builds/:id" },
    permission: "docsfn.builds.read",
    minimumScope: "project",
    safety: readSafety,
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    target: { resource: "builds", idInput: "id" },
  }),
  operation<RunBuildInput, AcceptedItem<DocsFnBuildView>>()({
    id: "docsfn.builds.run",
    title: "Run build",
    description: "Compile a configured DocsFn site from its provider.",
    inputSchema: runBuildSchema,
    outputSchema: acceptedSchema(buildViewSchema),
    route: { method: "POST", path: "/resources/builds/actions/run" },
    permission: "docsfn.builds.run",
    minimumScope: "project",
    safety: {
      classification: "write",
      idempotent: false,
      requiresConfirmation: true,
      confirmation: {
        risk: "high",
        method: "explicit",
        reason: "Running a documentation build reads the configured provider and produces externally consumable build output.",
        maxAgeSeconds: 300,
      },
      audit: "required",
    },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    target: { resource: "builds", collection: true },
  }),
] as const;

export const docsFnAdminResources = [
  {
    id: "sites",
    label: "Docs Sites",
    description: "Scope-owned DocsFn site configurations.",
    icon: "docsfn:sites",
    risk: "standard",
    minimumScope: "project",
    idField: "id",
    displayFields: ["id", "name", "title", "basePath", "updatedAt"],
    searchableFields: ["id", "name", "title"],
    filterableFields: [],
    sortableFields: ["name", "updatedAt"],
    sensitiveFields: [],
  },
  {
    id: "builds",
    label: "Docs Builds",
    description: "Immutable results from the DocsFn compiler.",
    icon: "docsfn:builds",
    risk: "standard",
    minimumScope: "project",
    idField: "id",
    displayFields: ["id", "siteId", "status", "pageCount", "createdAt"],
    searchableFields: ["id", "siteId"],
    filterableFields: ["siteId", "status"],
    sortableFields: ["createdAt"],
    sensitiveFields: ["error"],
  },
] as const;

export const docsFnAdminActions = operations;
export const docsFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "docsfn",
  displayName: "DocsFn",
  version: "1.1.0",
  description: "Scope-owned DocsFn site registry and compiler build service.",
  category: "developer-tools",
  availability: "optional-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: docsFnAdminResources,
  navigation: [{
    id: "docsfn",
    label: "DocsFn",
    path: "/modules/docsfn",
    icon: "docsfn",
    description: "Operate docs sites and builds.",
    order: 100,
  }],
  operations,
});

type DocsFnCapabilityClient = ReturnType<typeof createCapabilityAdminClient<typeof docsFnAdminCapability>>;
export interface DocsFnAdminClient extends DocsFnCapabilityClient {
  readonly sites: {
    list(input?: DocsFnPageInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.sites.list"]>;
    get(input: IdInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.sites.get"]>;
    upsert(input: SiteUpsertInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.sites.upsert"]>;
    delete(input: IdInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.sites.delete"]>;
  };
  readonly builds: {
    list(input?: BuildListInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.builds.list"]>;
    get(input: IdInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.builds.get"]>;
    run(input: RunBuildInput, options?: AdminClientRequestOptions): ReturnType<DocsFnCapabilityClient["operations"]["docsfn.builds.run"]>;
  };
}

export function createDocsFnAdminClient(adminClient: AdminClient): DocsFnAdminClient {
  const client = createCapabilityAdminClient(docsFnAdminCapability, adminClient);
  return Object.assign(client, {
    sites: {
      list: (input: DocsFnPageInput = {}, options?: AdminClientRequestOptions) => client.invoke("docsfn.sites.list", input, options),
      get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("docsfn.sites.get", input, options),
      upsert: (input: SiteUpsertInput, options?: AdminClientRequestOptions) => client.invoke("docsfn.sites.upsert", input, options),
      delete: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("docsfn.sites.delete", input, options),
    },
    builds: {
      list: (input: BuildListInput = {}, options?: AdminClientRequestOptions) => client.invoke("docsfn.builds.list", input, options),
      get: (input: IdInput, options?: AdminClientRequestOptions) => client.invoke("docsfn.builds.get", input, options),
      run: (input: RunBuildInput, options?: AdminClientRequestOptions) => client.invoke("docsfn.builds.run", input, options),
    },
  });
}

type ServiceMethod<TInput> = (
  input: TInput,
  context: AdminOperationContext,
) => Promise<unknown>;
function bind<TInput>(handler: ServiceMethod<TInput>) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

export function createDocsFnAdminAdapter(
  service: DocsFnOperatorService,
): AdminCapabilityAdapter<typeof docsFnAdminCapability> {
  return createAdminCapabilityAdapter(docsFnAdminCapability, {
    "docsfn.sites.list": bind(service.listSites),
    "docsfn.sites.get": bind(service.getSite),
    "docsfn.sites.upsert": bind(service.upsertSite),
    "docsfn.sites.delete": bind(service.deleteSite),
    "docsfn.builds.list": bind(service.listBuilds),
    "docsfn.builds.get": bind(service.getBuild),
    "docsfn.builds.run": bind(service.runBuild),
  });
}

export const adminCapability = docsFnAdminCapability;
export const createAdminAdapter = createDocsFnAdminAdapter;
