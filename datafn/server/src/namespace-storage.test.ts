import { describe, expect, it } from "vitest";
import {
  DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
  DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
  defineSchema,
  getCapabilityFields,
  resolveCapabilities,
  type DatafnSchema,
} from "@datafn/core";
import {
  createMemoryIndexedDirectoryStore,
  memoryAdapter,
} from "@superfunctions/db/adapters";

import {
  INTERNAL_TABLE_SCHEMAS,
  listNamespacedInternalTables,
} from "./execution/internal-tables.js";
import {
  enqueuePermissionDirectorySync,
  ensurePermissionDirectoryOutbox,
} from "./execution/mutation/permission-directory-outbox.js";
import {
  DatafnNamespaceStorageError,
  POSTGRES_NAMESPACE_STORAGE_CATALOG_SQL,
  POSTGRES_NAMESPACE_STORAGE_INDEX_SQL,
  assertInternalNamespaceStorageMetadataComplete,
  composeNamespaceStoragePlan,
  drainNamespaceStorage,
  inspectPostgresNamespaceStorage,
  namespacedInternalTableRoles,
  quotePostgresIdentifier,
  resolveNamespaceStoragePlan,
  selectNamespaceStorageEntries,
  type NamespaceStorageCatalog,
} from "./namespace-storage.js";

const schema = defineSchema({
  namespaced: true,
  resources: [
    {
      name: "tasks",
      version: 1,
      capabilities: [
        "timestamps",
        "audit",
        { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } },
      ],
      fields: [{ name: "title", type: "string", required: true }],
    },
    {
      name: "projects",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
    },
  ],
  relations: [
    {
      from: "projects",
      to: "tasks",
      type: "many-many",
      relation: "projectTasks",
    },
  ],
});

function relation(
  name: string,
  columns: readonly string[],
): NamespaceStorageCatalog["relations"][number] {
  return { name, columns, indexes: [{ columns: ["id"], unique: true, primary: true }] };
}

function installedCatalog(extra: NamespaceStorageCatalog["relations"] = []): NamespaceStorageCatalog {
  return {
    dialect: "postgres",
    relations: [
      relation("tasks", ["id", "title", "__ns", ...getCapabilityFields(resolveCapabilities(undefined, ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }])).map((field) => field.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())]),
      relation("projects", ["id", "name", "__ns"]),
      relation("__datafn_join_projects_projectTasks", ["id", "from", "to", "__ns"]),
      relation("__datafn_permissions_global", ["id", "resource_type", "resource_ns", "resource_id", "principal_id", "level", "grant_kind", "source_ref", "granted_by", "granted_at", "revoked_at", "__ns"]),
      relation("__datafn_permissions_tasks", ["id", "resource_id", "user_id", "level", "granted_by", "granted_at", "revoked_at", "__ns"]),
      relation("__datafn_principal_memberships", ["id", "namespace", "actor_id", "principal_id", "granted_at", "revoked_at", "__ns"]),
      relation("__datafn_principal_hierarchy", ["id", "namespace", "principal_id", "parent_principal_id", "created_at", "revoked_at", "__ns"]),
      ...Object.entries(INTERNAL_TABLE_SCHEMAS).map(([name, columns]) => relation(name, columns.map((column) => column.name))),
      relation("workspaces", ["id", "workspace_id", "name"]),
      ...extra,
    ],
  };
}

describe("namespace storage completeness", () => {
  it("fails when a new internal namespace table is missing from the contract", () => {
    expect(listNamespacedInternalTables()).toEqual(
      Object.keys(namespacedInternalTableRoles()).sort(),
    );
    expect(() => assertInternalNamespaceStorageMetadataComplete()).not.toThrow();
    expect(Object.keys(INTERNAL_TABLE_SCHEMAS).every((name) =>
      name.startsWith("__datafn_"),
    )).toBe(true);
  });
});

