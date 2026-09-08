# @datafn/server

HTTP server runtime for DataFn. Provides DFQL query execution, mutations with idempotency and optimistic concurrency, atomic transactions, full bidirectional sync (clone/pull/push/reconcile/seed), per-user/tenant isolation, REST endpoint generation, WebSocket real-time updates, plugin hooks, and configurable limits.

## Installation

```bash
npm install @datafn/server @datafn/core @superfunctions/db @superfunctions/http @superfunctions/http-hono hono @hono/node-server
```

## Features

| Feature | Description |
|---------|-------------|
| **Query Execution** | DFQL queries with filtering, sorting, pagination, relations, aggregations |
| **Mutations** | CRUD with idempotency (`clientId` + `mutationId` deduplication) and optimistic concurrency (`if` guards) |
| **Relation Operations** | `relate`, `unrelate`, `modifyRelation` for many-many and other relation types |
| **Transactions** | Atomic multi-step operations with query + mutation steps |
| **Sync: Clone** | Full data download for initial hydration |
| **Sync: Pull** | Incremental cursor-based change sync |
| **Sync: Push** | Upload offline mutations from client changelog |
| **Sync: Reconcile** | Detect and resolve local/remote drift |
| **Sync: Seed** | Seed data into the database |
| **Authorization** | Per-action authorization hook |
| **Multi-User Isolation** | Per-user/tenant namespace isolation for change tracking |
| **Multi-Region Gateway** | Atomic tenant placement, pre-execution cell fencing, signed internal forwarding, bounded stale-epoch retry, and controlled moves |
| **REST Endpoints** | Optional REST wrappers over DFQL (GET/POST/PATCH/DELETE) |
| **WebSocket** | Real-time cursor broadcast for live updates |
| **Plugins** | Hook into queries, mutations, and sync on the server side |
| **Sequence Store** | Pluggable serverSeq backend: Database, Redis, KV, or chained store |
| **Payload Limits** | Configurable max query limits, transaction steps, and payload size |
| **KV Resource** | Built-in key-value resource auto-included in schema |

Multi-region gateway mode is opt-in and keeps ownership separate from the
permission-directory projection. See
[`multi-region-gateway.mdx`](../docs/content/docs/documentation/multi-region-gateway.mdx)
for configuration, error, WebSocket, consistency, migration, and operations
contracts.

### Resource selectors for gateways and authorization plugins

Use `extractDatafnResourceSelectors` as the supported security-sensitive
integration point when routing or authorizing a parsed DataFn request before
dispatch. Pass the action derived from the matched route, the validated JSON
payload, the exported protocol-envelope version, and the server's DataFn
schema:

```ts
import {
  DATAFN_PROTOCOL_ENVELOPE_VERSION,
  extractDatafnResourceSelectors,
} from "@datafn/server";

const selectors = extractDatafnResourceSelectors(
  {
    version: DATAFN_PROTOCOL_ENVELOPE_VERSION,
    action: "transact",
    payload: parsedJson,
  },
  datafnSchema,
);
```

The result contains schema-validated resource names in first-seen order with
duplicates removed. The parser understands every DataFn route shape, including
batch operations and wrapped or bare transaction steps. Operations that omit an
optional resource list, such as search and clone, resolve to the full schema.

Do not recursively inspect request JSON. Records, filters, metadata, relation
values, and other application-owned objects may legitimately contain keys named
`resource` or `resources`; the selector API deliberately ignores them. Invalid
selectors, malformed protocol structure, and unsupported envelope versions
throw `DatafnResourceSelectorError` with a stable `code` and `path`.

### Initial region placement

DataFn provides reusable region selection without embedding a product's data
residency or capacity policy:

```typescript
import {
  readDatafnCloudflarePlacementLocation,
  selectDatafnPlacementRegion,
} from "@datafn/server/placement";

const decision = selectDatafnPlacementRegion({
  candidates: regions,
  location: readDatafnCloudflarePlacementLocation(request),
  constraints: [
    (region) => allowedRegionIds.includes(region.regionId),
    (region) => healthyRegionIds.has(region.regionId),
  ],
});
```

