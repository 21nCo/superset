/**
 * Adapter-resolved namespace storage plan.
 *
 * The logical contract lives in `@datafn/core`. This module binds that
 * contract to the installed PostgreSQL schema and fails closed when the
 * catalog contains unknown DataFn-owned namespace storage.
 */

import {
  DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
  DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
  assertSupportedNamespaceStorageVersions,
  getRelationJoinTableName,
  getCapabilityFields,
  isNamespaced,
  namespaceStorageManifestEntry,
  resolveCapabilities,
  type DatafnSchema,
  type NamespaceSelectorKind,
  type NamespaceStorageLogicalRole,
  type NamespaceStorageOperation,
  type NamespaceStorageOwnership,
} from "@datafn/core";
import type { Adapter } from "@superfunctions/db";

import type { DatafnLogger } from "./logger.js";
import type { DatafnMultiRegionRuntimeConfig } from "./plugins/multi-region.js";
import {
  INTERNAL_TABLE_SCHEMAS,
  listNamespacedInternalTables,
} from "./execution/internal-tables.js";
import { getLegacyPermissionsTable } from "./execution/migration/spv2.js";
import { drainNamespacePermissionDirectoryOutbox } from "./execution/mutation/permission-directory-outbox.js";

const POSTGRES_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATAFN_INTERNAL_TABLE_RE = /^__datafn_[a-z0-9_]+$/;
const LEGACY_PERMISSIONS_TABLE_RE = /^__datafn_permissions_(?!global$)[A-Za-z0-9_]+$/;

export const POSTGRES_NAMESPACE_STORAGE_CATALOG_SQL = `
SELECT c.table_name, c.column_name
  FROM information_schema.columns AS c
  JOIN information_schema.tables AS t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
 WHERE c.table_schema = current_schema()
   AND t.table_type = 'BASE TABLE'
 ORDER BY c.table_name, c.ordinal_position
`.trim();

const INTERNAL_ROLE_BY_TABLE = {
  __datafn_meta: "sync_meta",
  __datafn_changes: "sync_changes",
  __datafn_idempotency: "idempotency",
  __datafn_seed: "seed",
  __datafn_permission_directory_outbox: "permission_directory_outbox",
} as const satisfies Record<string, NamespaceStorageLogicalRole>;

const SHARING_RESOURCE_TABLES = [
  {
    logicalRole: "permissions_global",
    relation: "__datafn_permissions_global",
  },
  {
    logicalRole: "principal_memberships",
    relation: "__datafn_principal_memberships",
  },
  {
    logicalRole: "principal_hierarchy",
    relation: "__datafn_principal_hierarchy",
  },
] as const;

const SELECTOR_COLUMN: Record<NamespaceSelectorKind, string> = {
  resource_ns: "__ns",
  internal_namespace: "namespace",
};

export type DatafnNamespaceStorageErrorCode =
  | "DATAFN_NAMESPACE_STORAGE_UNSUPPORTED"
  | "DATAFN_NAMESPACE_STORAGE_VERSION_MISMATCH"
  | "DATAFN_NAMESPACE_STORAGE_INCOMPLETE"
  | "DATAFN_NAMESPACE_STORAGE_UNKNOWN"
  | "DATAFN_NAMESPACE_STORAGE_INVALID";

export class DatafnNamespaceStorageError extends Error {
  readonly code: DatafnNamespaceStorageErrorCode;
  readonly details?: unknown;