describe("resolveNamespaceStoragePlan", () => {
  it("builds a deterministic tenant plan from schema + postgres catalog", () => {
    const plan = resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() });
    expect(plan.manifestVersion).toBe(DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION);
    expect(plan.schemaVersion).toBe(DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION);
    expect(plan.entries.map((entry) => entry.relation)).toEqual([
      "tasks",
      "projects",
      "__datafn_join_projects_projectTasks",
      "__datafn_permissions_tasks",
      "__datafn_permissions_global",
      "__datafn_principal_memberships",
      "__datafn_principal_hierarchy",
      "__datafn_meta",
      "__datafn_changes",
      "__datafn_idempotency",
      "__datafn_seed",
      "__datafn_permission_directory_outbox",
    ]);
    expect(plan.entries.every((entry) => entry.ownership === "datafn")).toBe(true);
    expect(plan.entries.find((entry) => entry.relation === "tasks")).toMatchObject({
      logicalRole: "resource",
      namespaceColumn: "__ns",
      quotedRelation: '"tasks"',
    });
    expect(plan.entries.find((entry) => entry.relation === "__datafn_meta")).toMatchObject({
      logicalRole: "sync_meta",
      namespaceColumn: "namespace",
    });
    expect(
      plan.entries.find((entry) => entry.relation === "__datafn_permission_directory_outbox"),
    ).toMatchObject({
      logicalRole: "permission_directory_outbox",
      namespaceColumn: "namespace",
      operations: expect.arrayContaining(["drain", "fence", "copy"]),
    });
    expect(plan.entries.some((entry) => entry.relation === "workspaces")).toBe(false);
  });

  it("distinguishes copy, fence, and drain responsibilities", () => {
    const plan = resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() });
    const copy = selectNamespaceStorageEntries(plan, "copy").map((entry) => entry.relation);
    const cleanup = selectNamespaceStorageEntries(plan, "cleanup").map((entry) => entry.relation);
    const drain = selectNamespaceStorageEntries(plan, "drain").map((entry) => entry.relation);
    const fence = selectNamespaceStorageEntries(plan, "fence").map((entry) => entry.relation);
    expect(drain).toEqual(["__datafn_permission_directory_outbox"]);
    expect(copy).toContain("tasks");
    expect(copy).toContain("__datafn_changes");
    expect(copy[copy.length - 1]).toBe("__datafn_permission_directory_outbox");
    expect(cleanup[0]).toBe("__datafn_permission_directory_outbox");
    expect(cleanup[cleanup.length - 1]).toBe("tasks");
    expect(fence).toEqual(copy);
    expect(selectNamespaceStorageEntries(plan, "verify")).toEqual(
      selectNamespaceStorageEntries(plan, "copy"),
    );
  });

  it("fails closed on unknown DataFn internal namespace tables", () => {
    expect(() =>
      resolveNamespaceStoragePlan({
        schema,
        catalog: installedCatalog([
          relation("__datafn_new_ledger", ["id", "namespace", "payload"]),
        ]),
      }),
    ).toThrow(DatafnNamespaceStorageError);
    try {
      resolveNamespaceStoragePlan({
        schema,
        catalog: installedCatalog([
          relation("__datafn_new_ledger", ["id", "namespace", "payload"]),
        ]),
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "DATAFN_NAMESPACE_STORAGE_UNKNOWN",
        details: { relations: ["__datafn_new_ledger"] },
      });
    }
  });

  it("fails closed when a resource table is missing __ns", () => {
    const catalog = installedCatalog();
    const relations = catalog.relations.map((entry) =>
      entry.name === "tasks" ? { ...entry, columns: ["id", "title"] } : entry,
    );
    expect(() =>
      resolveNamespaceStoragePlan({ schema, catalog: { ...catalog, relations } }),
    ).toThrow(/missing selector column "__ns"/);
  });

  it("fails closed when an internal table is missing namespace", () => {
    const catalog = installedCatalog();
    const relations = catalog.relations.map((entry) =>
      entry.name === "__datafn_changes"
        ? { ...entry, columns: ["id", "server_seq"] }
        : entry,
    );
    expect(() =>
      resolveNamespaceStoragePlan({ schema, catalog: { ...catalog, relations } }),
    ).toThrow(/missing selector column "namespace"/);
  });

  it("rejects missing operational columns and missing or insufficient uniqueness", () => {
    for (const name of ["tasks", "__datafn_permission_directory_outbox"]) {
      const catalog = installedCatalog();
      const relations = catalog.relations.map((entry) => entry.name === name
        ? { ...entry, columns: [name === "tasks" ? "__ns" : "namespace"] } : entry);
      expect(() => resolveNamespaceStoragePlan({ schema, catalog: { ...catalog, relations } })).toThrow("missing required columns");
    }
    for (const indexes of [undefined, [], [{ columns: ["id"], unique: false }], [{ columns: ["id", "title"], unique: true, primary: true }]]) {
      const catalog = installedCatalog();
      const relations = catalog.relations.map((entry) => entry.name === "tasks" ? { ...entry, indexes } : entry);
      expect(() => resolveNamespaceStoragePlan({ schema, catalog: { ...catalog, relations } })).toThrow("unique identity index");
    }
  });

  it("rejects unsupported schema and manifest versions instead of a partial plan", () => {
    expect(() =>
      resolveNamespaceStoragePlan({
        schema,
        catalog: installedCatalog(),
        manifestVersion: "2",
      }),
    ).toThrow(/Unsupported namespace storage manifest version/);
    expect(() =>
      resolveNamespaceStoragePlan({
        schema,
        catalog: installedCatalog(),
        schemaVersion: "0",
      }),
    ).toThrow(/Unsupported namespace storage schema version/);
  });

  it("rejects non-namespaced schemas", () => {
    const unnamespaced = defineSchema({
      namespaced: false,
      resources: [
        {
          name: "tasks",
          version: 1,
          fields: [{ name: "title", type: "string", required: true }],
        },
      ],
    });
    expect(() =>
      resolveNamespaceStoragePlan({ schema: unnamespaced, catalog: installedCatalog() }),
    ).toThrow(/require a namespaced DataFn schema/);
  });

  it("fails closed when a required resource table is missing", () => {
    const catalog: NamespaceStorageCatalog = {
      dialect: "postgres",
      relations: [
        relation("projects", ["id", "name", "__ns"]),
        relation("__datafn_join_projects_projectTasks", ["id", "from", "to", "__ns"]),
      ],
    };
    expect(() => resolveNamespaceStoragePlan({ schema, catalog })).toThrow(
      /Required namespace storage relation "tasks" is missing/,
    );
  });

  it("fails closed on leftover __ns tables that are not in the contract", () => {
    expect(() =>
      resolveNamespaceStoragePlan({
        schema,
        catalog: installedCatalog([relation("orphan_ns_rows", ["id", "__ns"])]),
      }),
    ).toThrow(/not in the supported contract: orphan_ns_rows/);
  });

  it("omits on-demand internals that are not installed yet", () => {
    const catalog: NamespaceStorageCatalog = {
      dialect: "postgres",
      relations: [
        relation("tasks", ["id", "title", "__ns", ...getCapabilityFields(resolveCapabilities(undefined, ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }])).map((field) => field.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())]),
        relation("projects", ["id", "name", "__ns"]),
        relation("__datafn_join_projects_projectTasks", ["id", "from", "to", "__ns"]),
      ],
    };
    const plan = resolveNamespaceStoragePlan({ schema, catalog });
    expect(plan.entries.map((entry) => entry.relation)).toEqual([
      "tasks",
      "projects",
      "__datafn_join_projects_projectTasks",
    ]);
  });
});

