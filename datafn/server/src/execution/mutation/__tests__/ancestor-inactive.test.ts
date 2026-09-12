import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../../../server.js";
import type { DatafnSchema } from "../../../core-types.js";

const schema = {
  resources: [
    {
      name: "goals",
      version: 1,
      idPrefix: "goal:",
      capabilities: ["archivable"],
      fields: [
        { name: "label", type: "string" as const, required: false },
        { name: "note", type: "string" as const, required: false },
        { name: "parentId", type: "string" as const, required: false },
        { name: "parentPath", type: "string" as const, required: false },
        { name: "isAncestorInactive", type: "boolean" as const, required: false },
      ],
    },
  ],
  relations: [
    {
      from: "goals",
      to: "goals",
      type: "htree",
      relation: "children",
      inverse: "parent",
      fkField: "parentId",
      pathField: "parentPath",
      inheritsInactive: true,
    },
  ],
} satisfies DatafnSchema;

describe("ancestor inactive propagation", () => {
  let db: any;
  let server: any;

  const mutation = async (payload: Record<string, unknown>) => {
    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await server.router.handle(req, {});
    return { res, body: await res.json() };
  };

  const query = async (payload: Record<string, unknown>) => {
    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await server.router.handle(req, {});
    return { res, body: await res.json() };
  };

  beforeEach(async () => {
    db = memoryAdapter();
    await db.initialize();
    server = await createDatafnServer({
      allowUnknownResources: true,
      schema,
      database: db,
      namespaceProvider: {
        getNamespace: () => "ns:1",
      },
    });

    await mutation({
      resource: "goals",
      version: 1,
      operation: "insert",
      clientId: "c1",
      mutationId: "m1",
      id: "goal:1",
      record: { label: "Root", parentPath: "" },
    });
    await mutation({
      resource: "goals",
      version: 1,
      operation: "insert",
      clientId: "c1",
      mutationId: "m2",
      id: "goal:2",
      record: { label: "Child", parentId: "goal:1", parentPath: "goal:1" },
    });
    await mutation({
      resource: "goals",
      version: 1,
      operation: "insert",
      clientId: "c1",
      mutationId: "m3",
      id: "goal:3",
      record: { label: "Grand", parentId: "goal:2", parentPath: "goal:1-goal:2" },
    });
  });

  afterEach(async () => {
    await server?.close?.();
  });

  it("propagates archive state to descendants and filters them by default", async () => {
    const archive = await mutation({
      resource: "goals",
      version: 1,
      operation: "archive",
      clientId: "c1",
      mutationId: "m4",
      id: "goal:1",
    });
    expect(archive.res.status).toBe(200);
    expect(archive.body.ok).toBe(true);

    const child = await db.findOne({
      model: "goals",
      where: [{ field: "id", operator: "eq", value: "goal:2" }],
      namespace: "ns:1",
    });
    const grand = await db.findOne({
      model: "goals",
      where: [{ field: "id", operator: "eq", value: "goal:3" }],
      namespace: "ns:1",
    });
    expect(child.isAncestorInactive).toBe(true);
    expect(grand.isAncestorInactive).toBe(true);

    const root = await query({
      resource: "goals",
      version: 1,
      filters: { id: "goal:1" },
      select: ["id", "children.**"],
      metadata: { includeArchived: true },
    });
    expect(root.body.result.data[0].children).toEqual([]);

    const rootWithDescendants = await query({
      resource: "goals",
      version: 1,
      filters: { id: "goal:1" },
      select: ["id", "children.**"],
      metadata: { includeArchived: true, includeAncestorInactive: true },
    });
    expect(rootWithDescendants.body.result.data[0].children.map((item: any) => item.id)).toEqual([
      "goal:2",
      "goal:3",
    ]);
  });

  it("htree children.* results expose cleared non-nullable fields as undefined", async () => {
    await mutation({
      resource: "goals",
      version: 1,
      operation: "merge",
      clientId: "c1",
      mutationId: "m-note",
      id: "goal:2",
      record: { note: "remember this" },
    });

    // Replace omits `note`: it is cleared to null in storage.
    const replace = await mutation({
      resource: "goals",
      version: 1,
      operation: "replace",
      clientId: "c1",
      mutationId: "m-replace",
      id: "goal:2",
      record: { label: "Child", parentId: "goal:1", parentPath: "goal:1" },
    });
    expect(replace.res.status).toBe(200);
    const stored = await db.findOne({
      model: "goals",
      where: [{ field: "id", operator: "eq", value: "goal:2" }],
      namespace: "ns:1",
    });
    expect(stored.note).toBeNull();

    const root = await query({
      resource: "goals",
      version: 1,
      filters: { id: "goal:1" },
      select: ["id", "children.*"],
    });
    expect(root.res.status).toBe(200);
    const children = root.body.result.data[0].children;
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("goal:2");
    expect(children[0].note).toBeUndefined();
    expect("note" in children[0]).toBe(false);
  });
});