  constructor(input: {
    code: DatafnNamespaceStorageErrorCode;
    message: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "DatafnNamespaceStorageError";
    this.code = input.code;
    this.details = input.details;
  }
}

export interface NamespaceStorageCatalogRelation {
  readonly name: string;
  readonly columns: readonly string[];
  /** Valid, non-partial indexes, with expression and INCLUDE columns excluded. */
  readonly indexes?: readonly { columns: readonly string[]; unique: boolean; primary?: boolean }[];
}

export interface NamespaceStorageCatalog {
  readonly dialect: "postgres";
  readonly relations: readonly NamespaceStorageCatalogRelation[];
}

export interface NamespaceStorageEntry {
  readonly logicalRole: NamespaceStorageLogicalRole | "application";
  readonly ownership: NamespaceStorageOwnership;
  readonly relation: string;
  readonly quotedRelation: string;
  readonly namespaceColumn: string;
  readonly quotedNamespaceColumn: string;
  readonly operations: readonly NamespaceStorageOperation[];
  readonly copyOrder: number;
  readonly present: boolean;
}

export interface NamespaceStoragePlan {
  readonly manifestVersion: typeof DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION;
  readonly schemaVersion: typeof DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION;
  readonly dialect: "postgres";
  readonly entries: readonly NamespaceStorageEntry[];
}

export interface ApplicationNamespaceStorageEntry {
  readonly relation: string;
  readonly namespaceColumn: string;
  readonly operations?: readonly NamespaceStorageOperation[];
  readonly copyOrder?: number;
}

type PlannedRelation = {
  logicalRole: NamespaceStorageLogicalRole;
  relation: string;
  copyOrder: number;
  requiredColumns?: readonly string[];
};

function fail(
  code: DatafnNamespaceStorageErrorCode,
  message: string,
  details?: unknown,
): never {
  throw new DatafnNamespaceStorageError({ code, message, details });
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!POSTGRES_IDENTIFIER_RE.test(identifier)) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_INVALID",
      `Invalid PostgreSQL identifier "${identifier}"`,
      { identifier },
    );
  }
  return `"${identifier}"`;
}

export function namespacedInternalTableRoles(): Readonly<
  Record<string, NamespaceStorageLogicalRole>
> {
  return INTERNAL_ROLE_BY_TABLE;
}

function catalogByName(
  catalog: NamespaceStorageCatalog,
): Map<string, NamespaceStorageCatalogRelation> {
  const map = new Map<string, NamespaceStorageCatalogRelation>();
  for (const relation of catalog.relations) {
    if (map.has(relation.name)) fail("DATAFN_NAMESPACE_STORAGE_INVALID", "Duplicate catalog relation.");
    map.set(relation.name, relation);
  }
  return map;
}

function hasColumn(
  relation: NamespaceStorageCatalogRelation | undefined,
  column: string,
): boolean {
  return Boolean(relation?.columns.includes(column));
}

function isShareableResource(
  schema: DatafnSchema,
  resourceName: string,
): boolean {
  const resource = schema.resources.find((entry) => entry.name === resourceName);
  if (!resource) return false;
  const resolved = resolveCapabilities(schema.capabilities, resource.capabilities);
  return resolved.some(
    (entry) => typeof entry === "object" && entry !== null && "shareable" in entry,
  );
}

function schemaDerivedRelations(schema: DatafnSchema): PlannedRelation[] {
  const planned: PlannedRelation[] = [];
  const resourceRole = namespaceStorageManifestEntry("resource");
  schema.resources.forEach((resource, index) => {
    planned.push({
      logicalRole: "resource",
      relation: resource.name,
      requiredColumns: ["id", ...resource.fields.map((field) => field.name),
        ...getCapabilityFields(resolveCapabilities(schema.capabilities, resource.capabilities)).map((field) => field.name)
      ].map(physicalColumn),
      copyOrder: resourceRole.copyOrder + index,
    });
  });

  const joinRole = namespaceStorageManifestEntry("join");
  const joinTables = new Set<string>();
  for (const relation of schema.relations ?? []) {
    if (relation.type !== "many-many") continue;
    const table = getRelationJoinTableName(relation);
    if (joinTables.has(table)) continue;
    joinTables.add(table);
    planned.push({
      logicalRole: "join",
      relation: table,
      requiredColumns: ["id", relation.joinColumns?.from ?? "from", relation.joinColumns?.to ?? "to",
        ...(relation.metadata ?? []).map((field) => field.name)].map(physicalColumn),
      copyOrder: joinRole.copyOrder + joinTables.size,
    });
  }

  const legacyRole = namespaceStorageManifestEntry("permissions_legacy");
  schema.resources.forEach((resource, index) => {
    if (!isShareableResource(schema, resource.name)) return;
    planned.push({
      logicalRole: "permissions_legacy",
      relation: getLegacyPermissionsTable(resource.name),
      copyOrder: legacyRole.copyOrder + index,
    });
  });

  return planned;
}

