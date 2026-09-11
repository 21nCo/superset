import type { ErrorObject } from "ajv";

import type { McpFnSchemaIssue } from "./types.js";

const MAX_STRUCTURAL_FIELD_LENGTH = 256;

function boundedStructuralField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_STRUCTURAL_FIELD_LENGTH);
}

/** Convert Ajv failures into a stable, value-free public diagnostic shape. */
export function formatMcpFnSchemaIssues(
  errors: ErrorObject[] | null | undefined,
): McpFnSchemaIssue[] {
  return (errors ?? []).slice(0, 100).map((error) => {
    const instancePath = error.instancePath || "/";
    const params = error.params as Record<string, unknown>;
    const rejectedProperty =
      error.keyword === "additionalProperties"
        ? typeof params.additionalProperty === "string" ? params.additionalProperty : undefined
        : undefined;
    const missingProperty =
      error.keyword === "required"
        ? typeof params.missingProperty === "string" ? params.missingProperty : undefined
        : undefined;
    return {
      path: instancePath,
      instancePath,
      schemaPath: boundedStructuralField(error.schemaPath) ?? "#",
      keyword: boundedStructuralField(error.keyword) ?? "validation",
      message:
        boundedStructuralField(error.message) ?? "Schema validation failed",
      ...(rejectedProperty ? { rejectedProperty } : {}),
      ...(missingProperty ? { missingProperty } : {}),
    };
  });
}
