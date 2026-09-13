# @datafn/core

Core types, schema validation, DFQL normalization, and shared utilities for the DataFn ecosystem. Every other DataFn package depends on `@datafn/core`.

## Installation

```bash
npm install @datafn/core
```

## Features

- **Type Definitions** — Complete TypeScript types for schemas, resources, fields, relations, events, signals, and plugins
- **Const-Safe Field Builders** — Reusable field definitions that retain literal names, defaults, and enum members
- **Schema Validation** — Runtime validation and normalization of DataFn schemas
- **DFQL Types** — Query, mutation, and transaction type definitions
- **DFQL Normalization** — Deterministic normalization for stable cache keys
- **Envelope Pattern** — Structured `ok | error` result types with helper functions
- **KV Utilities** — Built-in key-value resource helpers (`ensureBuiltinKv`, `kvId`)
- **Error Codes** — Enumerated error codes for consistent error handling

---

## Schema Definition

A DataFn schema describes your entire data model: resources (tables), their fields, and the relationships between them.

Use `defineSchema` for the full schema and `field` when fields need to be
reused. Both preserve literal names and metadata for typed clients:

```typescript
import { defineSchema, field } from "@datafn/core";

const id = field.string("id", {
  required: true,
  unique: true,
});

const sharedFields = [
  field.boolean("isStarred", { default: false }),
  field.string("status", {
    required: true,
    enum: ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"],
  }),
];

export const schema = defineSchema({
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [id, ...sharedFields],
      indices: { base: ["id", "status"] },
    },
  ],
});
```

Field builders always return plain schema objects and emit
`required: false` and `nullable: false` when those options are omitted.
Requiredness controls whether a property must exist. Nullability independently
controls whether its value may be `null`.

Inline object literals passed directly to `defineSchema` receive the same
record inference. Avoid annotating a schema or reusable field collection as
`DatafnSchema` or `DatafnFieldSchema[]` before calling `defineSchema`; those
annotations widen literal field and resource names. Use `satisfies` when you
only need an assignability check, or use the builders for reusable fields.

Builder options are specific to each field kind. Defaults and enum members must
match that kind, and options cannot override `name` or `type`. Constraint
metadata such as `enum`, bounds, patterns, uniqueness, encryption, volatility,
and read-only flags is preserved for adapters and generated schemas. Core
mutation validation currently enforces field type and nullability, not every
constraint metadata value.

### DatafnSchema

```typescript
type DatafnSchema = {
  resources: DatafnResourceSchema[];
  relations?: DatafnRelationSchema[];
};
```

### DatafnResourceSchema

Each resource maps to a table or collection in your database.

```typescript
type DatafnResourceSchema = {
  /** Unique resource name (e.g. "todos", "users") */
  name: string;
  /** Schema version — increment when making breaking changes */
  version: number;
  /** Optional prefix for generated IDs (e.g. "todo" → "todo:uuid") */
  idPrefix?: string;
  /**
   * When true, the resource is never stored locally.
   * Queries always go to the remote server.
   */
  isRemoteOnly?: boolean;
  /** Field definitions */
  fields: DatafnFieldSchema[];
  /**
   * Index hints for optimisation.
   * Can be a simple string[] (treated as base indices) or a structured object.
   */
  indices?:
    | { base?: string[]; search?: string[]; vector?: string[] }
    | string[];
  /** Optional permissions policy for server-side authorization */
  permissions?: DatafnPermissionsPolicy;
};
```

### DatafnFieldSchema

Every field has a name, type, and a rich set of optional validation constraints.

```typescript
type DatafnFieldSchema = {
  name: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "date"
    | "file"
    | "json";
  required: boolean;
  /** Allow explicit null values */
  nullable?: boolean;
  /** Prevent mutation after initial insert */
  readonly?: boolean;
  /** Default value applied on insert when the field is omitted */
  default?: unknown;
  /** Restrict to a fixed set of allowed values */
  enum?: unknown[];
  /** Minimum numeric value or minimum array length */
  min?: number;
  /** Maximum numeric value or maximum array length */
  max?: number;
  /** Minimum string length */
  minLength?: number;
  /** Maximum string length */
  maxLength?: number;
  /** Regex pattern the string value must match */
  pattern?: string;
  /**
   * Uniqueness constraint.
   * - `true` — globally unique
   * - `string` — unique within a composite group
   */
  unique?: boolean | string;
  /** Encrypt the field value at rest */
  encrypt?: boolean;
  /** Volatile fields are excluded from sync and persistence */
  volatile?: boolean;
};
```

