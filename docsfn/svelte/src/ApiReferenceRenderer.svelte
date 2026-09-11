<script lang="ts">
  import type { ApiReference } from "@docsfn/core/browser";
  import { Tabs, TabsList, TabsTrigger, TabsContent } from "@uifn/svelte";

  export let api: ApiReference;

  interface RenderParameter {
    name: string;
    in: string;
    required: boolean;
    description?: string;
    schemaType?: string;
  }

  interface RenderMediaContent {
    mediaType: string;
    example?: unknown;
  }

  interface RenderResponse {
    statusCode: string;
    description?: string;
  }

  interface RenderOperation {
    id: string;
    method: string;
    path: string;
    routePath: string;
    summary?: string;
    description?: string;
    parameters: RenderParameter[];
    requestBody?: {
      content: RenderMediaContent[];
    };
    responses: RenderResponse[];
  }

  interface RenderSchema {
    name: string;
    description?: string;
    schema: unknown;
    routePath: string;
  }

  interface RenderTag {
    name: string;
    routePath: string;
  }

  interface RenderSpecModel {
    title: string;
    version?: string;
    description?: string;
    operations: RenderOperation[];
    schemas: RenderSchema[];
    tags: RenderTag[];
  }

  const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"];

  function compareStrings(left: string, right: string): number {
    return left.localeCompare(right, "en", {
      sensitivity: "variant",
      numeric: true,
    });
  }

  function normalizeSpecModel(input: ApiReference): RenderSpecModel | null {
    if (!input.spec || typeof input.spec !== "object") {
      return null;
    }

    const spec = input.spec as Record<string, unknown>;
    const info =
      typeof spec.info === "object" && spec.info !== null
        ? (spec.info as Record<string, unknown>)
        : {};
    const title =
      (typeof info.title === "string" && info.title.length > 0 ? info.title : input.title) ||
      input.title;

    if (Array.isArray(spec.operations)) {
      const operations = spec.operations as RenderOperation[];
      const schemas = Array.isArray(spec.schemas) ? (spec.schemas as RenderSchema[]) : [];
      const tags = Array.isArray(spec.tags)
        ? (spec.tags as Array<{ name?: string; routePath?: string }>)
            .filter((tag) => typeof tag.name === "string" && typeof tag.routePath === "string")
            .map((tag) => ({ name: tag.name as string, routePath: tag.routePath as string }))
        : [];

      return {
        title,
        version: typeof info.version === "string" ? info.version : undefined,
        description: typeof info.description === "string" ? info.description : undefined,
        operations,
        schemas,
        tags,
      };
    }

    const paths =
      typeof spec.paths === "object" && spec.paths !== null
        ? (spec.paths as Record<string, unknown>)
        : {};
    const operations: RenderOperation[] = [];

    for (const path of Object.keys(paths).sort(compareStrings)) {
      const pathRecord =
        typeof paths[path] === "object" && paths[path] !== null
          ? (paths[path] as Record<string, unknown>)
          : {};

      for (const method of Object.keys(pathRecord).sort(compareStrings)) {
        const methodUpper = method.toUpperCase();
        if (!METHOD_ORDER.includes(methodUpper)) {
          continue;
        }

        const operation =
          typeof pathRecord[method] === "object" && pathRecord[method] !== null
            ? (pathRecord[method] as Record<string, unknown>)
            : {};

        const parameters = Array.isArray(operation.parameters)
          ? operation.parameters.map((parameter) => {
              const record =
                typeof parameter === "object" && parameter !== null
                  ? (parameter as Record<string, unknown>)
                  : {};
              const schema =
                typeof record.schema === "object" && record.schema !== null
                  ? (record.schema as Record<string, unknown>)
                  : {};

              return {
                name: typeof record.name === "string" ? record.name : "param",
                in: typeof record.in === "string" ? record.in : "query",
                required: Boolean(record.required),
                description:
                  typeof record.description === "string" ? record.description : undefined,
                schemaType: typeof schema.type === "string" ? schema.type : undefined,
              };
            })
          : [];

        const responses =
          typeof operation.responses === "object" && operation.responses !== null
            ? Object.keys(operation.responses as Record<string, unknown>)
                .sort(compareStrings)
                .map((statusCode) => {
                  const responseRecord =
                    typeof (operation.responses as Record<string, unknown>)[statusCode] === "object" &&
                    (operation.responses as Record<string, unknown>)[statusCode] !== null
                      ? ((operation.responses as Record<string, unknown>)[statusCode] as Record<string, unknown>)
                      : {};

                  return {
                    statusCode,
                    description:
                      typeof responseRecord.description === "string"
                        ? responseRecord.description
                        : undefined,
                  };
                })
            : [];

        const requestBody =
          typeof operation.requestBody === "object" && operation.requestBody !== null
            ? {
                content:
                  typeof (operation.requestBody as Record<string, unknown>).content === "object" &&
                  (operation.requestBody as Record<string, unknown>).content !== null
                    ? Object.keys((operation.requestBody as Record<string, unknown>).content as Record<string, unknown>)
                        .sort(compareStrings)
                        .map((mediaType) => {
                          const mediaRecord =
                            typeof ((operation.requestBody as Record<string, unknown>).content as Record<string, unknown>)[mediaType] === "object" &&
                            ((operation.requestBody as Record<string, unknown>).content as Record<string, unknown>)[mediaType] !== null
                              ? (((operation.requestBody as Record<string, unknown>).content as Record<string, unknown>)[mediaType] as Record<string, unknown>)
                              : {};
                          return {
                            mediaType,
                            example: mediaRecord.example,
                          };
                        })
                    : [],
              }
            : undefined;

        operations.push({
          id:
            typeof operation.operationId === "string" && operation.operationId.length > 0
              ? operation.operationId
              : `${method.toLowerCase()}:${path}`,
          method: methodUpper,
          path,
          routePath: `${input.path}/operations/${method.toLowerCase()}-${path
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase()}`,
          summary: typeof operation.summary === "string" ? operation.summary : undefined,
          description:
            typeof operation.description === "string" ? operation.description : undefined,
          parameters,
          requestBody,
          responses,
        });
      }
    }

    operations.sort((left, right) => {
      const leftWeight = METHOD_ORDER.indexOf(left.method);
      const rightWeight = METHOD_ORDER.indexOf(right.method);
      if (leftWeight !== rightWeight) {
        return leftWeight - rightWeight;
      }
      const pathComparison = compareStrings(left.path, right.path);
      if (pathComparison !== 0) {
        return pathComparison;
      }
      return compareStrings(left.id, right.id);
    });

    return {
      title,
      version: typeof info.version === "string" ? info.version : undefined,
      description: typeof info.description === "string" ? info.description : undefined,
      operations,
      schemas: [],
      tags: [],
    };
  }

  let expandedOperations: Record<string, boolean> = {};

  function toggleOperation(operationRoute: string) {
    expandedOperations = {
      ...expandedOperations,
      [operationRoute]: !(expandedOperations[operationRoute] ?? api.path === operationRoute),
    };
  }

  $: model = normalizeSpecModel(api);
