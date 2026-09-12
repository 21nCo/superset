import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { createDatafnServer } from "../src/server.js";

const kvTable = sqliteTable("kv", {
  id: text("id").primaryKey(),
  __ns: text("__ns").notNull(),
  value: text("value"),
});

const taskTable = sqliteTable("task", {
  id: text("id").primaryKey(),
  __ns: text("__ns").notNull(),
  title: text("title").notNull(),
  priority: integer("priority"),
});

describe("SQL regression: merge persistence and false-success gating", () => {
  let sqlite: Database.Database;
  let server: Awaited<ReturnType<typeof createDatafnServer>>;
  let adapter: ReturnType<typeof drizzleAdapter>;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE kv (
        id TEXT PRIMARY KEY,
        __ns TEXT NOT NULL,
        value TEXT
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        __ns TEXT NOT NULL,
        title TEXT NOT NULL,
        priority INTEGER
      );
    `);

    const db = drizzle(sqlite, { schema: { kv: kvTable, task: taskTable } });
    adapter = drizzleAdapter({ db, dialect: "sqlite", debug: false });

    server = await createDatafnServer({
      allowUnknownResources: true,
      database: adapter,
      schema: {
        resources: [
          {
            name: "kv",
            version: 1,
            fields: [{ name: "value", type: "string", required: false }],
          },
          {
            name: "task",
            version: 1,
            fields: [
              { name: "title", type: "string", required: true },
              { name: "priority", type: "number", required: false },
            ],
          },
        ],
        relations: [],
      },
    });
  });

  afterEach(() => {
    server?.close();
    sqlite?.close();
  });

  it("KV first-write merge persists and subsequent merge updates value (TV-KV-001/002)", async () => {
    const firstPush = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          mutations: [
            {
              resource: "kv",
              version: 1,
              operation: "merge",
              id: "kv:pref:theme",
              record: { value: "light" },
              clientId: "c1",
              mutationId: "m-kv-create",
            },
          ],
        }),
      }),
    );
    const firstBody = await firstPush.json();
    expect(firstPush.status).toBe(200);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.result.ok).toBe(true);
    expect(firstBody.result.applied).toContain("m-kv-create");
    expect(firstBody.result.errors).toHaveLength(0);

    const queryAfterCreate = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "kv",
          filters: { id: { $eq: "kv:pref:theme" } },
        }),
      }),
    );
    const queryCreateBody = await queryAfterCreate.json();
    expect(queryCreateBody.ok).toBe(true);
    expect(queryCreateBody.result.data).toHaveLength(1);
    expect(queryCreateBody.result.data[0].id).toBe("kv:pref:theme");
    expect(queryCreateBody.result.data[0].value).toBe("light");

    const secondPush = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          mutations: [
            {
              resource: "kv",
              version: 1,
              operation: "merge",
              id: "kv:pref:theme",
              record: { value: "dark" },
              clientId: "c1",
              mutationId: "m-kv-update",
            },
          ],
        }),
      }),
    );
    const secondBody = await secondPush.json();
    expect(secondPush.status).toBe(200);
    expect(secondBody.ok).toBe(true);
    expect(secondBody.result.ok).toBe(true);
    expect(secondBody.result.applied).toContain("m-kv-update");
    expect(secondBody.result.errors).toHaveLength(0);

    const queryAfterUpdate = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "kv",
          filters: { id: { $eq: "kv:pref:theme" } },
        }),
      }),
    );
    const queryUpdateBody = await queryAfterUpdate.json();
    expect(queryUpdateBody.ok).toBe(true);
    expect(queryUpdateBody.result.data).toHaveLength(1);
    expect(queryUpdateBody.result.data[0].value).toBe("dark");
  });

  it("replace clears omitted optional fields as SQL NULL and reads expose them as undefined", async () => {
    const insertRes = await server.router.handle(
      new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: "1",
          clientId: "client-1",
          mutationId: "m-replace-insert",
          operation: "insert",
          id: "task:replace-1",
          record: { title: "Initial", priority: 5 },
        }),
      }),
    );
    expect(insertRes.status).toBe(200);

    const replaceRes = await server.router.handle(
      new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          version: "1",
          clientId: "client-1",
          mutationId: "m-replace-clear",
          operation: "replace",
          id: "task:replace-1",
          // priority omitted: replace must clear it
          record: { title: "Replaced" },
        }),
      }),
    );
    const replaceBody = await replaceRes.json();
    expect(replaceRes.status).toBe(200);
    expect(replaceBody.ok).toBe(true);

    // The relational adapter actually cleared the column (Drizzle ignores
    // undefined update values, so only a persisted null achieves this).
    const row = sqlite
      .prepare("SELECT title, priority FROM task WHERE id = ?")
      .get("task:replace-1") as { title: string; priority: number | null };
    expect(row.title).toBe("Replaced");
    expect(row.priority).toBeNull();

    // Query results normalize the persisted null back to undefined so the
    // non-nullable field type contract holds.
    const queryRes = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          filters: { id: { $eq: "task:replace-1" } },
        }),
      }),
    );
    const queryBody = await queryRes.json();
    expect(queryBody.ok).toBe(true);
    expect(queryBody.result.data).toHaveLength(1);
    expect(queryBody.result.data[0].title).toBe("Replaced");
    expect(queryBody.result.data[0].priority).toBeUndefined();
    expect("priority" in queryBody.result.data[0]).toBe(false);

    // Change tracking carries an explicit, JSON-safe null so synced clients
    // clear the field instead of retaining the old value.
    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "c2", cursor: "0", limit: 100 }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullRes.status).toBe(200);
    const replaceChange = pullBody.result.changes.findLast(
      (change: any) => change.id === "task:replace-1" && change.op === "upsert",
    );
    expect(replaceChange).toBeDefined();
    expect(replaceChange.record.priority).toBeNull();
    expect("priority" in replaceChange.record).toBe(true);
  });

  it("ineligible merge is not applied and does not emit change-tracking records (TV-MRG-002, TV-OBS-002)", async () => {
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          mutations: [
            {
              resource: "task",
              version: 1,
              operation: "merge",
              id: "task:missing",
              record: { priority: 1 },
              clientId: "c1",
              mutationId: "m-merge-missing",
            },
          ],
        }),
      }),
    );
    const pushBody = await pushRes.json();
    expect(pushRes.status).toBe(400);
    expect(pushBody.ok).toBe(false);
    expect(pushBody.result.ok).toBe(false);
    expect(pushBody.result.applied).not.toContain("m-merge-missing");
    expect(pushBody.result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mutationId: "m-merge-missing", code: "NOT_FOUND", path: "id" }),
      ]),
    );
    expect(pushBody.result.cursor).toBe("0");

    const pullRes = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          cursor: "0",
          limit: 100,
        }),
      }),
    );
    const pullBody = await pullRes.json();
    expect(pullRes.status).toBe(200);
    expect(pullBody.ok).toBe(true);
    expect(pullBody.result.ok).toBe(true);
    expect(pullBody.result.changes).toHaveLength(0);

    const task = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "task",
          filters: { id: { $eq: "task:missing" } },
        }),
      }),
    );
    const taskBody = await task.json();
    expect(taskBody.ok).toBe(true);
    expect(taskBody.result.data).toHaveLength(0);
  });
});