**Supported field types:**

| Type      | Description                                     |
| --------- | ----------------------------------------------- |
| `string`  | Text values                                     |
| `number`  | Numeric values (integer or float)               |
| `boolean` | `true` / `false`                                |
| `object`  | Arbitrary JSON objects (stored as JSONB / JSON) |
| `array`   | Arbitrary JSON arrays (stored as JSONB / JSON)  |
| `date`    | Date/time values (stored as timestamps)         |
| `file`    | File references                                 |
| `json`    | Any JSON-compatible value                       |

### DatafnRelationSchema

Relations describe how resources are connected.

```typescript
type DatafnRelationSchema = {
  /** Source resource name(s) */
  from: string | string[];
  /** Target resource name(s) */
  to: string | string[];
  /** Relation cardinality */
  type: "one-many" | "many-one" | "many-many" | "htree";
  /** Forward relation name (e.g. "tags") */
  relation?: string;
  /** Inverse relation name (e.g. "todos") */
  inverse?: string;
  /** Cache relation data for faster reads */
  cache?: boolean;
  /** Extra metadata fields on the join row (many-many only) */
  metadata?: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "date" | "object";
  }>;
  /** Foreign key field name (many-one / one-many) */
  fkField?: string;
  /** Materialized path field (htree) */
  pathField?: string;
};
```

**Relation types:**

| Type        | Description              | Storage           |
| ----------- | ------------------------ | ----------------- |
| `one-many`  | Parent has many children | FK on child       |
| `many-one`  | Child belongs to parent  | FK on child       |
| `many-many` | Both sides have many     | Join table        |
| `htree`     | Hierarchical tree        | Materialized path |

### DatafnPermissionsPolicy

```typescript
type DatafnPermissionsPolicy = {
  read?: { fields: string[] };
  write?: { fields: string[] };
  ownerField?: string;
};
```

---

## Events

Events represent lifecycle notifications for mutations and sync operations.

### DatafnEvent

```typescript
interface DatafnEvent {
  type:
    | "mutation_applied" // A mutation was successfully applied
    | "mutation_rejected" // A mutation was rejected (validation, conflict, etc.)
    | "sync_applied" // A sync operation completed successfully
    | "sync_failed"; // A sync operation failed
  resource?: string; // Affected resource name
  ids?: string[]; // Affected record IDs
  mutationId?: string; // Mutation identifier
  clientId?: string; // Originating client identifier
  timestampMs: number; // Event timestamp in milliseconds
  context?: unknown; // Arbitrary context data
  action?: string; // Mutation action (insert, merge, delete, etc.)
  fields?: string[]; // Changed fields
}
```

### DatafnEventFilter

Filter which events you receive when subscribing.

```typescript
type DatafnEventFilter = Partial<{
  type: DatafnEvent["type"] | Array<DatafnEvent["type"]>;
  resource: string | string[];
  ids: string | string[];
  mutationId: string | string[];
  action: string | string[];
  fields: string | string[];
  contextKeys: string[];
  context: Record<string, unknown>;
}>;
```

---

## Signals

Signals are reactive data containers that represent live query results. They are the bridge between DataFn and your UI framework.

### DatafnSignal\<T\>

```typescript
interface DatafnSignal<T> {
  /** Get the current value synchronously */
  get(): T;
  /** Subscribe to value changes. Returns an unsubscribe function. */
  subscribe(handler: (value: T) => void): () => void;
  /** True while the initial fetch is in progress */
  readonly loading: boolean;
  /** Non-null if the last fetch/refresh failed */
  readonly error: DatafnError | null;
  /** True while a background refresh is in progress (after initial load) */
  readonly refreshing: boolean;
}
```

---

## Plugins

Plugins intercept and extend queries, mutations, and sync operations on both client and server.

### DatafnPlugin

