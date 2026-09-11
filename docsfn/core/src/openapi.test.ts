import { describe, expect, it } from "vitest";
import {
  buildOpenApiReference,
  parseOpenApiSource,
  resolveOpenApiRoute,
  type CanonicalOpenApiReference,
} from "./openapi";

function createJsonSpec(): string {
  return JSON.stringify(
    {
      openapi: "3.0.3",
      info: {
        title: "Core API",
        version: "1.0.0",
        description: "Core endpoints",
      },
      tags: [{ name: "core", description: "Core routes" }],
      paths: {
        "/search": {
          get: {
            tags: ["core"],
            summary: "Search documents",
            responses: {
              "200": {
                description: "ok",
              },
            },
          },
        },
        "/index": {
          post: {
            tags: ["core"],
            summary: "Index document",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  example: { id: "doc_1" },
                },
              },
            },
            responses: {
              "202": {
                description: "accepted",
              },
            },
          },
        },
      },
      components: {
        schemas: {
          IndexRequest: {
            type: "object",
            description: "Index payload",
          },
        },
      },
      servers: [{ url: "https://api.example.com" }],
    },
    null,
    2
  );
}

function createYamlSpec(): string {
  return [
    "openapi: 3.0.3",
    "info:",
    "  title: Admin API",
    "  version: 1.0.0",
    "  description: Admin endpoints",
    "paths:",
    "  /health:",
    "    get:",
    "      operationId: getHealth",
    "      tags:",
    "        - admin",
    "      summary: Health check",
    "      responses:",
    "        \"200\":",
    "          description: ok",
    "components:",
    "  schemas:",
    "    HealthStatus:",
    "      type: object",
    "      description: Health state",
  ].join("\n");
}

function createReference(input: {
  sourceId: string;
  sourcePath: string;
  body: string;
}): CanonicalOpenApiReference {
  return buildOpenApiReference({
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    body: input.body,
    fallbackTitle: "Fallback API",
    basePath: "/docs",
  });
}

