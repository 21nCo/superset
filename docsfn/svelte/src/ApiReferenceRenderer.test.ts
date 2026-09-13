import { describe, expect, it } from "vitest";
import type { ApiReference } from "@docsfn/core";

function createCanonicalApiFixture(): ApiReference {
  return {
    kind: "api",
    id: "api:index.json",
    slug: "",
    path: "/docs/api",
    title: "Search API",
    frontmatter: {},
    spec: {
      info: {
        title: "Search API",
        version: "1.0.0",
      },
      operations: [
        {
          id: "get:/search",
          method: "GET",
          path: "/search",
          routePath: "/docs/api/operations/get-search",
          parameters: [],
          responses: [{ statusCode: "200", description: "ok", content: [] }],
        },
        {
          id: "post:/index",
          method: "POST",
          path: "/index",
          routePath: "/docs/api/operations/post-index",
          parameters: [
            {
              name: "x-org-id",
              in: "header",
              required: true,
              schemaType: "string",
            },
          ],
          requestBody: {
            content: [
              {
                mediaType: "application/json",
                example: { id: "doc_1", text: "hello" },
              },
            ],
          },
          responses: [{ statusCode: "202", description: "accepted", content: [] }],
        },
      ],
      schemas: [
        {
          name: "IndexRequest",
          routePath: "/docs/api/schemas/indexrequest",
          description: "Index payload",
          schema: { type: "object" },
        },
      ],
      tags: [
        { name: "indexing", routePath: "/docs/api/tags/indexing" },
        { name: "search", routePath: "/docs/api/tags/search" },
      ],
    },
  };
}

describe("ApiReferenceRenderer canonical model contract", () => {
  it("preserves deterministic operation and schema order for renderer parity", () => {
    const api = createCanonicalApiFixture();

    const operationRoutes = (api.spec as { operations: Array<{ routePath: string }> }).operations.map(
      (operation) => operation.routePath
    );
    expect(operationRoutes).toEqual([
      "/docs/api/operations/get-search",
      "/docs/api/operations/post-index",
    ]);

    const schemaNames = (api.spec as { schemas: Array<{ name: string }> }).schemas.map(
      (schema) => schema.name
    );
    expect(schemaNames).toEqual(["IndexRequest"]);
  });
});
