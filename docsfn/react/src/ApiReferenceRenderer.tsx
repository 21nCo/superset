"use client";

import React, { useMemo, useState } from "react";
import type { ApiReference } from "@docsfn/core";

export interface ApiReferenceRendererProps {
  api: ApiReference;
  className?: string;
}

interface RenderParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schemaType?: string;
  example?: unknown;
}

interface RenderMediaContent {
  mediaType: string;
  schema?: unknown;
  example?: unknown;
  examples?: Array<{ name: string; value: unknown }>;
}

interface RenderResponse {
  statusCode: string;
  description?: string;
  content: RenderMediaContent[];
}

interface RenderOperation {
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: RenderParameter[];
  requestBody?: {
    required: boolean;
    description?: string;
    content: RenderMediaContent[];
  };
  responses: RenderResponse[];
  routePath: string;
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

function SimpleTabs(input: {
  sections: Array<{ value: string; label: string; content: React.ReactNode }>;
}) {
  const [activeValue, setActiveValue] = useState(input.sections[0]?.value ?? "");
  const activeSection =
    input.sections.find((section) => section.value === activeValue) ?? input.sections[0];

  return (
    <div data-docsfn-api-tabs="true">
      <div role="tablist" aria-label="API section tabs">
        {input.sections.map((section) => {
          const selected = section.value === activeValue;
          return (
            <button
              key={section.value}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveValue(section.value)}
            >
              {section.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{activeSection?.content ?? null}</div>
    </div>
  );
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"];

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function normalizeSpecModel(api: ApiReference): RenderSpecModel | null {
  if (!api.spec || typeof api.spec !== "object") {
    return null;
  }

  const spec = api.spec as Record<string, unknown>;
  const info = (typeof spec.info === "object" && spec.info
    ? spec.info
    : {}) as Record<string, unknown>;
  const title =
    (typeof info.title === "string" && info.title.length > 0 ? info.title : api.title) ||
    api.title;

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

  const paths = (typeof spec.paths === "object" && spec.paths
    ? spec.paths
    : {}) as Record<string, unknown>;
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

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((value): value is string => typeof value === "string")
        : [];
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
              description: typeof record.description === "string" ? record.description : undefined,
              schemaType: typeof schema.type === "string" ? schema.type : undefined,
              example: record.example,
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
                  content: [],
                };
              })
          : [];

      operations.push({
        id:
          typeof operation.operationId === "string" && operation.operationId.length > 0
            ? operation.operationId
            : `${method.toLowerCase()}:${path}`,
        method: methodUpper,
        path,
        summary: typeof operation.summary === "string" ? operation.summary : undefined,
        description: typeof operation.description === "string" ? operation.description : undefined,
        tags,
        parameters,
        responses,
        routePath: `${api.path}/operations/${method.toLowerCase()}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}`,
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

export function ApiReferenceRenderer({ api, className }: ApiReferenceRendererProps) {
  const [expandedOperations, setExpandedOperations] = useState<Record<string, boolean>>({});
  const model = useMemo(() => normalizeSpecModel(api), [api]);

  if (!model) {
    return (
      <div className={`docsfn-api-error ${className || ""}`.trim()}>
        <p>Invalid API specification</p>
      </div>
    );
  }

  return (
    <div className={`docsfn-api-reference ${className || ""}`.trim()}>
      <div className="docsfn-api-header">
        <h1 className="docsfn-api-title">{model.title}</h1>
        {model.version ? <span className="docsfn-api-version">v{model.version}</span> : null}
        {model.description ? <p className="docsfn-api-description">{model.description}</p> : null}
      </div>

      {model.tags.length > 0 ? (
        <div className="docsfn-api-tags" aria-label="API tags">
          {model.tags.map((tag) => (
            <a key={tag.routePath} href={tag.routePath} className="docsfn-api-tag-link">
              {tag.name}
            </a>
          ))}
        </div>
      ) : null}

      <div className="docsfn-api-endpoints">
        <h2>Operations</h2>
        <div className="docsfn-api-endpoints-scroll">
          {model.operations.map((operation) => {
            const operationKey = operation.routePath;
            const expanded = expandedOperations[operationKey] ?? api.path === operationKey;

            return (
              <div key={operationKey} className={`docsfn-api-method method-${operation.method.toLowerCase()}`}>
                <button
                  className="docsfn-api-method-header"
                  onClick={() =>
                    setExpandedOperations((current) => ({
                      ...current,
                      [operationKey]: !expanded,
                    }))
                  }
                  data-expanded={expanded}
                  aria-expanded={expanded}
                >
                  <span className="docsfn-api-method-badge" data-method={operation.method.toLowerCase()}>
                    {operation.method}
                  </span>
                  <span className="docsfn-api-method-summary">
                    {operation.summary || operation.path}
                  </span>
                  <span className="docsfn-api-method-route">{operation.routePath}</span>
                </button>

                {expanded ? (
                  <div className="docsfn-api-method-details">
                    {operation.description ? (
                      <p className="docsfn-api-method-description">{operation.description}</p>
                    ) : null}

                    <SimpleTabs
                      sections={[
                        {
                          value: "parameters",
                          label: "Parameters",
                          content:
                            operation.parameters.length > 0 ? (
                              <table className="docsfn-api-params-table">
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
                                  {operation.parameters.map((parameter) => (
                                    <tr key={`${parameter.in}:${parameter.name}`}>
                                      <td>
                                        <code>{parameter.name}</code>
                                      </td>
                                      <td>{parameter.in}</td>
                                      <td>{parameter.schemaType || "-"}</td>
                                      <td>{parameter.required ? "Yes" : "No"}</td>
                                      <td>{parameter.description || "-"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p>No parameters.</p>
                            ),
                        },
                        {
                          value: "request",
                          label: "Request",
                          content: operation.requestBody ? (
                            <div className="docsfn-api-request-content">
                              {operation.requestBody.content.map((media) => (
                                <div key={media.mediaType} className="docsfn-api-request-media">
                                  <h4>{media.mediaType}</h4>
                                  {typeof media.example !== "undefined" ? (
                                    <pre className="docsfn-api-code">{JSON.stringify(media.example, null, 2)}</pre>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p>No request body.</p>
                          ),
                        },
                        {
                          value: "responses",
                          label: "Responses",
                          content:
                            operation.responses.length > 0 ? (
                              <>
                                {operation.responses.map((response) => (
                                  <div key={response.statusCode} className="docsfn-api-response">
                                    <span className="docsfn-api-response-code">{response.statusCode}</span>
                                    <span className="docsfn-api-response-desc">{response.description || "-"}</span>
                                  </div>
                                ))}
                              </>
                            ) : (
                              <p>No responses.</p>
                            ),
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {model.schemas.length > 0 ? (
        <div className="docsfn-api-schemas">
          <h2>Schemas</h2>
          <div className="docsfn-api-schemas-scroll">
            {model.schemas.map((schema) => (
              <div key={schema.routePath} className="docsfn-api-schema">
                <h3>{schema.name}</h3>
                {schema.description ? <p>{schema.description}</p> : null}
                <pre className="docsfn-api-code">{JSON.stringify(schema.schema, null, 2)}</pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