```typescript
interface DatafnPlugin {
  name: string;
  runsOn: Array<"client" | "server">;

  /** Intercept queries before execution. Return modified query or throw to reject. */
  beforeQuery?: (
    ctx: DatafnHookContext,
    q: unknown,
  ) => Promise<unknown> | unknown;
  /** Process query results. Return modified result. */
  afterQuery?: (
    ctx: DatafnHookContext,
    q: unknown,
    result: unknown,
  ) => Promise<unknown> | unknown;

  /** Intercept mutations before execution. Return modified mutation or throw to reject. */
  beforeMutation?: (
    ctx: DatafnHookContext,
    m: unknown | unknown[],
  ) => Promise<unknown> | unknown;
  /** React to mutation results. */
  afterMutation?: (
    ctx: DatafnHookContext,
    m: unknown | unknown[],
    result: unknown,
  ) => Promise<void> | void;

  /** Intercept sync operations before execution. Return modified payload or throw to reject. */
  beforeSync?: (
    ctx: DatafnHookContext,
    phase: "seed" | "clone" | "pull" | "push" | "cloneUp" | "reconcile",
    payload: unknown,
  ) => Promise<unknown> | unknown;
  /** React to sync results. */
  afterSync?: (
    ctx: DatafnHookContext,
    phase: "seed" | "clone" | "pull" | "push" | "cloneUp" | "reconcile",
    payload: unknown,
    result: unknown,
  ) => Promise<void> | void;
}
```

### DatafnHookContext

```typescript
type DatafnHookContext = {
  env: "client" | "server";
  schema: DatafnSchema;
  context?: unknown;
};
```

---

## DFQL Types

DFQL (DataFn Query Language) defines the structure of queries, mutations, and transactions.

### DfqlQuery

```typescript
type DfqlQuery = {
  resource: string;
  version: number;
  select?: string[]; // Fields to include
  omit?: string[]; // Fields to exclude
  filters?: Record<string, unknown>; // Where clause
  search?: Record<string, unknown>; // Full-text search
  sort?: DfqlSort; // Ordering (e.g. ["-createdAt", "name"])
  limit?: number; // Max results
  offset?: number; // Skip N results
  cursor?: DfqlCursor; // Cursor-based pagination
  count?: boolean; // Return count only
  groupBy?: string[]; // Group by fields
  aggregations?: Record<string, unknown>; // Aggregate functions
  having?: Record<string, unknown>; // Having clause for groups
};
```

### DfqlQueryFragment

Omits `resource` and `version` — used with the Table API where those are implicit.

```typescript
type DfqlQueryFragment = Omit<DfqlQuery, "resource" | "version">;
```

### DfqlMutation

```typescript
type DfqlMutation = {
  resource: string;
  version: number;
  operation: string; // "insert" | "merge" | "replace" | "delete" | "relate" | "unrelate" | "modifyRelation"
  id?: string | string[]; // Target record ID(s)
  record?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
  clientId?: string; // For idempotency
  mutationId?: string; // For idempotency
  timestamp?: number | string;
  context?: unknown;
  relations?: Record<string, unknown>;
  if?: Record<string, unknown>; // Optimistic concurrency guards
  cascade?: unknown;
};
```

### DfqlMutationFragment

Omits `resource` and `version` — used with the Table API.

```typescript
type DfqlMutationFragment = Omit<DfqlMutation, "resource" | "version">;
```

### DfqlTransact

```typescript
type DfqlTransact = {
  transactionId?: string;
  atomic?: boolean;
  steps: Array<{ query?: DfqlQuery; mutation?: DfqlMutation }>;
};
```

### Sort & Cursor

```typescript
type DfqlSort = string[];
// e.g. ["name", "-createdAt"]  → name ASC, createdAt DESC (prefix "-" = descending)

type DfqlCursor = {
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
};
```

---

## Functions

### validateSchema

Validates and normalizes a DataFn schema. Returns an envelope.

```typescript
import { validateSchema, unwrapEnvelope } from "@datafn/core";

const schema = unwrapEnvelope(
  validateSchema({
    resources: [
      {
        name: "user",
        version: 1,
        fields: [
          { name: "email", type: "string", required: true, unique: true },
          { name: "name", type: "string", required: true },
        ],
      },
    ],
  }),
);
```

**Normalization applied:**

- Converts `indices: string[]` → `{ base: string[], search: [], vector: [] }`
- Defaults `relations` to `[]` if omitted
- Validates unique resource names, field names, and required properties

### normalizeDfql

Recursively normalizes a value for deterministic comparison: sorts object keys, removes `undefined` values, preserves primitives, arrays, and `null`.