describe("OpenAPI normalization", () => {
  it("normalizes JSON and YAML sources into canonical operations/tags/schemas (TV-API-001)", () => {
    const jsonReference = createReference({
      sourceId: "api:core.json",
      sourcePath: "core.json",
      body: createJsonSpec(),
    });

    const yamlReference = createReference({
      sourceId: "api:admin.yaml",
      sourcePath: "admin.yaml",
      body: createYamlSpec(),
    });

    expect(jsonReference.sourceFormat).toBe("json");
    expect(jsonReference.tags.map((tag) => tag.name)).toEqual(["core"]);
    expect(
      jsonReference.operations.map((operation) => `${operation.method} ${operation.path}`)
    ).toEqual(["GET /search", "POST /index"]);

    expect(yamlReference.sourceFormat).toBe("yaml");
    expect(yamlReference.tags.map((tag) => tag.name)).toEqual(["admin"]);
    expect(
      yamlReference.operations.map((operation) => `${operation.method} ${operation.path}`)
    ).toEqual(["GET /health"]);
  });

  it("builds deterministic canonical output for equivalent specs (DET-001)", () => {
    const specA = {
      openapi: "3.0.3",
      info: { title: "Search API", version: "1.0.0" },
      paths: {
        "/b": {
          get: {
            responses: {
              "200": { description: "ok" },
            },
          },
        },
        "/a": {
          post: {
            responses: {
              "202": { description: "accepted" },
            },
          },
        },
      },
    };
    const specB = {
      ...specA,
      paths: {
        "/a": specA.paths["/a"],
        "/b": specA.paths["/b"],
      },
    };

    const referenceA = createReference({
      sourceId: "api:index-a.json",
      sourcePath: "index.json",
      body: JSON.stringify(specA),
    });
    const referenceB = createReference({
      sourceId: "api:index-a.json",
      sourcePath: "index.json",
      body: JSON.stringify(specB),
    });

    expect(JSON.stringify(referenceA)).toBe(JSON.stringify(referenceB));
  });

  it("derives overview, tag, and operation routes from normalized API records (TV-API-002)", () => {
    const reference = createReference({
      sourceId: "api:index.json",
      sourcePath: "index.json",
      body: createJsonSpec(),
    });

    expect(reference.routes.overview).toBe("/docs/api");
    expect(reference.routes.tags.core).toBe("/docs/api/tags/core");
    expect(reference.routes.all).toContain("/docs/api/operations/post-index");

    const resolved = resolveOpenApiRoute(reference, "/docs/api/operations/post-index");
    expect(resolved.kind).toBe("operation");
  });

  it("throws DOCS_OPENAPI_PARSE_FAILED for malformed YAML input (TV-API-001 negative)", () => {
    expect(() =>
      createReference({
        sourceId: "api:admin.yaml",
        sourcePath: "admin.yaml",
        body: "openapi: 3.0.3\npaths:\n  /health: [",
      })
    ).toThrowError(/DOCS_OPENAPI_PARSE_FAILED|could not be parsed/);
  });

  it("throws DOCS_OPENAPI_PARSE_FAILED for cyclic YAML aliases", () => {
    expect(() =>
      parseOpenApiSource({
        sourceId: "api:cycle.yaml",
        sourcePath: "cycle.yaml",
        body: [
          "openapi: 3.0.3",
          "info: &cycle",
          "  title: Cycle",
          "  version: '1.0.0'",
          "  extra: *cycle",
          "paths: {}",
        ].join("\n"),
      })
    ).toThrowError(/DOCS_OPENAPI_PARSE_FAILED|cyclic/);
  });

  it("throws DOCS_OPENAPI_PARSE_FAILED for unsupported OpenAPI versions", () => {
    expect(() =>
      createReference({
        sourceId: "api:swagger.json",
        sourcePath: "swagger.json",
        body: JSON.stringify({
          swagger: "2.0",
          info: { title: "Legacy", version: "1.0.0" },
          paths: {},
        }),
      })
    ).toThrowError(/DOCS_OPENAPI_PARSE_FAILED|unsupported OpenAPI version/);
  });

  it("throws DOCS_OPENAPI_PARSE_FAILED for duplicate operation IDs", () => {
    expect(() =>
      createReference({
        sourceId: "api:dup.json",
        sourcePath: "dup.json",
        body: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Dup", version: "1.0.0" },
          paths: {
            "/one": {
              get: {
                operationId: "duplicateOp",
                responses: { "200": { description: "ok" } },
              },
            },
            "/two": {
              post: {
                operationId: "duplicateOp",
                responses: { "200": { description: "ok" } },
              },
            },
          },
        }),
      })
    ).toThrowError(/DOCS_OPENAPI_PARSE_FAILED|duplicate operationId/);
  });

  it("rejects collisions between generated operation routes", () => {
    expect(() =>
      createReference({
        sourceId: "api:routes.json",
        sourcePath: "routes.json",
        body: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Routes", version: "1.0.0" },
          paths: {
            "/user-id": { get: { responses: { "200": { description: "ok" } } } },
            "/user/{id}": { get: { responses: { "200": { description: "ok" } } } },
          },
        }),
      })
    ).toThrowError(/duplicate operation route/);
  });

  it("rejects case-folded explicit operation route collisions", () => {
    expect(() =>
      createReference({
        sourceId: "api:operations.json",
        sourcePath: "operations.json",
        body: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Operations", version: "1.0.0" },
          paths: {
            "/one": { get: { operationId: "Get-User", responses: { "200": { description: "ok" } } } },
            "/two": { get: { operationId: "get-user", responses: { "200": { description: "ok" } } } },
          },
        }),
      })
    ).toThrowError(/duplicate operation route/);
  });

  it("rejects generated tag and schema route collisions", () => {
    for (const body of [
      {
        openapi: "3.0.3",
        info: { title: "Tags", version: "1.0.0" },
        tags: [{ name: "User API" }, { name: "user-api" }],
        paths: {},
      },
      {
        openapi: "3.0.3",
        info: { title: "Schemas", version: "1.0.0" },
        paths: {},
        components: { schemas: { "User ID": {}, "user-id": {} } },
      },
    ]) {
      expect(() =>
        createReference({
          sourceId: "api:collision.json",
          sourcePath: "collision.json",
          body: JSON.stringify(body),
        })
      ).toThrowError(/duplicate (tag|schema) route/);
    }
  });

  it("throws DOCS_OPENAPI_PARSE_FAILED for malformed path operations", () => {
    expect(() =>
      createReference({
        sourceId: "api:bad.json",
        sourcePath: "bad.json",
        body: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Bad", version: "1.0.0" },
          paths: {
            "/broken": {
              get: "not-an-object",
            },
          },
        }),
      })
    ).toThrowError(/DOCS_OPENAPI_PARSE_FAILED|malformed GET \/broken operation/);
  });

  it("throws DOCS_ROUTE_NOT_FOUND when resolving a missing API route (TV-API-002 negative)", () => {
    const reference = createReference({
      sourceId: "api:index.json",
      sourcePath: "index.json",
      body: createJsonSpec(),
    });

    expect(() => resolveOpenApiRoute(reference, "/docs/api/operations/get-missing")).toThrowError(
      /DOCS_ROUTE_NOT_FOUND|was not generated/
    );
  });
});

it("resolves local parameter references and emits single-slash root routes", () => {
  const reference = buildOpenApiReference({ sourceId: "api:x.json", sourcePath: "x.json", fallbackTitle: "X", basePath: "/", body: JSON.stringify({ openapi: "3.0.3", info: { title: "X", version: "1" }, components: { parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" } } } }, paths: { "/items/{id}": { parameters: [{ $ref: "#/components/parameters/Id" }], get: { responses: {} } } } }) });
  expect(reference.routes.overview).toBe("/api/x");
  expect(reference.operations[0].parameters[0]).toMatchObject({ name: "id", in: "path", required: true, schemaType: "string" });
});
it("rejects explicit operation IDs that collide with generated IDs", () => {
  expect(() => createReference({ sourceId: "api:x.json", sourcePath: "x.json", body: JSON.stringify({ openapi: "3.0.3", info: { title: "X", version: "1" }, paths: { "/a": { get: { responses: {} } }, "/b": { get: { operationId: "get:/a", responses: {} } } } }) })).toThrow(/duplicate operationId/);
});