An eligible explicit preference wins first, trusted coordinates or continent
metadata rank the remaining regions by distance, and an optional `stableKey`
enables deterministic fallback. The returned decision records which source was
used. Applications remain responsible for defining eligible regions, collecting
explicit organization choices, and atomically claiming the resulting namespace
through the placement directory.

---

## Quick Start

```typescript
import { createDatafnServer } from "@datafn/server";
import { drizzleAdapter } from "@superfunctions/db/adapters";
import { toHono } from "@superfunctions/http-hono";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const server = await createDatafnServer({
  schema: {
    resources: [
      {
        name: "tasks",
        version: 1,
        fields: [
          { name: "id", type: "string", required: true, unique: true },
          { name: "title", type: "string", required: true },
          { name: "completed", type: "boolean", required: true, default: false },
        ],
      },
    ],
  },
  database: drizzleAdapter({ db: myDrizzleInstance, dialect: "postgres" }),
  authorize: async (ctx, action, payload) => {
    return true; // Allow all (replace with real logic)
  },
});

const app = new Hono();
app.route("/", toHono(server.router));
serve({ fetch: app.fetch, port: 3000 });
```

---

## Configuration

### DatafnServerConfig

```typescript
interface DatafnServerConfig<TContext = any> {
  /** DataFn schema — validated and normalized at startup */
  schema: DatafnSchema;

  /** Database adapter (e.g. drizzleAdapter, memoryAdapter) */
  database?: Adapter;

  /** Server-side plugins */
  plugins?: DatafnPlugin[];

  /**
   * Authorization callback. Called on every request after JSON parsing.
   * Return true to allow, false to reject with 403 FORBIDDEN.
   */
  authorize?: (
    ctx: TContext,
    action:
      | "status" | "query" | "mutation" | "transact"
      | "seed" | "clone" | "pull" | "push" | "reconcile",
    payload: unknown,
  ) => Promise<boolean> | boolean;

  /** Static request context or a request-scoped context factory. */
  context?: TContext | ((request: Request) => Promise<TContext> | TContext);

  /** Configurable limits */
  limits?: {
    /** Maximum number of records per query (default: 100) */
    maxLimit?: number;
    /** Maximum transaction steps */
    maxTransactSteps?: number;
    /** Maximum request body size in bytes */
    maxPayloadBytes?: number;
  };

  /** Custom server time provider (for testing) */
  getServerTime?: () => number;

  /**
   * Enable REST endpoint generation.
   * When true, generates REST wrappers alongside DFQL endpoints.
   */
  rest?: boolean;

  /**
   * Auth context provider for per-user/tenant isolation.
   * Extracts user/tenant context from request to create isolated namespaces.
   */
  authContextProvider?: {
    getContext: (ctx: TContext) => AuthContext | Promise<AuthContext>;
  };

  /** Trusted namespace and optional actor derivation from request context. */
  namespaceProvider?: {
    getNamespace: (ctx: TContext) => string | Promise<string>;
    getActorId?: (ctx: TContext) => string | undefined | Promise<string | undefined>;
  };

  /**
   * Redis adapter for atomic operations (serverSeq, rate limiting, caching).
   * Used when dbMapping.serverseq = "redis".
   */
  redis?: RedisAdapter;

  /**
   * KV store adapter for simple key-value operations.
   * Must support incr() for serverSeq. Used when dbMapping.serverseq = "kv".
   */
  kvStore?: KVStoreAdapter;

  /**
   * Database mapping — choose which backend for each concern.
   * Default: main database for everything.
   */
  dbMapping?: DbMapping;
}
```

### DbMapping

Route different server concerns to different backends:

```typescript
type DbMapping = {
  /** Backend for serverSeq counter: "db" | "redis" | "kv" */
  serverseq?: "db" | "redis" | "kv";
  /** Backend for rate limiting */
  ratelimiting?: "db" | "redis" | "kv";
  /** Backend for caching */
  cache?: "db" | "redis" | "kv";
};
```

---

## Endpoints

### GET /datafn/status

Server health check, schema hash, capabilities, and limits.

