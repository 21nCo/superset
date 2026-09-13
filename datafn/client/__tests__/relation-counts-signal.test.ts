import { describe, expect, it } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "collection",
      version: 1,
      fields: [{ name: "label", type: "string", required: false }],
    },
    {
      name: "node",
      version: 1,
      fields: [
        { name: "label", type: "string", required: false },
        { name: "isArchived", type: "boolean", required: false },
        { name: "trashedAt", type: "number", required: false },
        { name: "trashInformation", type: "object", required: false },
      ],
    },
    {
      name: "objective",
      version: 1,
      fields: [
        { name: "label", type: "string", required: false },
        { name: "isArchived", type: "boolean", required: false },
        { name: "trashedAt", type: "number", required: false },
        { name: "trashInformation", type: "object", required: false },
      ],
    },
  ],
  relations: [
    {
      from: ["node", "objective"],
      to: "collection",
      type: "many-many",
      relation: "collections",
      inverse: "items",
    },
  ],
};

function waitForValue<T>(
  subscribe: (handler: (value: T) => void) => () => void,
) {
  return new Promise<T>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    unsubscribe = subscribe((value) => {
      if (value === undefined) return;
      unsubscribe?.();
      resolve(value);
    });
  });
}

describe("relationCountsSignal", () => {
  it("filters counted target records when targetFilters are provided", async () => {
    const storage = new MemoryStorageAdapter([
      "collection",
      "node",
      "objective",
    ]);
    await storage.upsertRecord("collection", {
      id: "collection:1",
      label: "Collection",
    });
    await storage.upsertRecord("node", { id: "node:active", label: "Active" });
    await storage.upsertRecord("node", {
      id: "node:archived",
      label: "Archived",
      isArchived: true,
    });
    await storage.upsertRecord("objective", {
      id: "objective:trashed",
      label: "Trashed",
      trashedAt: 1,
    });
    await storage.upsertRecord("objective", {
      id: "objective:inactive",
      label: "Inactive",
      isAncestorInactive: true,
    });
    await storage.upsertJoinRow("join_node_collections_collection", {
      from: "node:active",
      to: "collection:1",
    });
    await storage.upsertJoinRow("join_node_collections_collection", {
      from: "node:archived",
      to: "collection:1",
    });
    await storage.upsertJoinRow("join_objective_collections_collection", {
      from: "objective:trashed",
      to: "collection:1",
    });
    await storage.upsertJoinRow("join_objective_collections_collection", {
      from: "objective:inactive",
      to: "collection:1",
    });
    await storage.setHydrationState("collection", "hydrating");
    await storage.setHydrationState("collection", "ready");

    const client = createDatafnClient({
      schema,
      sync: { remote: "http://example.com" },
      clientId: "test-client",
      storage,
    });

    const unfiltered = await waitForValue<Record<string, number>>((handler) =>
      client
        .relationCountsSignal({
          resource: "collection",
          relation: "items",
          ids: ["collection:1"],
        })
        .subscribe(handler),
    );
    const filtered = await waitForValue<Record<string, number>>((handler) =>
      client
        .relationCountsSignal({
          resource: "collection",
          relation: "items",
          ids: ["collection:1"],
          targetFilters: {
            isArchived: { $ne: true },
            trashedAt: { $is_null: true },
            trashInformation: { $is_empty: true },
            isAncestorInactive: { $ne: true },
          },
        })
        .subscribe(handler),
    );

    expect(unfiltered["collection:1"]).toBe(4);
    expect(filtered["collection:1"]).toBe(1);
  });
});
