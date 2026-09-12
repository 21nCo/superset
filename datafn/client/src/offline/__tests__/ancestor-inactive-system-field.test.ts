import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../adapters/memoryStorage.js";
import { executeLocalQuery } from "../query.js";
import { handleOfflineMutation } from "../mutate.js";
import { assertNoSystemFieldWrite } from "../../capability-fields.js";
import type { DatafnSchema } from "@datafn/core";

const field = (name: string, type: "string" | "boolean" = "string") => ({ name, type, required: false });

const schema: DatafnSchema = {
  resources: [
    {
      name: "goals",
      version: 1,
      fields: [field("label"), field("parentId"), field("parentPath"), field("isArchived", "boolean")],
    },
    { name: "notes", version: 1, fields: [field("body")] },
  ],
  relations: [
    {
      from: "goals",
      relation: "children",
      inverse: "parent",
      to: "goals",
      type: "htree",
      fkField: "parentId",
      pathField: "parentPath",
      inheritsInactive: true,
    },
  ],
};

const base = { clientId: "client-1", resource: "goals", version: 1 };

describe("isAncestorInactive as a system field (offline)", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    await storage.upsertRecord("goals", { id: "g1", label: "Root", parentPath: "" });
    await storage.upsertRecord("goals", { id: "g2", label: "Child", parentId: "g1", parentPath: "g1" });
  });

  it("rejects public writes to isAncestorInactive before recording the mutation", async () => {
    for (const operation of ["insert", "merge", "replace"] as const) {
      await expect(
        handleOfflineMutation(
          storage,
          schema,
          {
            ...base,
            mutationId: `bad-${operation}`,
            operation,
            id: operation === "insert" ? "g-new" : "g2",
            record: { label: "x", isAncestorInactive: true },
          },
          Date.now(),
        ),
      ).rejects.toMatchObject({ code: "DFQL_INVALID" });
    }
    expect(await storage.getRecord("goals", "g-new")).toBeNull();
    expect((await storage.getRecord("goals", "g2"))?.isAncestorInactive).not.toBe(true);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("allows the same field name on resources that do not own it", () => {
    expect(() =>
      assertNoSystemFieldWrite(schema, {
        operation: "insert",
        resource: "notes",
        id: "n1",
        record: { body: "hi", isAncestorInactive: true },
      }),
    ).not.toThrow();
  });

  it("does not touch a consumer-owned isAncestorInactive on resources without inheritsInactive", async () => {
    await handleOfflineMutation(
      storage,
      schema,
      {
        ...base,
        resource: "notes",
        mutationId: "note-insert",
        operation: "insert",
        id: "n1",
        record: { body: "hi", isAncestorInactive: true },
      },
      Date.now(),
    );
    expect((await storage.getRecord("notes", "n1"))?.isAncestorInactive).toBe(true);
  });

  it("engine propagation still writes the field and default queries filter it", async () => {
    await handleOfflineMutation(
      storage,
      schema,
      { ...base, mutationId: "arch", operation: "archive", id: "g1" },
      Date.now(),
    );
    expect(await storage.getRecord("goals", "g2")).toMatchObject({ isAncestorInactive: true });

    const hidden = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
      metadata: { includeArchived: true },
    });
    expect(hidden.data![0].children).toEqual([]);

    const shown = await executeLocalQuery(storage, schema, {
      resource: "goals",
      filters: { id: "g1" },
      select: ["id", "children.**"],
      metadata: { includeArchived: true, includeAncestorInactive: true },
    });
    expect(shown.data![0].children.map((item: any) => item.id)).toEqual(["g2"]);
  });
});