function internalPlannedRelations(): PlannedRelation[] {
  return Object.entries(INTERNAL_ROLE_BY_TABLE).map(([relation, logicalRole]) => ({
    logicalRole,
    relation,
    copyOrder: namespaceStorageManifestEntry(logicalRole).copyOrder,
  }));
}

function sharingPlannedRelations(): PlannedRelation[] {
  return SHARING_RESOURCE_TABLES.map((entry) => ({
    logicalRole: entry.logicalRole,
    relation: entry.relation,
    copyOrder: namespaceStorageManifestEntry(entry.logicalRole).copyOrder,
  }));
}

function physicalColumn(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const SHARING_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  permissions_global: ["id", "resource_type", "resource_ns", "resource_id", "principal_id", "level", "grant_kind", "source_ref", "granted_by", "granted_at", "revoked_at"],
  permissions_legacy: ["id", "resource_id", "user_id", "level", "granted_by", "granted_at", "revoked_at"],
  principal_memberships: ["id", "namespace", "actor_id", "principal_id", "granted_at", "revoked_at"],
  principal_hierarchy: ["id", "namespace", "principal_id", "parent_principal_id", "created_at", "revoked_at"],
};

function toEntry(
  planned: PlannedRelation,
  catalog: Map<string, NamespaceStorageCatalogRelation>,
): NamespaceStorageEntry | null {
  const manifest = namespaceStorageManifestEntry(planned.logicalRole);
  const namespaceColumn = SELECTOR_COLUMN[manifest.selectorKind];
  const relation = catalog.get(planned.relation);
  if (!relation) {
    if (manifest.presence === "schema-derived") {
      fail(
        "DATAFN_NAMESPACE_STORAGE_INCOMPLETE",
        `Required namespace storage relation "${planned.relation}" is missing from the installed schema.`,
        { logicalRole: planned.logicalRole, relation: planned.relation },
      );
    }
    return null;
  }
  if (!hasColumn(relation, namespaceColumn)) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_INCOMPLETE",
      `Namespace storage relation "${planned.relation}" is missing selector column "${namespaceColumn}".`,
      {
        logicalRole: planned.logicalRole,
        relation: planned.relation,
        expectedColumn: namespaceColumn,
        columns: relation.columns,
      },
    );
  }
  const required = planned.requiredColumns
    ?? INTERNAL_TABLE_SCHEMAS[planned.relation]?.map((column) => column.name)
    ?? SHARING_REQUIRED_COLUMNS[planned.logicalRole] ?? ["id"];
  const missing = required.filter((column) => !hasColumn(relation, column));
  if (missing.length > 0) {
    fail("DATAFN_NAMESPACE_STORAGE_INCOMPLETE", `Relation "${planned.relation}" is missing required columns: ${missing.join(", ")}.`);
  }
  // Tenant operations require a stable unique row identity. An arbitrary index,
  // partial index or unique key with additional columns does not establish it.
  const hasIdentity = relation.indexes?.some((index) => index.unique && index.primary === true &&
    index.columns.includes("id") && index.columns.every((column) => column === "id" || column === namespaceColumn));
  if (!hasIdentity) {
    fail("DATAFN_NAMESPACE_STORAGE_INCOMPLETE", `Relation "${planned.relation}" is missing a validated unique identity index.`);
  }
  return {
    logicalRole: planned.logicalRole,
    ownership: "datafn",
    relation: planned.relation,
    quotedRelation: quotePostgresIdentifier(planned.relation),
    namespaceColumn,
    quotedNamespaceColumn: quotePostgresIdentifier(namespaceColumn),
    operations: manifest.operations,
    copyOrder: planned.copyOrder,
    present: true,
  };
}

function isDatafnOwnedCatalogRelation(name: string, columns: readonly string[]): boolean {
  if (columns.includes("__ns")) return true;
  return DATAFN_INTERNAL_TABLE_RE.test(name) && columns.includes("namespace");
}

