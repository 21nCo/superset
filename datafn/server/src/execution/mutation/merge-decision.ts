import type { DatafnSchema } from "../../core-types.js";

export type MergeDecisionMode = "update" | "create" | "not_found";

export type MergeExecutionResult =
  | { ok: true; mode: "update" | "create" | "update-retry" }
  | { ok: false; code: "NOT_FOUND" | "DFQL_INVALID" | "INTERNAL"; message: string; path: string; error?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: any): boolean {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "NotFoundError" || message.includes("not found") || message.includes("zero rows");
}

function isConflictError(error: any): boolean {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "23505" ||
    code === "UNIQUE_VIOLATION" ||
    code === "ER_DUP_ENTRY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    message.includes("duplicate") ||
    message.includes("already exists") ||
    message.includes("unique") ||
    message.includes("conflict")
  );
}

function cloneDefaultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDefaultValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneDefaultValue(child)]),
    );
  }

  return value;
}

export function decideMergeMode(
  schema: DatafnSchema,
  resource: string,
  id: string,
  delta: unknown,
): { mode: MergeDecisionMode; createRecord?: Record<string, unknown> } {
  if (!isRecord(delta)) return { mode: "not_found" };

  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef) return { mode: "not_found" };

  for (const field of resourceDef.fields) {
    if (!field.required) continue;
    if (field.name === "id" || field.name === "__ns") continue;

    const hasProvided =
      Object.prototype.hasOwnProperty.call(delta, field.name) &&
      (delta as Record<string, unknown>)[field.name] !== undefined &&
      ((delta as Record<string, unknown>)[field.name] !== null || field.nullable === true);
    const hasDefault = field.default !== undefined;

    if (!hasProvided && !hasDefault) return { mode: "not_found" };
  }

  const createRecord: Record<string, unknown> = { id, ...(delta as Record<string, unknown>) };
  for (const field of resourceDef.fields) {
    if (
      field.default !== undefined &&
      !Object.prototype.hasOwnProperty.call(createRecord, field.name)
    ) {
      createRecord[field.name] = cloneDefaultValue(field.default);
    }
  }

  return {
    mode: "create",
    createRecord,
  };
}

export async function executeSchemaAwareMerge(params: {
  schema: DatafnSchema;
  resource: string;
  id: string;
  delta: unknown;
  update: () => Promise<void>;
  create: (record: Record<string, unknown>) => Promise<void>;
  findOne?: () => Promise<unknown | null>;
}): Promise<MergeExecutionResult> {
  const { schema, resource, id, delta, update, create, findOne } = params;

  if (!isRecord(delta)) {
    return {
      ok: false,
      code: "DFQL_INVALID",
      message: "Invalid DFQL: mutation.record must be an object",
      path: "record",
    };
  }

  try {
    await update();
    if (findOne) {
      const updatedRow = await findOne();
      if (!updatedRow) {
        throw { name: "NotFoundError", message: "Record not found after update" };
      }
    }
    return { ok: true, mode: "update" };
  } catch (updateError) {
    if (!isNotFoundError(updateError)) {
      return { ok: false, code: "INTERNAL", message: "Internal error", path: "$", error: updateError };
    }
  }

  const decision = decideMergeMode(schema, resource, id, delta);
  if (decision.mode === "not_found" || !decision.createRecord) {
    return { ok: false, code: "NOT_FOUND", message: `Record not found: ${id}`, path: "id" };
  }

  try {
    await create(decision.createRecord);
    return { ok: true, mode: "create" };
  } catch (createError) {
    if (!isConflictError(createError)) {
      return { ok: false, code: "INTERNAL", message: "Internal error", path: "$", error: createError };
    }
  }

  try {
    await update();
    if (findOne) {
      const retriedRow = await findOne();
      if (!retriedRow) {
        throw { name: "NotFoundError", message: "Record not found after update retry" };
      }
    }
    return { ok: true, mode: "update-retry" };
  } catch (retryError) {
    if (isNotFoundError(retryError)) {
      return { ok: false, code: "NOT_FOUND", message: `Record not found: ${id}`, path: "id" };
    }
    return { ok: false, code: "INTERNAL", message: "Internal error", path: "$", error: retryError };
  }
}
