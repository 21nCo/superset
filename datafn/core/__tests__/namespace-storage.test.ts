import { describe, expect, it } from "vitest";
import {
  DATAFN_NAMESPACE_STORAGE_MANIFEST,
  DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
  DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
  NAMESPACE_STORAGE_LOGICAL_ROLES,
  assertSupportedNamespaceStorageVersions,
  listNamespaceStorageLogicalRoles,
  namespaceStorageManifestEntry,
  namespaceStorageParticipates,
} from "../src/namespace-storage.js";

describe("namespace storage manifest", () => {
  it("covers every logical role exactly once", () => {
    const roles = DATAFN_NAMESPACE_STORAGE_MANIFEST.entries.map(
      (entry) => entry.logicalRole,
    );
    expect([...roles].sort()).toEqual([...NAMESPACE_STORAGE_LOGICAL_ROLES].sort());
    expect(new Set(roles).size).toBe(NAMESPACE_STORAGE_LOGICAL_ROLES.length);
    expect(listNamespaceStorageLogicalRoles()).toEqual(NAMESPACE_STORAGE_LOGICAL_ROLES);
  });

  it("keeps copy order deterministic and unique", () => {
    const orders = DATAFN_NAMESPACE_STORAGE_MANIFEST.entries.map(
      (entry) => entry.copyOrder,
    );
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("assigns resource_ns to resources, joins, and sharing tables", () => {
    expect(namespaceStorageManifestEntry("resource").selectorKind).toBe("resource_ns");
    expect(namespaceStorageManifestEntry("join").selectorKind).toBe("resource_ns");
    expect(namespaceStorageManifestEntry("permissions_global").selectorKind).toBe(
      "resource_ns",
    );
    expect(namespaceStorageManifestEntry("principal_memberships").selectorKind).toBe(
      "resource_ns",
    );
    expect(namespaceStorageManifestEntry("principal_hierarchy").selectorKind).toBe(
      "resource_ns",
    );
    expect(namespaceStorageManifestEntry("permissions_legacy").selectorKind).toBe(
      "resource_ns",
    );
  });

  it("assigns internal_namespace to DataFn-owned ledgers and the outbox", () => {
    expect(namespaceStorageManifestEntry("sync_meta").selectorKind).toBe(
      "internal_namespace",
    );
    expect(namespaceStorageManifestEntry("sync_changes").selectorKind).toBe(
      "internal_namespace",
    );
    expect(namespaceStorageManifestEntry("idempotency").selectorKind).toBe(
      "internal_namespace",
    );
    expect(namespaceStorageManifestEntry("seed").selectorKind).toBe("internal_namespace");
    expect(namespaceStorageManifestEntry("permission_directory_outbox").selectorKind).toBe(
      "internal_namespace",
    );
  });

  it("distinguishes drain from copy/fence responsibilities", () => {
    expect(namespaceStorageParticipates("permission_directory_outbox", "drain")).toBe(
      true,
    );
    expect(namespaceStorageParticipates("permission_directory_outbox", "fence")).toBe(
      true,
    );
    expect(namespaceStorageParticipates("resource", "drain")).toBe(false);
    expect(namespaceStorageParticipates("sync_changes", "copy")).toBe(true);
    expect(namespaceStorageParticipates("sync_changes", "drain")).toBe(false);
  });

  it("rejects mixed or unknown manifest/schema versions", () => {
    expect(() =>
      assertSupportedNamespaceStorageVersions({
        manifestVersion: DATAFN_NAMESPACE_STORAGE_MANIFEST_VERSION,
        schemaVersion: DATAFN_NAMESPACE_STORAGE_SCHEMA_VERSION,
      }),
    ).not.toThrow();
    expect(() =>
      assertSupportedNamespaceStorageVersions({ manifestVersion: "2" }),
    ).toThrow(/Unsupported namespace storage manifest version/);
    expect(() =>
      assertSupportedNamespaceStorageVersions({ schemaVersion: "9" }),
    ).toThrow(/Unsupported namespace storage schema version/);
  });
});