```typescript
import { normalizeDfql } from "@datafn/core";

normalizeDfql({ b: 2, a: 1, c: undefined });
// → { a: 1, b: 2 }
```

### dfqlKey

Returns a stable JSON string for a DFQL value. Used as cache keys for signals.

```typescript
import { dfqlKey } from "@datafn/core";

const key = dfqlKey({ resource: "user", filters: { id: "user:1" } });
// Deterministic JSON string suitable for Map/Set keys
```

### unwrapEnvelope

Unwraps a `DatafnEnvelope`: returns `result` on success, throws the `DatafnError` on failure.

```typescript
import { unwrapEnvelope } from "@datafn/core";

const result = unwrapEnvelope(someEnvelope);
// Throws DatafnError if envelope.ok === false
```

### ok / err

Helpers to create envelopes.

```typescript
import { ok, err } from "@datafn/core";

const success = ok({ data: [1, 2, 3] });
// { ok: true, result: { data: [1, 2, 3] } }

const failure = err("NOT_FOUND", "User not found", { path: "users" });
// { ok: false, error: { code: "NOT_FOUND", message: "User not found", details: { path: "users" } } }
```

---

## KV Utilities

The built-in KV (key-value) resource provides a schemaless store that syncs alongside your typed resources.

### ensureBuiltinKv

Ensures the schema includes the built-in `kv` resource. If it already exists, validates its shape; otherwise appends it.

```typescript
import { ensureBuiltinKv } from "@datafn/core";

const schemaWithKv = ensureBuiltinKv(mySchema);
// Now includes { name: "kv", version: 1, fields: [{ name: "value", type: "object" }] }
```

### kvId

Converts a plain key string to the canonical KV record ID.

```typescript
import { kvId } from "@datafn/core";

kvId("theme"); // → "kv:theme"
kvId("user:prefs"); // → "kv:user:prefs"
```

### KV_RESOURCE_NAME

The canonical resource name for the built-in KV store: `"kv"`.

---

## Error Handling

### DatafnError

A plain object (not a class) with a structured shape.

```typescript
type DatafnError = {
  code: DatafnErrorCode;
  message: string;
  details?: unknown;
};
```

### DatafnErrorCode

```typescript
type DatafnErrorCode =
  | "SCHEMA_INVALID"
  | "DFQL_INVALID"
  | "DFQL_UNKNOWN_RESOURCE"
  | "DFQL_UNKNOWN_FIELD"
  | "DFQL_UNKNOWN_RELATION"
  | "DFQL_UNSUPPORTED"
  | "LIMIT_EXCEEDED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";
```

### DatafnEnvelope\<T\>

```typescript
type DatafnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: DatafnError };
```

---

## Full Schema Example

```typescript
import { defineSchema, field } from "@datafn/core";

const schema = defineSchema({
  resources: [
    {
      name: "project",
      version: 1,
      idPrefix: "proj",
      fields: [
        field.string("id", { required: true, unique: true }),
        field.string("name", { required: true, maxLength: 200 }),
        field.string("description"),
        field.string("ownerId", { required: true }),
        field.date("createdAt", { required: true }),
      ],
      indices: { base: ["ownerId", "createdAt"] },
    },
    {
      name: "task",
      version: 1,
      idPrefix: "task",
      fields: [
        field.string("id", { required: true, unique: true }),
        field.string("title", { required: true, minLength: 1 }),
        field.boolean("completed", { required: true, default: false }),
        field.number("priority", { min: 1, max: 5 }),
        field.date("dueDate"),
        field.string("projectId", { required: true }),
      ],
      indices: { base: ["projectId", "completed"] },
    },
    {
      name: "tag",
      version: 1,
      idPrefix: "tag",
      fields: [
        field.string("id", { required: true, unique: true }),
        field.string("name", { required: true, unique: true }),
        field.string("color"),
      ],
    },
  ],
  relations: [
    {
      from: "task",
      to: "project",
      type: "many-one",
      relation: "project",
      fkField: "projectId",
    },
    {
      from: "task",
      to: "tag",
      type: "many-many",
      relation: "tags",
      inverse: "tasks",
    },
    {
      from: "project",
      to: "task",
      type: "one-many",
      relation: "tasks",
      inverse: "project",
    },
  ],
});
```

## License

MIT