```json
{
  "ok": true,
  "result": {
    "schemaHash": "a1b2c3...",
    "capabilities": [
      "dfql.query", "dfql.mutation", "dfql.transact",
      "sync.seed", "sync.clone", "sync.pull", "sync.push", "sync.reconcile"
    ],
    "limits": { "maxLimit": 100 },
    "serverTimeMs": 1707000000000
  }
}
```

### POST /datafn/query

Execute DFQL queries with full filtering, sorting, pagination, and relation expansion.

**Request:**

```json
{
  "resource": "tasks",
  "version": 1,
  "select": ["id", "title", "completed"],
  "filters": { "completed": false },
  "sort": ["title:asc"],
  "limit": 20
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "data": [
      { "id": "task:1", "title": "Buy milk", "completed": false }
    ],
    "nextCursor": null
  }
}
```

**Filter operators:**

| Operator | Example | Description |
|----------|---------|-------------|
| `eq` (implicit) | `{ "status": "active" }` | Equals |
| `eq` (explicit) | `{ "status": { "eq": "active" } }` | Equals |
| `ne` | `{ "status": { "ne": "archived" } }` | Not equals |
| `gt` / `gte` | `{ "age": { "gt": 18 } }` | Greater than / or equal |
| `lt` / `lte` | `{ "age": { "lt": 65 } }` | Less than / or equal |
| `like` | `{ "name": { "like": "%john%" } }` | Case-sensitive pattern match |
| `ilike` | `{ "name": { "ilike": "%john%" } }` | Case-insensitive pattern match |
| `is_null` | `{ "deletedAt": { "is_null": true } }` | Is null |
| `is_not_null` | `{ "email": { "is_not_null": true } }` | Is not null |
| `in` | `{ "status": { "in": ["active", "pending"] } }` | In set |
| `nin` | `{ "status": { "nin": ["archived"] } }` | Not in set |
| `contains` | `{ "tags": { "contains": "urgent" } }` | Array/JSON contains |

**Logical groups:**

```json
{
  "$or": [
    { "status": "active" },
    { "priority": { "gte": 4 } }
  ]
}
```

### POST /datafn/search

Execute cross-resource search through the configured server `searchProvider`.

**Request:**

```json
{
  "query": "test",
  "resources": ["tasks", "projects"],
  "limit": 20,
  "prefix": true,
  "fuzzy": 0.2,
  "fieldBoosts": { "title": 2, "name": 1 }
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "results": [
      { "resource": "tasks", "id": "task:1", "score": 12.34, "data": {} }
    ]
  }
}
```

Search option parity with client paths:

- `prefix` enables prefix matching.
- `fuzzy` enables fuzzy matching.
- `fieldBoosts` applies field-level weighting.

These options are validated at route/query boundaries and forwarded to provider execution.

**Aggregation queries:**

```json
{
  "resource": "tasks",
  "version": 1,
  "groupBy": ["status"],
  "aggregations": {
    "count": { "fn": "count" },
    "avgPriority": { "fn": "avg", "field": "priority" }
  },
  "having": { "count": { "gt": 5 } }
}
```

### POST /datafn/mutation

Execute mutations with idempotency and optimistic concurrency.

**Insert:**

```json
{
  "resource": "tasks",
  "version": 1,
  "operation": "insert",
  "clientId": "client:device-1",
  "mutationId": "m-001",
  "record": { "title": "New task", "completed": false }
}
```

**Merge (partial update):**

```json
{
  "resource": "tasks",
  "version": 1,
  "operation": "merge",
  "clientId": "client:device-1",
  "mutationId": "m-002",
  "id": "task:abc",
  "record": { "completed": true }
}
```

**Delete:**

```json
{
  "resource": "tasks",
  "version": 1,
  "operation": "delete",
  "clientId": "client:device-1",
  "mutationId": "m-003",
  "id": "task:abc"
}
```

**Optimistic concurrency (if guards):**

```json
{
  "resource": "tasks",
  "version": 1,
  "operation": "merge",
  "id": "task:abc",
  "record": { "status": "completed" },
  "if": { "status": "in_progress" }
}
```

