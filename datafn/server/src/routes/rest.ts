/**
 * REST Route Handlers
 *
 * Provides schema-driven REST wrappers for DFQL query/mutation.
 */

import type { DatafnSchema } from "../core-types.js";
import { errorResponse } from "../http/errors.js";
import { jsonResponse, getBodyFromContext } from "../http/json.js";
import type { Route } from "@superfunctions/http";
import type { DatafnLogger } from "../logger.js";

/**
 * SEC-010: Sanitize a URL path segment against path traversal attacks.
 * URL-decodes the segment and rejects if it contains '..', null bytes, or encoded '/'.
 * Returns the decoded segment or throws an error object.
 */
export function sanitizePathSegment(segment: string): { ok: true; value: string } | { ok: false } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return { ok: false };
  }
  // Reject null bytes
  if (decoded.includes("\0")) return { ok: false };
  // Reject path traversal
  if (decoded === ".." || decoded.includes("/..") || decoded.includes("../")) return { ok: false };
  // Reject decoded forward slash (encoded as %2F)
  if (decoded.includes("/") && segment.toLowerCase().includes("%2f")) return { ok: false };
  return { ok: true, value: decoded };
}

const PATH_TRAVERSAL_ERROR = {
  code: "DFQL_INVALID" as const,
  message: "Invalid path segment",
  details: { path: "resource" },
};

// Use Record<string, any> or generic for execute callbacks
type RestRouteContext<TContext> = TContext & { parsedBody?: unknown };
type MutationExecutor<TContext> = (
  m: unknown,
  ctx?: RestRouteContext<TContext>,
) => Promise<unknown>;
type QueryExecutor<TContext> = (
  q: unknown,
  ctx?: RestRouteContext<TContext>,
) => Promise<unknown>;