function unexpectedCatalogRelations(
  catalog: NamespaceStorageCatalog,
  plannedNames: Set<string>,
): string[] {
  const unexpected: string[] = [];
  for (const relation of catalog.relations) {
    if (plannedNames.has(relation.name)) continue;
    if (!isDatafnOwnedCatalogRelation(relation.name, relation.columns)) continue;
    unexpected.push(relation.name);
  }
  return unexpected.sort();
}

export function resolveNamespaceStoragePlan(input: {
  schema: DatafnSchema;
  catalog: NamespaceStorageCatalog;
  manifestVersion?: string;
  schemaVersion?: string;
}): NamespaceStoragePlan {
  try {
    assertSupportedNamespaceStorageVersions({
      manifestVersion: input.manifestVersion,
      schemaVersion: input.schemaVersion,
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "DATAFN_NAMESPACE_STORAGE_VERSION_MISMATCH";
    fail(
      code as DatafnNamespaceStorageErrorCode,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (input.catalog.dialect !== "postgres") {
    fail(
      "DATAFN_NAMESPACE_STORAGE_UNSUPPORTED",
      `Namespace storage plans are supported for PostgreSQL only. Received dialect "${String((input.catalog as { dialect?: string }).dialect)}".`,
    );
  }

  if (!isNamespaced(input.schema)) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_UNSUPPORTED",
      "Namespace storage plans require a namespaced DataFn schema.",
    );
  }

  const catalog = catalogByName(input.catalog);
  const planned = [
    ...schemaDerivedRelations(input.schema),
    ...sharingPlannedRelations(),
    ...internalPlannedRelations(),
  ];

  for (const relation of input.catalog.relations) {
    if (
      LEGACY_PERMISSIONS_TABLE_RE.test(relation.name) &&
      !planned.some((entry) => entry.relation === relation.name)
    ) {
      planned.push({
        logicalRole: "permissions_legacy",
        relation: relation.name,
        copyOrder: namespaceStorageManifestEntry("permissions_legacy").copyOrder + 50,
      });
    }
  }

  const plannedNames = new Set(planned.map((entry) => entry.relation));
  const unexpected = unexpectedCatalogRelations(input.catalog, plannedNames);
  if (unexpected.length > 0) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_UNKNOWN",
      `Installed schema contains DataFn namespace storage that is not in the supported contract: ${unexpected.join(", ")}.`,
      { relations: unexpected },
    );
  }

  const entries = planned
    .map((entry) => toEntry(entry, catalog))
    .filter((entry): entry is NamespaceStorageEntry => entry !== null)
    .sort((left, right) => {
      if (left.copyOrder !== right.copyOrder) return left.copyOrder - right.copyOrder;
      return left.relation.localeCompare(right.relation);
    });

  return {
    manifestVersion: DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
    schemaVersion: DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
    dialect: "postgres",
    entries,
  };
}

export function selectNamespaceStorageEntries(
  plan: NamespaceStoragePlan,
  operation: NamespaceStorageOperation,
): readonly NamespaceStorageEntry[] {
  const selected = plan.entries.filter((entry) => entry.operations.includes(operation));
  if (operation === "cleanup") {
    return [...selected].sort((left, right) => {
      if (left.copyOrder !== right.copyOrder) return right.copyOrder - left.copyOrder;
      return right.relation.localeCompare(left.relation);
    });
  }
  return selected;
}

export function composeNamespaceStoragePlan(
  plan: NamespaceStoragePlan,
  applicationEntries: readonly ApplicationNamespaceStorageEntry[],
): NamespaceStoragePlan {
  const existing = new Set(plan.entries.map((entry) => entry.relation));
  const composed: NamespaceStorageEntry[] = [...plan.entries];
  for (const entry of applicationEntries) {
    if (existing.has(entry.relation)) {
      fail(
        "DATAFN_NAMESPACE_STORAGE_INVALID",
        `Application storage relation "${entry.relation}" collides with DataFn-owned storage.`,
        { relation: entry.relation },
      );
    }
    existing.add(entry.relation);
    composed.push({
      logicalRole: "application",
      ownership: "application",
      relation: entry.relation,
      quotedRelation: quotePostgresIdentifier(entry.relation),
      namespaceColumn: entry.namespaceColumn,
      quotedNamespaceColumn: quotePostgresIdentifier(entry.namespaceColumn),
      operations: entry.operations ?? ["copy", "verify", "cleanup", "fence", "backup"],
      copyOrder: entry.copyOrder ?? 10,
      present: true,
    });
  }
  composed.sort((left, right) => {
    if (left.copyOrder !== right.copyOrder) return left.copyOrder - right.copyOrder;
    return left.relation.localeCompare(right.relation);
  });
  return { ...plan, entries: composed };
}