The mutation is rejected with `CONFLICT` if the guard condition is not met.

**Relation operations:**

```json
{
  "resource": "tasks",
  "version": 1,
  "operation": "relate",
  "id": "task:1",
  "relation": "tags",
  "targetId": "tag:urgent"
}
```

| Operation | Description |
|-----------|-------------|
| `relate` | Create a relation between records |
| `unrelate` | Remove a relation |
| `modifyRelation` | Update relation metadata |

**Response:**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "mutationId": "m-001",
    "affectedIds": ["task:new-uuid"],
    "errors": [],
    "deduped": false
  }
}
```

- `deduped: true` means the mutation was already applied (idempotency).

### POST /datafn/transact

Atomic multi-step transactions mixing queries and mutations.

**Request:**

```json
{
  "transactionId": "tx-batch",
  "atomic": true,
  "steps": [
    {
      "query": {
        "resource": "tasks",
        "version": 1,
        "select": ["id"],
        "filters": { "completed": false }
      }
    },
    {
      "mutation": {
        "resource": "tasks",
        "version": 1,
        "operation": "merge",
        "id": "task:1",
        "record": { "completed": true }
      }
    }
  ]
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "results": [
      { "kind": "query", "ok": true, "result": { "data": [...] } },
      { "kind": "mutation", "ok": true, "result": { ... } }
    ]
  }
}
```

### POST /datafn/clone

Full data download for initial hydration. Supports pagination.

**Request:**

```json
{
  "version": 1,
  "tables": ["tasks", "categories"]
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "data": {
      "tasks": [{ "id": "task:1", "title": "..." }],
      "categories": [{ "id": "cat:1", "name": "..." }]
    },
    "cursors": {
      "tasks": "42",
      "categories": "15"
    }
  }
}
```

### POST /datafn/pull

Incremental sync — only returns changes since the last cursor.

**Request:**

```json
{
  "version": 1,
  "cursors": {
    "tasks": "42",
    "categories": "15"
  }
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "records": {
      "tasks": [{ "id": "task:3", "title": "New since last pull", "__deleted": false }]
    },
    "cursors": {
      "tasks": "44",
      "categories": "15"
    }
  }
}
```

### POST /datafn/push

Upload offline mutations from the client changelog.

**Request:**

```json
{
  "version": 1,
  "mutations": [
    {
      "resource": "tasks",
      "version": 1,
      "operation": "insert",
      "clientId": "client:device-1",
      "mutationId": "m-offline-1",
      "record": { "title": "Created offline" }
    }
  ]
}
```

### POST /datafn/reconcile

Detect and resolve drift between local and remote state.

**Request:**

```json
{
  "version": 1,
  "counts": {
    "tasks": 42,
    "categories": 8
  }
}
```

### POST /datafn/seed

Seed data into the database.

**Request:**

```json
{
  "data": {
    "tasks": [
      { "id": "task:seed-1", "title": "Seeded Task", "completed": false }
    ]
  }
}
```

---

## Multi-User / Multi-Tenant Isolation

Isolate change tracking per user or tenant. Each namespace gets its own `serverSeq` counter, ensuring users see only their own changes.

```typescript
const server = await createDatafnServer({
  schema,
  database: adapter,
  authContextProvider: {
    getContext: (ctx) => ({
      userId: ctx.session?.userId,
      tenantId: ctx.session?.tenantId,
    }),
  },
});
```

**Namespace format:**
- No auth: `datafn` (default)
- Single-tenant: `user:${userId}`
- Multi-tenant: `tenant:${tenantId}:user:${userId}`

**Behavior:**
1. On each request, `authContextProvider.getContext(ctx)` is called
2. A namespace is derived from `userId` and optional `tenantId`
3. All change tracking (serverSeq, change records) uses this namespace
4. Pull/clone only returns changes from the user's namespace
5. If `getContext()` fails, falls back to default `datafn` namespace

---

## Sequence Store

The server uses a `SequenceStore` for generating monotonically increasing sequence numbers. Choose the backend that fits your infrastructure:

```typescript
// Default: use main database
const server = await createDatafnServer({
  schema,
  database: adapter,
});