describe("composeNamespaceStoragePlan", () => {
  it("lets consumers add application tables without claiming DataFn ownership", () => {
    const plan = composeNamespaceStoragePlan(
      resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() }),
      [{ relation: "skills", namespaceColumn: "workspace_id", copyOrder: 10 }],
    );
    expect(plan.entries[0]).toMatchObject({
      logicalRole: "application",
      ownership: "application",
      relation: "skills",
      namespaceColumn: "workspace_id",
    });
    expect(() =>
      composeNamespaceStoragePlan(plan, [{ relation: "tasks", namespaceColumn: "workspace_id" }]),
    ).toThrow(/collides with DataFn-owned storage/);
  });
});

describe("inspectPostgresNamespaceStorage", () => {
  it("maps information_schema rows through DataFn-owned SQL", async () => {
    expect(POSTGRES_NAMESPACE_STORAGE_CATALOG_SQL).toContain("information_schema.columns");
    const catalog = await inspectPostgresNamespaceStorage(async (sql) => {
      if (sql === POSTGRES_NAMESPACE_STORAGE_INDEX_SQL) return [
        { table_name: "tasks", index_columns: ["__ns", "id"], index_unique: true, index_primary: true, primary: true },
        { table_name: "__datafn_meta", index_columns: ["id"], index_unique: true, index_primary: true, primary: true },
      ];
      expect(sql).toBe(POSTGRES_NAMESPACE_STORAGE_CATALOG_SQL);
      return [
        { table_name: "tasks", column_name: "id" },
        { table_name: "tasks", column_name: "__ns" },
        { table_name: "__datafn_meta", column_name: "id" },
        { table_name: "__datafn_meta", column_name: "namespace" },
      ];
    });
    expect(catalog).toEqual({
      dialect: "postgres",
      relations: [
        { name: "__datafn_meta", columns: ["id", "namespace"], indexes: [{ columns: ["id"], unique: true, primary: true }] },
        { name: "tasks", columns: ["id", "__ns"], indexes: [{ columns: ["__ns", "id"], unique: true, primary: true }] },
      ],
    });
  });
});