export const POSTGRES_NAMESPACE_STORAGE_INDEX_SQL = `
SELECT t.relname AS table_name,
       array_agg(a.attname ORDER BY k.ordinality) AS index_columns,
       i.indisunique AS index_unique, i.indisprimary AS index_primary
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
 WHERE n.nspname = current_schema() AND i.indisvalid AND i.indisready
   AND i.indpred IS NULL AND i.indexprs IS NULL
   AND k.ordinality <= i.indnkeyatts
 GROUP BY t.relname, i.indexrelid, i.indisunique, i.indisprimary
 ORDER BY t.relname, i.indexrelid
`.trim();

export type PostgresNamespaceStorageQuery = (
  sql: string,
) => Promise<readonly {
  table_name: string;
  column_name?: string;
  index_columns?: readonly string[];
  index_unique?: boolean;
  index_primary?: boolean;
}[]>;

export async function inspectPostgresNamespaceStorage(
  query: PostgresNamespaceStorageQuery,
): Promise<NamespaceStorageCatalog> {
  const rows = await query(POSTGRES_NAMESPACE_STORAGE_CATALOG_SQL);
  const indexRows = await query(POSTGRES_NAMESPACE_STORAGE_INDEX_SQL);
  const relations = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row.column_name !== "string") fail("DATAFN_NAMESPACE_STORAGE_INCOMPLETE", "Catalog column metadata is missing.");
    const columns = relations.get(row.table_name) ?? [];
    columns.push(row.column_name);
    relations.set(row.table_name, columns);
  }
  return {
    dialect: "postgres",
    relations: [...relations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, columns]) => ({ name, columns, indexes: indexRows
        .filter((row) => row.table_name === name && Array.isArray(row.index_columns) && typeof row.index_unique === "boolean")
        .map((row) => ({ columns: row.index_columns!, unique: row.index_unique!, primary: row.index_primary === true })) })),
  };
}

export function assertInternalNamespaceStorageMetadataComplete(): void {
  const namespaced = listNamespacedInternalTables();
  const mapped = Object.keys(INTERNAL_ROLE_BY_TABLE).sort();
  if (namespaced.join("\0") !== mapped.join("\0")) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_INCOMPLETE",
      "Internal namespace tables are missing from the storage contract.",
      {
        namespacedInternalTables: namespaced,
        mappedInternalTables: mapped,
        schemas: Object.keys(INTERNAL_TABLE_SCHEMAS).sort(),
      },
    );
  }
}

export async function drainNamespaceStorage(input: {
  adapter: Adapter;
  plan: NamespaceStoragePlan;
  namespace: string;
  runtime: DatafnMultiRegionRuntimeConfig;
  logger?: DatafnLogger;
}): Promise<{ processed: number; pending: number }> {
  const drainEntries = selectNamespaceStorageEntries(input.plan, "drain");
  if (drainEntries.length === 0) {
    return { processed: 0, pending: 0 };
  }
  const unsupported = drainEntries.filter(
    (entry) => entry.logicalRole !== "permission_directory_outbox",
  );
  if (unsupported.length > 0) {
    fail(
      "DATAFN_NAMESPACE_STORAGE_UNSUPPORTED",
      `No drain implementation for logical roles: ${unsupported.map((entry) => entry.logicalRole).join(", ")}.`,
      { roles: unsupported.map((entry) => entry.logicalRole) },
    );
  }
  return drainNamespacePermissionDirectoryOutbox(
    input.adapter,
    input.namespace,
    input.runtime,
    input.logger,
  );
}
