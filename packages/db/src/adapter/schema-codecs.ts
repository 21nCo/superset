import type {
  Adapter,
  AdapterSchemaInput,
  CountParams,
  CreateSchemaParams,
  CreateManyParams,
  CreateParams,
  DateFieldStorageType,
  DateFieldValueType,
  DeleteManyParams,
  DeleteParams,
  FieldSchema,
  FindManyParams,
  FindOneParams,
  TableSchemaMap,
  TableSchema,
  TransactionAdapter,
  UpdateManyParams,
  UpdateParams,
  UpsertParams,
  WhereClause,
} from "./types.js";

export function normalizeAdapterSchema(
  input: AdapterSchemaInput | undefined,
): TableSchemaMap {
  if (!input) {
    return {};
  }

  if (Array.isArray(input)) {
    return Object.fromEntries(
      input.map((table) => [readSchemaModelName(table), table]),
    );
  }

  const maybeSchemaDefinition = input as { schemas?: unknown };
  if (Array.isArray(maybeSchemaDefinition.schemas)) {
    return Object.fromEntries(
      maybeSchemaDefinition.schemas.map((table) => [
        readSchemaModelName(table),
        table,
      ]),
    );
  }

  return input as TableSchemaMap;
}

export function transformRecordForStorage<T>(
  schema: TableSchemaMap,
  model: string,
  record: T,
): T {
  return transformRecord(schema, model, record, "storage");
}

export function transformRecordForRuntime<T>(
  schema: TableSchemaMap,
  model: string,
  record: T,
): T {
  return transformRecord(schema, model, record, "runtime");
}

export function transformWhereForStorage(
  schema: TableSchemaMap,
  model: string,
  where: WhereClause[] | undefined,
): WhereClause[] | undefined {
  const table = Object.prototype.hasOwnProperty.call(schema, model) ? schema[model] : undefined;
  if (!table || !where?.length) {
    return where;
  }

  return where.map((clause) => {
    const field = table.fields[clause.field];
    if (!isDateField(field)) {
      return clause;
    }

    const convert = (value: unknown) =>
      convertDateForStorage(value, field, `${model}.${clause.field}`);
    const value =
      clause.operator === "in" || clause.operator === "not_in"
        ? readWhereArrayValue(clause.value, `${model}.${clause.field}`).map(
            convert,
          )
        : convert(clause.value);

    return {
      ...clause,
      value,
    };
  });
}

export function wrapWithSchema(
  adapter: Adapter,
  schemaInput: AdapterSchemaInput,
): Adapter {
  const schema = normalizeAdapterSchema(schemaInput);

  return {
    ...adapter,
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    capabilities: adapter.capabilities,
    internal: adapter.internal,
    create: async <T = any>(params: CreateParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.create<T>({
          ...params,
          data: transformRecordForStorage(schema, params.model, params.data),
        }),
      ),
    createMany: async <T = any>(params: CreateManyParams): Promise<T[]> =>
      (
        await adapter.createMany<T>({
          ...params,
          data: params.data.map((record) =>
            transformRecordForStorage(schema, params.model, record),
          ),
        })
      ).map((record) =>
        transformRecordForRuntime(schema, params.model, record),
      ),
    findOne: async <T = any>(params: FindOneParams): Promise<T | null> => {
      const result = await adapter.findOne<T>({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      });
      return result
        ? transformRecordForRuntime(schema, params.model, result)
        : null;
    },
    findMany: async <T = any>(params: FindManyParams): Promise<T[]> =>
      (
        await adapter.findMany<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
        })
      ).map((record) =>
        transformRecordForRuntime(schema, params.model, record),
      ),
    update: async <T = any>(params: UpdateParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.update<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
          data: transformRecordForStorage(schema, params.model, params.data),
        }),
      ),
    updateMany: (params: UpdateManyParams): Promise<number> =>
      adapter.updateMany({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
        data: transformRecordForStorage(schema, params.model, params.data),
      }),
    delete: (params: DeleteParams): Promise<void> =>
      adapter.delete({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      }),
    deleteMany: (params: DeleteManyParams): Promise<number> =>
      adapter.deleteMany({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      }),
    upsert: async <T = any>(params: UpsertParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.upsert<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
          create: transformRecordForStorage(
            schema,
            params.model,
            params.create,
          ),
          update: transformRecordForStorage(
            schema,
            params.model,
            params.update,
          ),
        }),
      ),
    count: (params: CountParams): Promise<number> =>
      adapter.count({
        ...params,
        where: transformWhereForStorage(schema, params.model, params.where),
      }),
    transaction: <R>(
      callback: (trx: TransactionAdapter) => Promise<R>,
    ): Promise<R> =>
      adapter.transaction((trx) =>
        callback(wrapTransactionWithSchema(trx, schema)),
      ),
    initialize: (): Promise<void> => adapter.initialize(),
    isHealthy: () => adapter.isHealthy(),
    close: (): Promise<void> => adapter.close(),
    getSchemaVersion: (namespace: string): Promise<number> =>
      adapter.getSchemaVersion(namespace),
    setSchemaVersion: (namespace: string, version: number): Promise<void> =>
      adapter.setSchemaVersion(namespace, version),
    validateSchema: (schemaToValidate: TableSchema) =>
      adapter.validateSchema(schemaToValidate),
    createSchema: adapter.createSchema
      ? (params: CreateSchemaParams) => adapter.createSchema!(params)
      : undefined,
  };
}

function readSchemaModelName(table: unknown): string {
  const modelName = (table as { modelName?: unknown })?.modelName;
  if (typeof modelName !== "string" || modelName.trim().length === 0) {
    throw new TypeError("Adapter schema table is missing a valid modelName");
  }
  return modelName;
}

