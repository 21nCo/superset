import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../../../server.js";
import type { DatafnSchema } from "../../../core-types.js";
import {
  recomputeAncestorInactive,
  recomputeAncestorInactiveAll,
} from "../../migration/ancestor-inactive.js";

const schema = {
  resources: [
    {
      name: "goals",
      version: 1,
      idPrefix: "goal:",
      capabilities: ["archivable"],
      fields: [
        { name: "label", type: "string" as const, required: false },
        { name: "parentId", type: "string" as const, required: false },
        { name: "parentPath", type: "string" as const, required: false },
      ],
    },
    {
      name: "tasks",
      version: 1,
      idPrefix: "task:",
      fields: [
        { name: "title", type: "string" as const, required: false },
        { name: "goalId", type: "string" as const, required: false },
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
    {
      from: "tasks",
      to: "goals",
      type: "many-one",
      relation: "goal",
      inverse: "tasks",
      fkField: "goalId",
      inheritsInactive: true,
    },
  ],
} satisfies DatafnSchema;

const NS = "ns:1";

describe("isAncestorInactive as a system field (server)", () => {
  let db: any;
  let server: any;

  const post = async (path: string, payload: Record<string, unknown>) => {
    const req = new Request(`http://localhost/datafn/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await server.router.handle(req, {});
    return { res, body: await res.json() };
  };

  const insert = (resource: string, id: string, record: Record<string, unknown>, mutationId = id) =>
    post("mutation", { resource, version: 1, operation: "insert", clientId: "c1", mutationId, id, record });

  const get = (model: string, id: string) =>
    db.findOne({ model, where: [{ field: "id", operator: "eq", value: id }], namespace: NS });

  beforeEach(async () => {
    db = memoryAdapter();
    await db.initialize();
    server = await createDatafnServer({
      allowUnknownResources: true,
      schema,
      database: db,
      namespaceProvider: { getNamespace: () => NS },
    });
  });

  afterEach(async () => {
    await server?.close?.();
  });

  it("persists the injected field with default false without a consumer declaration", async () => {
    const res = await insert("goals", "goal:1", { label: "Root", parentPath: "" });
    expect(res.body.ok).toBe(true);
    expect((await get("goals", "goal:1")).isAncestorInactive).toBe(false);

    const task = await insert("tasks", "task:1", { title: "t", goalId: "goal:1" });
    expect(task.body.ok).toBe(true);
    expect((await get("tasks", "task:1")).isAncestorInactive).toBe(false);
  });

  it("rejects public writes to isAncestorInactive on the mutation endpoint", async () => {
    await insert("goals", "goal:1", { label: "Root", parentPath: "" });

    for (const operation of ["insert", "merge", "replace"]) {
      const { res, body } = await post("mutation", {
        resource: "goals",
        version: 1,
        operation,
        clientId: "c1",
        mutationId: `bad-${operation}`,
        id: operation === "insert" ? `goal:new-${operation}` : "goal:1",
        record: { label: "x", isAncestorInactive: true },
      });
      expect(res.status, operation).not.toBe(200);
      expect(body.ok, operation).toBe(false);
      expect(JSON.stringify(body)).toContain("read-only");
    }
    expect((await get("goals", "goal:1")).isAncestorInactive).toBe(false);
    expect(await get("goals", "goal:new-insert")).toBeNull();
  });

  it("does not affect resources that do not own the field", async () => {
    const { body } = await post("mutation", {
      resource: "goals",
      version: 1,
      operation: "insert",
      clientId: "c1",
      mutationId: "ok",
      id: "goal:ok",
      record: { label: "fine", parentPath: "" },
    });
    expect(body.ok).toBe(true);
  });

  it("rejects public writes to isAncestorInactive on the push endpoint", async () => {
    const { body } = await post("push", {
      clientId: "c1",
      mutations: [
        {
          resource: "goals",
          version: 1,
          operation: "insert",
          clientId: "c1",
          mutationId: "p1",
          id: "goal:p1",
          record: { label: "pushed", parentPath: "", isAncestorInactive: true },
        },
      ],
    });
    expect(JSON.stringify(body)).toContain("read-only");
    expect(await get("goals", "goal:p1")).toBeNull();
  });

  it("propagates across many-one relations and filters dependents by default", async () => {
    await insert("goals", "goal:1", { label: "Root", parentPath: "" });
    await insert("tasks", "task:1", { title: "t", goalId: "goal:1" });

    const archive = await post("mutation", {
      resource: "goals",
      version: 1,
      operation: "archive",
      clientId: "c1",
      mutationId: "arch",
      id: "goal:1",
    });
    expect(archive.body.ok).toBe(true);
    expect((await get("tasks", "task:1")).isAncestorInactive).toBe(true);

    const hidden = await post("query", { resource: "tasks", version: 1 });
    expect(hidden.body.result.data).toEqual([]);
    const shown = await post("query", {
      resource: "tasks",
      version: 1,
      metadata: { includeAncestorInactive: true },
    });
    expect(shown.body.result.data.map((t: any) => t.id)).toEqual(["task:1"]);
  });

  describe("recomputeAncestorInactive", () => {
    beforeEach(async () => {
      await insert("goals", "goal:1", { label: "Root", parentPath: "" });
      await insert("goals", "goal:2", { label: "Child", parentId: "goal:1", parentPath: "goal:1" });
      await insert("goals", "goal:3", { label: "Grand", parentId: "goal:2", parentPath: "goal:1-goal:2" });
      await insert("tasks", "task:1", { title: "t", goalId: "goal:3" });
      await insert("tasks", "task:2", { title: "u", goalId: "goal:1" });
    });

    const corrupt = async () => {
      await db.update({
        model: "goals",
        where: [{ field: "id", operator: "eq", value: "goal:1" }],
        data: { isArchived: true },
        namespace: NS,
      });
      await db.update({
        model: "tasks",
        where: [{ field: "id", operator: "eq", value: "task:2" }],
        data: { isAncestorInactive: true },
        namespace: NS,
      });
      await db.update({
        model: "goals",
        where: [{ field: "id", operator: "eq", value: "goal:1" }],
        data: { isArchived: false },
        namespace: NS,
      });
      await db.update({
        model: "goals",
        where: [{ field: "id", operator: "eq", value: "goal:2" }],
        data: { isArchived: true },
        namespace: NS,
      });
    };

    it("converges stale values across the hierarchy and is idempotent", async () => {
      await corrupt();
      expect((await get("goals", "goal:3")).isAncestorInactive).toBe(false);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(true);

      const first = await recomputeAncestorInactiveAll(db, schema, { namespace: NS, batchSize: 2 });
      expect(first.updated).toBeGreaterThan(0);

      expect((await get("goals", "goal:1")).isAncestorInactive).toBe(false);
      expect((await get("goals", "goal:2")).isAncestorInactive).toBe(false);
      expect((await get("goals", "goal:3")).isAncestorInactive).toBe(true);
      expect((await get("tasks", "task:1")).isAncestorInactive).toBe(true);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(false);

      const second = await recomputeAncestorInactiveAll(db, schema, { namespace: NS });
      expect(second.updated).toBe(0);
      expect(second.sweeps).toBe(1);
      expect(second.converged).toBe(true);
    });

    it("reports converged=false when maxSweeps stops a reverse-id hierarchy early", async () => {
      await insert("goals", "goal:z", { label: "Root", parentPath: "" });
      await insert("goals", "goal:y", { label: "L1", parentId: "goal:z", parentPath: "goal:z" });
      await insert("goals", "goal:x", { label: "L2", parentId: "goal:y", parentPath: "goal:z-goal:y" });
      await insert("goals", "goal:w", { label: "L3", parentId: "goal:x", parentPath: "goal:z-goal:y-goal:x" });
      await db.update({
        model: "goals",
        where: [{ field: "id", operator: "eq", value: "goal:z" }],
        data: { isArchived: true },
        namespace: NS,
      });

      const capped = await recomputeAncestorInactiveAll(db, schema, { namespace: NS, maxSweeps: 1 });
      expect(capped.converged).toBe(false);
      expect(capped.sweeps).toBe(1);
      expect((await get("goals", "goal:y")).isAncestorInactive).toBe(true);
      expect((await get("goals", "goal:w")).isAncestorInactive).toBe(false);

      const full = await recomputeAncestorInactiveAll(db, schema, { namespace: NS });
      expect(full.converged).toBe(true);
      expect(full.sweeps).toBeGreaterThan(1);
      expect((await get("goals", "goal:x")).isAncestorInactive).toBe(true);
      expect((await get("goals", "goal:w")).isAncestorInactive).toBe(true);
    });

    it("skips rows changed by a concurrent propagation instead of overwriting or aborting", async () => {
      await corrupt();
      let raced = false;
      const racing = {
        ...db,
        findMany: async (params: Record<string, unknown>) => {
          const rows = await db.findMany(params);
          if (!raced && params.model === "tasks") {
            raced = true;
            await db.update({
              model: "tasks",
              where: [{ field: "id", operator: "eq", value: "task:2" }],
              data: { isAncestorInactive: false },
              namespace: NS,
            });
          }
          return rows;
        },
      };

      const result = await recomputeAncestorInactive(racing, schema, { namespace: NS });
      expect(raced).toBe(true);
      expect(result.nextCursor).toBeNull();
      expect(result.updated).toBe(2);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(false);
      expect((await get("tasks", "task:1")).isAncestorInactive).toBe(true);
      expect((await get("goals", "goal:3")).isAncestorInactive).toBe(true);
    });

    it("guards legacy null rows against concurrent propagation too", async () => {
      await db.update({
        model: "tasks",
        where: [{ field: "id", operator: "eq", value: "task:2" }],
        data: { isAncestorInactive: null },
        namespace: NS,
      });
      let raced = false;
      const racing = {
        ...db,
        findMany: async (params: Record<string, unknown>) => {
          const rows = await db.findMany(params);
          if (!raced && params.model === "tasks") {
            raced = true;
            await db.update({
              model: "tasks",
              where: [{ field: "id", operator: "eq", value: "task:2" }],
              data: { isAncestorInactive: true },
              namespace: NS,
            });
          }
          return rows;
        },
      };

      await recomputeAncestorInactive(racing, schema, { namespace: NS });
      expect(raced).toBe(true);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(true);

      const settled = await recomputeAncestorInactive(db, schema, { namespace: NS });
      expect(settled.updated).toBe(1);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(false);
    });

    it("normalizes legacy non-boolean stored values", async () => {
      for (const [id, value] of [["task:1", 0], ["task:2", "false"]] as const) {
        await db.update({
          model: "tasks",
          where: [{ field: "id", operator: "eq", value: id }],
          data: { isAncestorInactive: value },
          namespace: NS,
        });
      }
      const result = await recomputeAncestorInactiveAll(db, schema, { namespace: NS });
      expect(result.converged).toBe(true);
      expect(result.updated).toBe(2);
      expect((await get("tasks", "task:1")).isAncestorInactive).toBe(false);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(false);
    });

    it("is resumable through cursors and bounded by batchSize", async () => {
      await corrupt();
      const visited: string[] = [];
      let cursor = null;
      let calls = 0;
      do {
        const result = await recomputeAncestorInactive(db, schema, { namespace: NS, batchSize: 2, cursor });
        expect(result.scanned).toBeLessThanOrEqual(2);
        if (result.nextCursor) visited.push(`${result.nextCursor.resource}:${result.nextCursor.afterId}`);
        cursor = result.nextCursor;
        calls += 1;
      } while (cursor !== null);
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(visited[0]).toBe("goals:goal:2");
    });

    it("dryRun reports but does not write", async () => {
      await corrupt();
      const result = await recomputeAncestorInactive(db, schema, { namespace: NS, dryRun: true });
      expect(result.updated).toBeGreaterThan(0);
      expect((await get("tasks", "task:2")).isAncestorInactive).toBe(true);
    });

    it("scans every owning resource exactly once per sweep", async () => {
      const result = await recomputeAncestorInactive(db, schema, { namespace: NS });
      expect(result.scanned).toBe(5);
      expect(result.nextCursor).toBeNull();
    });
  });
});