</script>

{#if !model}
  <div class="docsfn-api-error">
    <p>Invalid API specification</p>
  </div>
{:else}
  <div class="docsfn-api-reference">
    <div class="docsfn-api-header">
      <h1 class="docsfn-api-title">{model.title}</h1>
      {#if model.version}
        <span class="docsfn-api-version">v{model.version}</span>
      {/if}
      {#if model.description}
        <p class="docsfn-api-description">{model.description}</p>
      {/if}
    </div>

    {#if model.tags.length > 0}
      <div class="docsfn-api-tags" aria-label="API tags">
        {#each model.tags as tag (tag.routePath)}
          <a href={tag.routePath} class="docsfn-api-tag-link">{tag.name}</a>
        {/each}
      </div>
    {/if}

    <div class="docsfn-api-endpoints">
      <h2>Operations</h2>
      <div class="docsfn-api-endpoints-scroll">
          {#each model.operations as operation (operation.routePath)}
            {@const expanded = expandedOperations[operation.routePath] ?? api.path === operation.routePath}

            <div class="docsfn-api-method method-{operation.method.toLowerCase()}">
              <button
                class="docsfn-api-method-header"
                on:click={() => toggleOperation(operation.routePath)}
                data-expanded={expanded}
                aria-expanded={expanded}
              >
                <span class="docsfn-api-method-badge" data-method={operation.method.toLowerCase()}>
                  {operation.method}
                </span>
                <span class="docsfn-api-method-summary">{operation.summary || operation.path}</span>
                <span class="docsfn-api-method-route">{operation.routePath}</span>
              </button>

              {#if expanded}
                <div class="docsfn-api-method-details">
                  {#if operation.description}
                    <p class="docsfn-api-method-description">{operation.description}</p>
                  {/if}

                  <Tabs defaultValue="parameters">
                    <TabsList>
                      <TabsTrigger value="parameters">Parameters</TabsTrigger>
                      <TabsTrigger value="request">Request</TabsTrigger>
                      <TabsTrigger value="responses">Responses</TabsTrigger>
                    </TabsList>

                    <TabsContent value="parameters">
                      {#if operation.parameters.length > 0}
                        <table class="docsfn-api-params-table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>In</th>
                              <th>Type</th>
                              <th>Required</th>
                              <th>Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each operation.parameters as parameter (`${parameter.in}:${parameter.name}`)}
                              <tr>
                                <td><code>{parameter.name}</code></td>
                                <td>{parameter.in}</td>
                                <td>{parameter.schemaType || "-"}</td>
                                <td>{parameter.required ? "Yes" : "No"}</td>
                                <td>{parameter.description || "-"}</td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      {:else}
                        <p>No parameters.</p>
                      {/if}
                    </TabsContent>

                    <TabsContent value="request">
                      {#if operation.requestBody}
                        <div class="docsfn-api-request-content">
                          {#each operation.requestBody.content as media (media.mediaType)}
                            <div class="docsfn-api-request-media">
                              <h4>{media.mediaType}</h4>
                              {#if typeof media.example !== "undefined"}
                                <pre class="docsfn-api-code">{JSON.stringify(media.example, null, 2)}</pre>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <p>No request body.</p>
                      {/if}
                    </TabsContent>

                    <TabsContent value="responses">
                      {#if operation.responses.length > 0}
                        {#each operation.responses as response (response.statusCode)}
                          <div class="docsfn-api-response">
                            <span class="docsfn-api-response-code">{response.statusCode}</span>
                            <span class="docsfn-api-response-desc">{response.description || "-"}</span>
                          </div>
                        {/each}
                      {:else}
                        <p>No responses.</p>
                      {/if}
                    </TabsContent>
                  </Tabs>
                </div>
              {/if}
            </div>
          {/each}
      </div>
    </div>

    {#if model.schemas.length > 0}
      <div class="docsfn-api-schemas">
        <h2>Schemas</h2>
        <div class="docsfn-api-schemas-scroll">
            {#each model.schemas as schema (schema.routePath)}
              <div class="docsfn-api-schema">
                <h3>{schema.name}</h3>
                {#if schema.description}
                  <p>{schema.description}</p>
                {/if}
                <pre class="docsfn-api-code">{JSON.stringify(schema.schema, null, 2)}</pre>
              </div>
            {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