function readWhereArrayValue(value: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${fieldPath} where value must be an array for in/not_in operators`,
    );
  }
  return value;
}

function wrapTransactionWithSchema(
  adapter: TransactionAdapter,
  schema: TableSchemaMap,
): TransactionAdapter {
  return {
    ...adapter,
    create: async <T = any>(params: CreateParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.create<T>({
          ...params,
          data: transformRecordForStorage(schema, params.model, params.data),
        }),
      ),
    createMany: async <T = any>(params: CreateManyParams): Promise<T[]> =>
      (
        await adapter.createMany<T>({
          ...params,
          data: params.data.map((record) =>
            transformRecordForStorage(schema, params.model, record),
          ),
        })
      ).map((record) =>
        transformRecordForRuntime(schema, params.model, record),
      ),
    findOne: async <T = any>(params: FindOneParams): Promise<T | null> => {
      const result = await adapter.findOne<T>({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      });
      return result
        ? transformRecordForRuntime(schema, params.model, result)
        : null;
    },
    findMany: async <T = any>(params: FindManyParams): Promise<T[]> =>
      (
        await adapter.findMany<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
        })
      ).map((record) =>
        transformRecordForRuntime(schema, params.model, record),
      ),
    update: async <T = any>(params: UpdateParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.update<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
          data: transformRecordForStorage(schema, params.model, params.data),
        }),
      ),
    updateMany: (params: UpdateManyParams): Promise<number> =>
      adapter.updateMany({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
        data: transformRecordForStorage(schema, params.model, params.data),
      }),
    delete: (params: DeleteParams): Promise<void> =>
      adapter.delete({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      }),
    deleteMany: (params: DeleteManyParams): Promise<number> =>
      adapter.deleteMany({
        ...params,
        where:
          transformWhereForStorage(schema, params.model, params.where) ??
          params.where,
      }),
    upsert: async <T = any>(params: UpsertParams): Promise<T> =>
      transformRecordForRuntime(
        schema,
        params.model,
        await adapter.upsert<T>({
          ...params,
          where:
            transformWhereForStorage(schema, params.model, params.where) ??
            params.where,
          create: transformRecordForStorage(
            schema,
            params.model,
            params.create,
          ),
          update: transformRecordForStorage(
            schema,
            params.model,
            params.update,
          ),
        }),
      ),
    count: (params: CountParams): Promise<number> =>
      adapter.count({
        ...params,
        where: transformWhereForStorage(schema, params.model, params.where),
      }),
  };
}

function transformRecord<T>(
  schema: TableSchemaMap,
  model: string,
  record: T,
  direction: "storage" | "runtime",
): T {
  if (!record || typeof record !== "object" || record instanceof Date) {
    return record;
  }

  const table = Object.prototype.hasOwnProperty.call(schema, model) ? schema[model] : undefined;
  if (!table) {
    return record;
  }

  let changed = false;
  const next = { ...(record as Record<string, unknown>) };

  for (const [fieldName, field] of Object.entries(table.fields)) {
    if (!isDateField(field) || !(fieldName in next)) {
      continue;
    }

    const value = next[fieldName];
    const converted =
      direction === "storage"
        ? convertDateForStorage(value, field, `${model}.${fieldName}`)
        : convertDateForRuntime(value, field, `${model}.${fieldName}`);
    if (converted !== value) {
      next[fieldName] = converted;
      changed = true;
    }
  }

  return changed ? (next as T) : record;
}

function isDateField(field: FieldSchema | undefined): field is FieldSchema {
  return field?.type === "date" || field?.type === "datetime";
}

function convertDateForStorage(
  value: unknown,
  field: FieldSchema,
  fieldPath: string,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  switch (resolveDateStorageType(field)) {
    case "timestamp":
    case "timestamptz":
      return toDate(value, fieldPath);
    case "iso-text":
      return toIsoString(value, fieldPath);
    case "epoch-ms-integer":
    case "epoch-ms-bigint":
      return toEpochMs(value, fieldPath);
  }
}

function convertDateForRuntime(
  value: unknown,
  field: FieldSchema,
  fieldPath: string,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  switch (resolveDateValueType(field)) {
    case "date":
      return toDate(value, fieldPath);
    case "iso-string":
      return toIsoString(value, fieldPath);
    case "epoch-ms":
      return toEpochMs(value, fieldPath);
  }
}

function resolveDateValueType(field: FieldSchema): DateFieldValueType {
  return field.dateValueType ?? "date";
}

function resolveDateStorageType(field: FieldSchema): DateFieldStorageType {
  if (field.dateStorageType) {
    return field.dateStorageType;
  }

  switch (resolveDateValueType(field)) {
    case "date":
      return "timestamp";
    case "iso-string":
      return "iso-text";
    case "epoch-ms":
      return "epoch-ms-bigint";
  }
}

function toDate(value: unknown, fieldPath: string): Date {
  if (value instanceof Date) {
    assertValidDate(value, fieldPath);
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    assertValidDate(date, fieldPath);
    return date;
  }

  throw new TypeError(
    `${fieldPath} must be a Date, ISO string, or epoch milliseconds`,
  );
}

function toIsoString(value: unknown, fieldPath: string): string {
  return toDate(value, fieldPath).toISOString();
}

function toEpochMs(value: unknown, fieldPath: string): number {
  if (typeof value === "number") {
    assertFiniteEpoch(value, fieldPath);
    return value;
  }

  const ms = toDate(value, fieldPath).getTime();
  assertFiniteEpoch(ms, fieldPath);
  return ms;
}

function assertValidDate(value: Date, fieldPath: string): void {
  assertFiniteEpoch(value.getTime(), fieldPath);
}

function assertFiniteEpoch(value: number, fieldPath: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${fieldPath} must be a valid date`);
  }
}