describe("quotePostgresIdentifier", () => {
  it("quotes stable identifiers and rejects injection", () => {
    expect(quotePostgresIdentifier("__ns")).toBe('"__ns"');
    expect(quotePostgresIdentifier("__datafn_changes")).toBe('"__datafn_changes"');
    expect(() => quotePostgresIdentifier('tasks"; drop table tasks; --')).toThrow(
      /Invalid PostgreSQL identifier/,
    );
  });
});

describe("drainNamespaceStorage", () => {
  it("preserves active pre-commit leases and reports the namespace as pending", async () => {
    const adapter = memoryAdapter();
    await adapter.initialize();
    const runtime = { regionId: "region:test", directory: createMemoryIndexedDirectoryStore() };
    await enqueuePermissionDirectorySync(adapter, {
      operation: "unshare", resource: "tasks", id: "task:leased", scope: "record",
      shareWith: { principalId: "user:a" },
    }, "tenant:a", runtime.regionId, { pending: true });
    const before = await adapter.internal.findMany("__datafn_permission_directory_outbox", []);
    const plan = resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() });
    await expect(drainNamespaceStorage({ adapter, plan, namespace: "tenant:a", runtime }))
      .resolves.toEqual({ processed: 0, pending: 1 });
    expect(await adapter.internal.findMany("__datafn_permission_directory_outbox", [])).toEqual(before);
  });

  it("drains the permission-directory outbox for one namespace without touching another", async () => {
    const adapter = memoryAdapter();
    await adapter.initialize();
    await ensurePermissionDirectoryOutbox(adapter);
    const directory = createMemoryIndexedDirectoryStore();
    const runtime = { regionId: "region:test", directory };
    await enqueuePermissionDirectorySync(adapter, {
      operation: "unshare",
      resource: "tasks",
      id: "task:a",
      scope: "record",
      shareWith: { principalId: "user:a" },
    }, "tenant:a", runtime.regionId);
    await enqueuePermissionDirectorySync(adapter, {
      operation: "unshare",
      resource: "tasks",
      id: "task:b",
      scope: "record",
      shareWith: { principalId: "user:b" },
    }, "tenant:b", runtime.regionId);

    const plan = resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() });
    await expect(drainNamespaceStorage({
      adapter,
      plan,
      namespace: "tenant:a",
      runtime,
    })).resolves.toEqual({ processed: 1, pending: 0 });

    const remaining = await adapter.internal.findMany(
      "__datafn_permission_directory_outbox",
      [],
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.namespace).toBe("tenant:b");
  });
});

describe("empty namespaces remain copyable", () => {
  it("returns a complete plan even when no tenant rows exist", () => {
    const plan = resolveNamespaceStoragePlan({ schema, catalog: installedCatalog() });
    expect(selectNamespaceStorageEntries(plan, "copy").every((entry) => entry.present)).toBe(
      true,
    );
    expect(selectNamespaceStorageEntries(plan, "backup").length).toBeGreaterThan(0);
  });
});

describe("schema typing smoke", () => {
  it("accepts a DatafnSchema literal", () => {
    const typed: DatafnSchema = schema;
    expect(typed.resources.length).toBe(2);
  });
});