// Redis for high-throughput atomic INCR
const server = await createDatafnServer({
  schema,
  database: adapter,
  redis: myRedisAdapter,
  dbMapping: { serverseq: "redis" },
});

// KV store (e.g. Cloudflare KV, DynamoDB)
const server = await createDatafnServer({
  schema,
  database: adapter,
  kvStore: myKVAdapter,
  dbMapping: { serverseq: "kv" },
});
```

**Available implementations:**

| Store | Backend | Best for |
|-------|---------|----------|
| `DatabaseSequenceStore` | Main DB | Simple deployments |
| `RedisSequenceStore` | Redis | High throughput, atomic INCR |
| `KVSequenceStore` | KV store | Serverless environments |
| `ChainedSequenceStore` | Chain | Primary + database chain (e.g. Redis → DB) |

### createSequenceStore(config)

Factory that creates the appropriate store based on `dbMapping`:

```typescript
import { createSequenceStore } from "@datafn/server";

const store = createSequenceStore({
  db: myAdapter,
  redis: myRedisAdapter,
  dbMapping: { serverseq: "redis" },
});
```

---

## REST Endpoints (Optional)

Enable REST wrappers alongside DFQL endpoints:

```typescript
const server = await createDatafnServer({
  schema,
  database: adapter,
  rest: true, // Enable REST endpoints
});
```

**Generated routes:**

| Method | Path | Maps to |
|--------|------|---------|
| GET | `/datafn/resources/:resource` | Query wrapper |
| POST | `/datafn/resources/:resource` | Insert wrapper |
| PATCH | `/datafn/resources/:resource/:id` | Merge wrapper |
| DELETE | `/datafn/resources/:resource/:id` | Delete wrapper |

---

## WebSocket

The server exposes a WebSocket handler for real-time cursor broadcasts:

```typescript
const server = await createDatafnServer({ schema, database: adapter });

// Wire WebSocket connections to server handler
wss.on("connection", (ws) => {
  const client = { id: ws.id, send: (msg) => ws.send(msg) };
  server.websocketHandler.addClient(client);
  ws.on("message", (data) => server.websocketHandler.handleMessage(client, data));
  ws.on("close", () => server.websocketHandler.removeClient(client));
});
```

---

## Plugins

Server-side plugins intercept queries, mutations, and sync:

```typescript
const auditPlugin: DatafnPlugin = {
  name: "server-audit",
  runsOn: ["server"],

  afterMutation(ctx, mutation, result) {
    console.log("Server mutation:", mutation);
  },

  beforeSync(ctx, phase, payload) {
    console.log(`Sync ${phase} started`);
    return payload; // Return modified payload or original
  },
};

const server = await createDatafnServer({
  schema,
  database: adapter,
  plugins: [auditPlugin],
});
```

---

## Server Instance

`createDatafnServer` returns a `DatafnServer`:

```typescript
interface DatafnServer<TContext = any> {
  /** HTTP router — wire to your framework (Hono, Express, etc.) */
  router: Router<TContext>;

  /** WebSocket handler for real-time updates */
  websocketHandler: {
    addClient(client: WebSocketClient): void;
    removeClient(client: WebSocketClient): void;
    handleMessage(client: WebSocketClient, data: string): void;
  };
}
```

Use `@superfunctions/http-hono` or `@superfunctions/http-express` to mount the router:

```typescript
// Hono
import { toHono } from "@superfunctions/http-hono";
app.route("/", toHono(server.router));

// Express
import { toExpress } from "@superfunctions/http-express";
app.use("/", toExpress(server.router));
```

---

## Exports

```typescript
// Server factory and types
export { createDatafnServer }
export type { DatafnServerConfig, DatafnServer }
export type { StatusResult }

// Sequence store
export type { SequenceStore, DbMapping }
export {
  createSequenceStore,
  RedisSequenceStore,
  KVSequenceStore,
  DatabaseSequenceStore,
  ChainedSequenceStore,
}
```

## License

MIT