export function createRestRoutes<TContext>(
  schema: DatafnSchema,
  executeMutation: MutationExecutor<TContext>,
  executeQuery: QueryExecutor<TContext>,
  logger?: DatafnLogger,
): Route<TContext>[] {
  const resources = new Set(
    schema.resources.map((r: { name: string }) => r.name),
  );

  // Helper to get resource version from schema (REST-001)
  const getResourceVersion = (resourceName: string): number => {
    const resource = schema.resources.find((r: any) => r.name === resourceName);
    return resource?.version ?? 1;
  };

  const validateResource = (resource: string) => {
    if (!resources.has(resource)) {
      throw {
        code: "DFQL_UNKNOWN_RESOURCE",
        message: `Unknown resource: ${resource}`,
        details: { path: "resource", resource },
      };
    }
  };

  return [
    // GET /datafn/resources/:resource - Query Wrapper
    {
      method: "GET",
      path: "/datafn/resources/:resource",
      handler: async (req, ctx: RestRouteContext<TContext>) => {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const rawResource = pathParts[3] ?? "";

        // SEC-010: Sanitize path segment against traversal attacks
        const sanitized = sanitizePathSegment(rawResource);
        if (!sanitized.ok) {
          return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        }
        const resource = sanitized.value;

        try {
          validateResource(resource);

          // REST-003: Parse q as URL-encoded JSON, default to {}
          const qStr = url.searchParams.get("q");
          let queryBody: any;

          if (!qStr) {
            queryBody = {};
          } else {
            try {
              queryBody = JSON.parse(qStr);
            } catch (parseError) {
              // REST-003: Invalid JSON in q returns DFQL_INVALID with path:"q"
              return errorResponse(
                {
                  code: "DFQL_INVALID",
                  message: "Invalid JSON",
                  details: { path: "q" },
                },
                400,
              );
            }
          }

          // REST-001: Inject version from schema
          const dfql = {
            ...queryBody,
            resource,
            version: getResourceVersion(resource),
          };

          const result = await executeQuery(dfql, ctx);
          return jsonResponse({ ok: true, result });
        } catch (err: any) {
          if (err.code === "DFQL_UNKNOWN_RESOURCE") {
            return errorResponse(err, 400);
          }
          logger?.error("REST GET failed", { error: String(err), resource, operation: "rest-get" });
          return errorResponse(err);
        }
      },
    },

    // POST /datafn/resources/:resource - Mutation (Merge/Insert) Wrapper
    {
      method: "POST",
      path: "/datafn/resources/:resource",
      handler: async (req, ctx: RestRouteContext<TContext>) => {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const rawResource = pathParts[3] ?? "";

        // SEC-010: Sanitize path segment against traversal attacks
        const sanitizedResource = sanitizePathSegment(rawResource);
        if (!sanitizedResource.ok) {
          return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        }
        const resource = sanitizedResource.value;

        try {
          validateResource(resource);
          const parseResult = await getBodyFromContext(req, ctx);
          if (!parseResult.ok) {
            return errorResponse(parseResult.error, 400);
          }
          const body = parseResult.data as any;

          // REST-002: Require deterministic clientId and mutationId
          // Check query params first, then body
          const clientId = url.searchParams.get("clientId") || body.clientId;
          const mutationId =
            url.searchParams.get("mutationId") || body.mutationId;

          if (!clientId || typeof clientId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: clientId is required",
                details: { path: "clientId" },
              },
              400,
            );
          }

          if (!mutationId || typeof mutationId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: mutationId is required",
                details: { path: "mutationId" },
              },
              400,
            );
          }

          // REST-004: Default operation to "merge" when absent
          const mutation = {
            resource,
            version: getResourceVersion(resource), // REST-001
            operation: body.operation || "merge",
            clientId,
            mutationId,
            id: body.id,
            record: body.record,
          };

          const result = await executeMutation(mutation, ctx);
          return jsonResponse({ ok: true, result });
        } catch (err: any) {
          if (err.code === "DFQL_UNKNOWN_RESOURCE") {
            return errorResponse(err, 400);
          }
          logger?.error("REST POST failed", { error: String(err), resource, operation: "rest-post" });
          return errorResponse(err);
        }
      },
    },

    // PATCH /datafn/resources/:resource/:id - Merge Wrapper
    {
      method: "PATCH",
      path: "/datafn/resources/:resource/:id",
      handler: async (req, ctx: RestRouteContext<TContext>) => {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const rawResource = pathParts[3] ?? "";
        const rawId = pathParts[4] ?? "";

        // SEC-010: Sanitize path segments against traversal attacks
        const sanitizedResource = sanitizePathSegment(rawResource);
        if (!sanitizedResource.ok) return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        const sanitizedId = sanitizePathSegment(rawId);
        if (!sanitizedId.ok) return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        const resource = sanitizedResource.value;
        const id = sanitizedId.value;

        try {
          validateResource(resource);
          const parseResult = await getBodyFromContext(req, ctx);
          if (!parseResult.ok) {
            return errorResponse(parseResult.error, 400);
          }
          const body = parseResult.data as any;

          // REST-002: Require deterministic clientId and mutationId
          const clientId = url.searchParams.get("clientId") || body.clientId;
          const mutationId =
            url.searchParams.get("mutationId") || body.mutationId;

          if (!clientId || typeof clientId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: clientId is required",
                details: { path: "clientId" },
              },
              400,
            );
          }

          if (!mutationId || typeof mutationId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: mutationId is required",
                details: { path: "mutationId" },
              },
              400,
            );
          }

          const mutation = {
            resource,
            version: getResourceVersion(resource), // REST-001
            operation: "merge",
            clientId,
            mutationId,
            id: id,
            record: body.record,
          };

          const result = await executeMutation(mutation, ctx);
          return jsonResponse({ ok: true, result });
        } catch (err: any) {
          if (err.code === "DFQL_UNKNOWN_RESOURCE") {
            return errorResponse(err, 400);
          }
          logger?.error("REST PATCH failed", { error: String(err), resource, operation: "rest-patch" });
          return errorResponse(err);
        }
      },
    },

    // DELETE /datafn/resources/:resource/:id - Delete Wrapper
    {
      method: "DELETE",
      path: "/datafn/resources/:resource/:id",
      handler: async (req, ctx: RestRouteContext<TContext>) => {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const rawResource = pathParts[3] ?? "";
        const rawId = pathParts[4] ?? "";

        // SEC-010: Sanitize path segments against traversal attacks
        const sanitizedResource2 = sanitizePathSegment(rawResource);
        if (!sanitizedResource2.ok) return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        const sanitizedId2 = sanitizePathSegment(rawId);
        if (!sanitizedId2.ok) return errorResponse(PATH_TRAVERSAL_ERROR, 400);
        const resource = sanitizedResource2.value;
        const id = sanitizedId2.value;

        try {
          validateResource(resource);

          // REST-002: Require deterministic clientId and mutationId from query params
          const clientId = url.searchParams.get("clientId");
          const mutationId = url.searchParams.get("mutationId");

          if (!clientId || typeof clientId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: clientId is required",
                details: { path: "clientId" },
              },
              400,
            );
          }

          if (!mutationId || typeof mutationId !== "string") {
            return errorResponse(
              {
                code: "DFQL_INVALID",
                message: "Invalid DFQL: mutationId is required",
                details: { path: "mutationId" },
              },
              400,
            );
          }

          const mutation = {
            resource,
            version: getResourceVersion(resource), // REST-001
            operation: "delete",
            clientId,
            mutationId,
            id: id,
          };

          const result = await executeMutation(mutation, ctx);
          return jsonResponse({ ok: true, result });
        } catch (err: any) {
          if (err.code === "DFQL_UNKNOWN_RESOURCE") {
            return errorResponse(err, 400);
          }
          logger?.error("REST DELETE failed", { error: String(err), resource, operation: "rest-delete" });
          return errorResponse(err);
        }
      },
    },
  ];
}
