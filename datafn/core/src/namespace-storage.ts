/**
 * Versioned logical contract for DataFn-owned namespace storage.
 *
 * Consumers use this manifest for tenant copy, verification, cleanup,
 * fencing, outbox drain, and backup. Physical relation names are resolved
 * by the installed server adapter and are not part of this logical contract.
 */

export const DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION = "1" as const;
export const DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION = "1" as const;

export const NAMESPACE_STORAGE_OPERATIONS = [
  "copy",
  "verify",
  "cleanup",
  "fence",
  "drain",
  "backup",
] as const;

export type NamespaceStorageOperation = (typeof NAMESPACE_STORAGE_OPERATIONS)[number];

export const NAMESPACE_STORAGE_LOGICAL_ROLES = [
  "resource",
  "join",
  "permissions_global",
  "permissions_legacy",
  "principal_memberships",
  "principal_hierarchy",
  "sync_meta",
  "sync_changes",
  "idempotency",
  "seed",
  "permission_directory_outbox",
] as const;

export type NamespaceStorageLogicalRole =
  (typeof NAMESPACE_STORAGE_LOGICAL_ROLES)[number];

export const NAMESPACE_SELECTOR_KINDS = [
  "resource_ns",
  "internal_namespace",
] as const;

export type NamespaceSelectorKind = (typeof NAMESPACE_SELECTOR_KINDS)[number];

export const NAMESPACE_STORAGE_PRESENCE = [
  "required",
  "on-demand",
  "schema-derived",
] as const;

export type NamespaceStoragePresence = (typeof NAMESPACE_STORAGE_PRESENCE)[number];

export type NamespaceStorageOwnership = "datafn" | "application";

export interface NamespaceStorageManifestEntry {
  readonly logicalRole: NamespaceStorageLogicalRole;
  readonly selectorKind: NamespaceSelectorKind;
  readonly presence: NamespaceStoragePresence;
  readonly operations: readonly NamespaceStorageOperation[];
  readonly copyOrder: number;
  readonly description: string;
}

const TENANT_ROW_OPERATIONS = [
  "copy",
  "verify",
  "cleanup",
  "fence",
  "backup",
] as const satisfies readonly NamespaceStorageOperation[];

const OUTBOX_OPERATIONS = [
  "copy",
  "verify",
  "cleanup",
  "fence",
  "drain",
  "backup",
] as const satisfies readonly NamespaceStorageOperation[];

/**
 * Canonical logical inventory for the current DataFn storage schema.
 * Physical names are adapter-resolved and must not be hard-coded by consumers.
 */
export const DATAFN_NAMESPACE_STORAGE_MANIFEST = {
  manifestVersion: DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
  schemaVersion: DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
  entries: [
    {
      logicalRole: "resource",
      selectorKind: "resource_ns",
      presence: "schema-derived",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 100,
      description: "Application resource rows isolated by the framework namespace column.",
    },
    {
      logicalRole: "join",
      selectorKind: "resource_ns",
      presence: "schema-derived",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 200,
      description: "Many-to-many join rows for namespaced relations.",
    },
    {
      logicalRole: "permissions_legacy",
      selectorKind: "resource_ns",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 300,
      description: "Legacy per-resource permission rows retained during SPV2 dual-write.",
    },
    {
      logicalRole: "permissions_global",
      selectorKind: "resource_ns",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 310,
      description: "SPV2 global permission grants for a namespace.",
    },
    {
      logicalRole: "principal_memberships",
      selectorKind: "resource_ns",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 320,
      description: "Principal membership edges used by sharing authorization.",
    },
    {
      logicalRole: "principal_hierarchy",
      selectorKind: "resource_ns",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 330,
      description: "Principal hierarchy edges used by sharing authorization.",
    },
    {
      logicalRole: "sync_meta",
      selectorKind: "internal_namespace",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 400,
      description: "Per-namespace sync sequence metadata.",
    },
    {
      logicalRole: "sync_changes",
      selectorKind: "internal_namespace",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 410,
      description: "Per-namespace sync change log.",
    },
    {
      logicalRole: "idempotency",
      selectorKind: "internal_namespace",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 420,
      description: "Per-namespace mutation idempotency records.",
    },
    {
      logicalRole: "seed",
      selectorKind: "internal_namespace",
      presence: "on-demand",
      operations: TENANT_ROW_OPERATIONS,
      copyOrder: 430,
      description: "Per-namespace seed execution records.",
    },
    {
      logicalRole: "permission_directory_outbox",
      selectorKind: "internal_namespace",
      presence: "on-demand",
      operations: OUTBOX_OPERATIONS,
      copyOrder: 500,
      description: "Durable permission-directory reconciliation queue. Drain before cutover; fence ordinary writes.",
    },
  ],
} as const satisfies {
  manifestVersion: typeof DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION;
  schemaVersion: typeof DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION;
  entries: readonly NamespaceStorageManifestEntry[];
};

export type DatafnNamespaceStorageManifest = typeof DATAFN_NAMESPACE_STORAGE_MANIFEST;

export function namespaceStorageManifestEntry(
  logicalRole: NamespaceStorageLogicalRole,
): NamespaceStorageManifestEntry {
  const entry = DATAFN_NAMESPACE_STORAGE_MANIFEST.entries.find(
    (candidate) => candidate.logicalRole === logicalRole,
  );
  if (!entry) {
    throw new Error(`Unknown namespace storage role: ${logicalRole}`);
  }
  return entry;
}

export function namespaceStorageParticipates(
  logicalRole: NamespaceStorageLogicalRole,
  operation: NamespaceStorageOperation,
): boolean {
  return namespaceStorageManifestEntry(logicalRole).operations.includes(operation);
}

export function assertSupportedNamespaceStorageVersions(input: {
  manifestVersion?: string;
  schemaVersion?: string;
}): void {
  const manifestVersion =
    input.manifestVersion ?? DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION;
  const schemaVersion =
    input.schemaVersion ?? DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION;
  if (manifestVersion !== DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION) {
    throw Object.assign(
      new Error(
        `Unsupported namespace storage manifest version "${manifestVersion}". Supported: "${DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION}".`,
      ),
      { code: "DATAFN_NAMESPACE_STORAGE_VERSION_MISMATCH" as const },
    );
  }
  if (schemaVersion !== DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION) {
    throw Object.assign(
      new Error(
        `Unsupported namespace storage schema version "${schemaVersion}". Supported: "${DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION}".`,
      ),
      { code: "DATAFN_NAMESPACE_STORAGE_VERSION_MISMATCH" as const },
    );
  }
}

export function listNamespaceStorageLogicalRoles(): readonly NamespaceStorageLogicalRole[] {
  return NAMESPACE_STORAGE_LOGICAL_ROLES;
}
