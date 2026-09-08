import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { createMdfnRouter, createMdfnService } from "./index";

/** Vitest default is 10s; large-payload fixtures exceed that on loaded GHA runners. */
const HEAVY_FIXTURE_TEST_TIMEOUT_MS = 30_000;

function reorderObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderObjectKeys) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).reverse()
      .map(([key, entry]) => [key, reorderObjectKeys(entry)]),
  ) as T;
}

describe("mdfn server", () => {
  it("rejects oversized JSON bodies before document parsing", async () => {
    const router = createMdfnRouter({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      resolvePrincipal: () => ({ id: "author" }),
      maxRequestBodyBytes: 32,
    });
    const result = await router.handle(new Request("https://example.test/api/mdfn/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "x".repeat(64) }),
    }));

    expect(result.status).toBe(413);
  });

  it("bounds UTF-8 document titles on creation and update", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      maxTitleBytes: 4,
    });
    const principal = { id: "author" };

    await expect(service.create(principal, { title: "🌍🌍", markdown: "body" }))
      .rejects.toMatchObject({ code: "MDFN_TITLE_TOO_LARGE", status: 413 });
    const created = await service.create(principal, { title: "🌍", markdown: "body" });
    await expect(service.update(principal, created.id, { expectedVersion: 1, title: "abcde" }))
      .rejects.toMatchObject({ code: "MDFN_TITLE_TOO_LARGE", status: 413 });
    await expect(service.read(principal, created.id)).resolves.toMatchObject({ title: "🌍", version: 1 });
  });

  it("rejects empty client-supplied document ids", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });

    await expect(service.create({ id: "author" }, { id: "", markdown: "body" }))
      .rejects.toMatchObject({ code: "MDFN_DOCUMENT_ID_INVALID", status: 422 });
  });

  it("wraps the adapter and enforces optimistic versions", async () => {
    const database = memoryAdapter();
    const service = createMdfnService({ database, durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `id-${id++}`; })() });
    const principal = { id: "u" };
    const created = await service.create(principal, { markdown: "# One" });
    const updated = await service.update(principal, created.id, { expectedVersion: 1, markdown: "# Two" });
    expect(updated.version).toBe(2);
    await expect(service.update(principal, created.id, { expectedVersion: 1, markdown: "# Three" })).rejects.toMatchObject({ code: "MDFN_VERSION_CONFLICT" });
    expect((await service.versions(principal, created.id)).versions).toHaveLength(2);
  });

  it("replays idempotent updates with semantically identical reordered payload keys", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "body" });
    const updated = await service.update(principal, created.id, {
      expectedVersion: 1,
      title: "Canonical payload",
      idempotencyKey: "canonical-update",
    });

    await expect(service.update(principal, created.id, {
      idempotencyKey: "canonical-update",
      title: "Canonical payload",
      expectedVersion: 1,
    })).resolves.toEqual(updated);
  });

  it("enforces tenant scope before host authorization and collaboration limits", async () => {
    const database = memoryAdapter();
    const service = createMdfnService({ database, durability: "ephemeral", authorize: () => true, maxCollaborationUpdateBytes: 4, createId: (() => { let id = 0; return () => `tenant-id-${id++}`; })() });
    const created = await service.create({ id: "a", tenantId: "tenant-a" }, { markdown: "# Scoped" });
    await expect(service.read({ id: "b", tenantId: "tenant-b" }, created.id)).rejects.toMatchObject({ code: "MDFN_DOCUMENT_NOT_FOUND" });
    await expect(service.appendCollaborationUpdate({ id: "a", tenantId: "tenant-a" }, created.id, "12345")).rejects.toMatchObject({ code: "MDFN_COLLAB_UPDATE_TOO_LARGE", status: 413 });
  });

  it("derives the default collaboration limit from valid document sizes", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "valid" });

    await expect(service.appendCollaborationUpdate(principal, document.id, "x".repeat(1024 * 1024 + 1)))
      .resolves.toBeTypeOf("string");
  }, HEAVY_FIXTURE_TEST_TIMEOUT_MS);

  it("paginates collaboration reads by row count and aggregate bytes", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      maxCollaborationUpdateBytes: 8,
      maxCollaborationBatchBytes: 8,
      maxCollaborationBatchUpdates: 2,
      createId: (() => { let id = 0; return () => `batch-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "valid" });
    await service.appendCollaborationUpdate(principal, document.id, "1234");
    await service.appendCollaborationUpdate(principal, document.id, "5678");
    await service.appendCollaborationUpdate(principal, document.id, "90");

    const first = await service.collaborationUpdates(principal, document.id);
    expect(first).toMatchObject({ updates: ["1234", "5678"], nextCursor: expect.any(String) });
    await expect(service.collaborationUpdates(principal, document.id, { cursor: first.nextCursor }))
      .resolves.toMatchObject({ updates: ["90"] });
    await expect(service.collaborationUpdates(principal, document.id, { cursor: "invalid" }))
      .rejects.toMatchObject({ code: "MDFN_COLLAB_CURSOR_INVALID", status: 422 });
  });

  it("keeps collaboration continuation stable across compaction", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      maxCollaborationBatchUpdates: 2,
      createId: (() => { let id = 0; return () => `stable-${String(id++).padStart(3, "0")}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "valid" });
    for (const update of ["one", "two", "three", "four"]) {
      await service.appendCollaborationUpdate(principal, document.id, update);
    }

    const first = await service.collaborationUpdates(principal, document.id);
    await service.compactCollaborationUpdates(principal, document.id, "snapshot", first.includedUpdateIds);
    const second = await service.collaborationUpdates(principal, document.id, { cursor: first.nextCursor });
    const third = await service.collaborationUpdates(principal, document.id, { cursor: second.nextCursor });

    expect(first.updates).toEqual(["one", "two"]);
    expect(second.updates).toEqual(["three", "four"]);
    expect(third.updates).toEqual(["snapshot"]);
  });

  it("orders later collaboration writes after issued cursors with a frozen clock and descending ids", async () => {
    const ids = ["z", "y", "a"];
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      createId: () => ids.shift()!,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { id: "document", markdown: "valid" });
    await service.appendCollaborationUpdate(principal, document.id, "first");
    await service.appendCollaborationUpdate(principal, document.id, "second");

    const first = await service.collaborationUpdates(principal, document.id, { limit: 1 });
    await service.appendCollaborationUpdate(principal, document.id, "third");
    const remainder = await service.collaborationUpdates(principal, document.id, { cursor: first.nextCursor });

    expect(first).toMatchObject({ updates: ["first"], includedUpdateIds: ["z"], nextCursor: expect.any(String) });
    expect(remainder).toMatchObject({ updates: ["second", "third"], includedUpdateIds: ["y", "a"] });
  });

  it("serializes document deletion with collaboration writes", async () => {
    let releaseCollaboration!: () => void;
    let collaborationAuthorizationStarted!: () => void;
    const collaborationGate = new Promise<void>((resolve) => { releaseCollaboration = resolve; });
    const authorizationStarted = new Promise<void>((resolve) => { collaborationAuthorizationStarted = resolve; });
    const actions: string[] = [];
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: async (action) => {
        actions.push(action);
        if (action === "collaborate") {
          collaborationAuthorizationStarted();
          await collaborationGate;
        }
        return true;
      },
      createId: (() => { let id = 0; return () => `delete-race-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { id: "shared-document", markdown: "body" });
    const append = service.appendCollaborationUpdate(principal, document.id, "racing-update");
    await authorizationStarted;

    const deleting = service.delete(principal, document.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(actions).not.toContain("delete");

    releaseCollaboration();
    await append;
    await deleting;
    await service.create(principal, { id: document.id, markdown: "recreated" });
    expect((await service.collaborationUpdates(principal, document.id)).updates).toEqual([]);
  });

  it("revalidates collaboration writes against deletion from another service instance", async () => {
    const database = memoryAdapter();
    let releaseCollaboration!: () => void;
    let collaborationAuthorizationStarted!: () => void;
    const collaborationGate = new Promise<void>((resolve) => { releaseCollaboration = resolve; });
    const authorizationStarted = new Promise<void>((resolve) => { collaborationAuthorizationStarted = resolve; });
    const writer = createMdfnService({
      database,
      durability: "ephemeral",
      authorize: async (action) => {
        if (action === "collaborate") {
          collaborationAuthorizationStarted();
          await collaborationGate;
        }
        return true;
      },
      createId: (() => { let id = 0; return () => `cross-service-writer-${id++}`; })(),
    });
    const deleter = createMdfnService({ database, durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    const document = await writer.create(principal, { id: "cross-service-document", markdown: "body" });
    const append = writer.appendCollaborationUpdate(principal, document.id, "racing-update");
    await authorizationStarted;

    await deleter.delete(principal, document.id);
    releaseCollaboration();

    await expect(append).rejects.toMatchObject({ code: "MDFN_DOCUMENT_NOT_FOUND" });
    await writer.create(principal, { id: document.id, markdown: "recreated" });
    expect((await writer.collaborationUpdates(principal, document.id)).updates).toEqual([]);
  });

  it("does not expose a stale cross-instance collaboration commit after document recreation", async () => {
    const database = memoryAdapter();
    const writer = createMdfnService({ database, durability: "ephemeral", authorize: () => true });
    const deleter = createMdfnService({ database, durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    const document = await writer.create(principal, { id: "recreated-race", markdown: "original" });
    await deleter.delete(principal, document.id);
    await deleter.create(principal, { id: document.id, markdown: "recreated" });
    await database.create({
      model: "mdfnCollaborationUpdates",
      data: {
        id: "late-stale-update",
        documentId: document.id,
        documentGeneration: document.collaborationGeneration,
        authorId: principal.id,
        update: "stale-update",
        cursorKey: "v2:00000000000000000001",
        createdAt: new Date(),
      },
    });

    await expect(writer.collaborationUpdates(principal, document.id)).resolves.toMatchObject({ updates: [] });
    await writer.appendCollaborationUpdate(principal, document.id, "current-update");
    await expect(writer.collaborationUpdates(principal, document.id)).resolves.toMatchObject({ updates: ["current-update"] });
  });

  it("paginates lightweight immutable version history", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "one", sidecar: { audit: [] } });
    await service.update(principal, created.id, { expectedVersion: 1, markdown: "two" });
    await service.update(principal, created.id, { expectedVersion: 2, markdown: "three" });

    const first = await service.versions(principal, created.id, { limit: 2 });
    const second = await service.versions(principal, created.id, { cursor: first.nextCursor, limit: 2 });

    expect(first.versions.map((version) => version.version)).toEqual([3, 2]);
    expect(first.versions[0]).not.toHaveProperty("markdown");
    expect(first.versions[0]).not.toHaveProperty("sidecar");
    expect(first.nextCursor).toBe("2");
    expect(second.versions.map((version) => version.version)).toEqual([1]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("fails closed when durable storage lacks transaction support", () => {
    const database = memoryAdapter();
    database.capabilities.transactions = {
      ...database.capabilities.transactions,
      supported: false,
    };

    expect(() => createMdfnService({ database, authorize: () => true })).toThrowError("MDFN_TRANSACTIONAL_DATABASE_REQUIRED");
  });

  it("fails closed when durable storage cannot enforce document collaboration constraints", () => {
    const database = memoryAdapter();
    database.capabilities.schema = {
      ...database.capabilities.schema,
      constraints: false,
    };
    database.capabilities.transactions = {
      ...database.capabilities.transactions,
      supported: true,
    };

    expect(() => createMdfnService({ database, authorize: () => true })).toThrowError("MDFN_RELATIONAL_CONSTRAINTS_REQUIRED");
  });

  it("persists editorial workflows, restores revisions, and compacts collaboration state", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `workflow-${id++}`; })() });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "# One" });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 2, to: 5 }, body: "Please revise", idempotencyKey: "comment" });
    const threadId = commented.sidecar?.comments?.[0]?.id;
    expect(threadId).toBeTruthy();
    expect((await service.createComment(principal, created.id, reorderObjectKeys({
      expectedVersion: 1,
      anchor: { from: 2, to: 5 },
      body: "Please revise",
      idempotencyKey: "comment",
    }))).version).toBe(2);
    await expect(service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 2, to: 5 }, body: "different payload", idempotencyKey: "comment" })).rejects.toMatchObject({ code: "MDFN_IDEMPOTENCY_KEY_REUSED" });
    const replied = await service.replyComment(principal, created.id, threadId!, { expectedVersion: 2, body: "Working on it" });
    const resolved = await service.resolveComment(principal, created.id, threadId!, { expectedVersion: 3, resolved: true });
    const suggested = await service.createSuggestion(principal, created.id, { expectedVersion: 4, anchor: { from: 2, to: 5 }, replacement: "Two" });
    const suggestionId = suggested.sidecar?.suggestions?.[0]?.id;
    const accepted = await service.decideSuggestion(principal, created.id, suggestionId!, { expectedVersion: 5, decision: "accepted" });
    expect(accepted.markdown).toBe("# Two");
    const reviewing = await service.transitionReview(principal, created.id, { expectedVersion: 6, state: "in-review" });
    expect(reviewing.sidecar?.reviewState).toBe("in-review");
    expect(reviewing.sidecar?.audit).toHaveLength(6);
    await service.appendCollaborationUpdate(principal, created.id, "one");
    await service.appendCollaborationUpdate(principal, created.id, "two");
    const batch = await service.collaborationUpdates(principal, created.id);
    await service.compactCollaborationUpdates(principal, created.id, "snapshot", batch.includedUpdateIds);
    expect((await service.collaborationUpdates(principal, created.id)).updates).toEqual(["snapshot"]);
    const restored = await service.restoreVersion(principal, created.id, { version: 1, expectedVersion: 7 });
    expect(restored).toMatchObject({ markdown: "# One", version: 8 });
    expect((await service.versions(principal, created.id)).versions).toHaveLength(8);
    await service.delete(principal, created.id);
    await expect(service.read(principal, created.id)).rejects.toMatchObject({ code: "MDFN_DOCUMENT_NOT_FOUND" });
    void replied;
    void resolved;
  });

  it("maps editorial anchors through disjoint Markdown changes", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `mapping-${id++}`; })() });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "aa middle zz" });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 3, to: 9 }, body: "Keep mapped" });
    const updated = await service.update(principal, created.id, { expectedVersion: commented.version, markdown: "Aaa middle zzZ" });
    expect(updated.sidecar?.comments?.[0]?.anchor).toEqual({ from: 4, to: 10 });
  });

  it("preserves disjoint ranges when the exact diff exceeds the quadratic cutoff", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `large-mapping-${id++}`; })() });
    const principal = { id: "author" };
    const middle = "m".repeat(500);
    const created = await service.create(principal, { markdown: `a${middle}z` });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 200, to: 300 }, body: "Keep mapped" });
    const updated = await service.update(principal, created.id, { expectedVersion: commented.version, markdown: `A${middle}Z` });
    expect(updated.sidecar?.comments?.[0]?.anchor).toEqual({ from: 200, to: 300 });
  });

  it("resynchronizes editorial anchors after a changed region exceeds the initial coarse window", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `large-resync-${id++}`; })() });
    const principal = { id: "author" };
    const deleted = "x".repeat(3_072);
    const stable = `${"u".repeat(1_500)}ANCHOR${"v".repeat(1_500)}`;
    const before = `start\n${deleted}\n${stable}\nlater old`;
    const after = `start\n${stable}\nlater new`;
    const anchorFrom = before.indexOf("ANCHOR");
    const created = await service.create(principal, { markdown: before });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: anchorFrom, to: anchorFrom + 6 }, body: "Keep mapped" });

    const updated = await service.update(principal, created.id, { expectedVersion: commented.version, markdown: after });
    const expectedFrom = after.indexOf("ANCHOR");

    expect(updated.sidecar?.comments?.[0]?.anchor).toEqual({ from: expectedFrom, to: expectedFrom + 6 });
  }, HEAVY_FIXTURE_TEST_TIMEOUT_MS);

  it("bounds coarse resynchronization when large replacements share no anchors", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `bounded-resync-${id++}`; })() });
    const principal = { id: "author" };
    const before = `${`${"x".repeat(200)}\n`.repeat(2_500)}tail`;
    const after = `${`${"y".repeat(200)}\n`.repeat(2_500)}tail`;
    const created = await service.create(principal, { markdown: before });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 100, to: 110 }, body: "Bound the search" });

    const updated = await service.update(principal, created.id, { expectedVersion: commented.version, markdown: after });

    expect(updated.markdown).toBe(after);
    expect(updated.sidecar?.comments?.[0]?.anchor.to).toBeLessThanOrEqual(after.length);
  }, HEAVY_FIXTURE_TEST_TIMEOUT_MS);

  it("shares the coarse resynchronization budget across many short stable runs", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `bounded-runs-${id++}`; })() });
    const principal = { id: "author" };
    const before = Array.from({ length: 4_000 }, (_, index) => `stable-${String(index).padStart(6, "0")}-segment old\n`).join("");
    const after = Array.from({ length: 4_000 }, (_, index) => `stable-${String(index).padStart(6, "0")}-segment new\n`).join("");
    const created = await service.create(principal, { markdown: before });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 20, to: 30 }, body: "Bound aggregate work" });

    const updated = await service.update(principal, created.id, { expectedVersion: commented.version, markdown: after });

    expect(updated.markdown).toBe(after);
    expect(updated.sidecar?.comments?.[0]?.anchor.to).toBeLessThanOrEqual(after.length);
  }, HEAVY_FIXTURE_TEST_TIMEOUT_MS);

  it("restores the complete historical title, Markdown, and sidecar snapshot", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `restore-${id++}`; })() });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "historic" });
    const titled = await service.update(principal, created.id, { expectedVersion: 1, title: "Current title", markdown: "current" });
    const commented = await service.createComment(principal, created.id, { expectedVersion: titled.version, anchor: { from: 0, to: 7 }, body: "current comment" });

    const restored = await service.restoreVersion(principal, created.id, { version: 1, expectedVersion: commented.version });

    expect(restored).toMatchObject({ markdown: "historic", version: 4 });
    expect(restored.title).toBeUndefined();
    expect(restored.sidecar).toBeUndefined();
    expect((await service.version(principal, created.id, 4)).sidecar).toBeUndefined();
  });

  it("rejects untrusted sidecar structures before persistence", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });
    await expect(service.create({ id: "author" }, { markdown: "safe", sidecar: { comments: "invalid" } as never })).rejects.toMatchObject({ code: "MDFN_DOCUMENT_INVALID", status: 422 });
  });

  it("filters list results through document-level authorization", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: (action, _principal, document) => action !== "read" || !document || document.title !== "restricted",
      createId: (() => { let id = 0; return () => `auth-${id++}`; })(),
    });
    const principal = { id: "owner" };
    await service.create(principal, { title: "visible", markdown: "visible" });
    const restricted = await service.create(principal, { title: "restricted", markdown: "secret" });
    await expect(service.read(principal, restricted.id)).rejects.toMatchObject({ code: "MDFN_FORBIDDEN" });
    expect((await service.list(principal)).map((document) => document.title)).toEqual(["visible"]);
  });

  it("applies authorization and visible offsets over bounded document pages", async () => {
    const database = memoryAdapter();
    const findMany = database.findMany.bind(database);
    const documentPageLimits: Array<number | undefined> = [];
    database.findMany = async <T = unknown>(params: Parameters<typeof database.findMany>[0]): Promise<T[]> => {
      if (params.model === "mdfnDocuments") documentPageLimits.push(params.limit);
      return findMany<T>(params);
    };
    const service = createMdfnService({
      database,
      durability: "ephemeral",
      authorize: (action, _principal, document) => action !== "read" || !document || Number(document.id.slice(4)) % 2 === 0,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    const principal = { id: "owner" };
    for (let index = 0; index < 60; index += 1) {
      await service.create(principal, { id: `doc-${String(index).padStart(2, "0")}`, markdown: String(index) });
    }

    const listed = await service.list(principal, { offset: 10, limit: 5 });

    expect(listed.map((document) => document.id)).toEqual(["doc-38", "doc-36", "doc-34", "doc-32", "doc-30"]);
    expect(documentPageLimits).toEqual([25, 25]);
  });

  it("keeps tenant documents out of owner-only listings", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      createId: (() => { let id = 0; return () => `scope-${id++}`; })(),
    });
    await service.create({ id: "owner", tenantId: "tenant-a" }, { title: "tenant", markdown: "tenant" });
    await service.create({ id: "owner" }, { title: "personal", markdown: "personal" });
    expect((await service.list({ id: "owner" })).map((document) => document.title)).toEqual(["personal"]);
  });

  it("preserves collaboration updates appended after the compacted batch was read", async () => {
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: () => true,
      createId: (() => { let id = 0; return () => `race-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "body" });
    await service.appendCollaborationUpdate(principal, document.id, "included-one");
    await service.appendCollaborationUpdate(principal, document.id, "included-two");
    const batch = await service.collaborationUpdates(principal, document.id);
    await service.appendCollaborationUpdate(principal, document.id, "racing-update");
    await service.compactCollaborationUpdates(principal, document.id, "snapshot", batch.includedUpdateIds);
    const compacted = await service.collaborationUpdates(principal, document.id);
    expect(compacted.updates).toEqual(expect.arrayContaining(["racing-update", "snapshot"]));
    expect(compacted.updates).toHaveLength(2);
  });

  it("authorizes destructive collaboration compaction separately", async () => {
    const actions: string[] = [];
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: (action) => {
        actions.push(action);
        return action !== "compact-collaboration";
      },
      createId: (() => { let id = 0; return () => `compact-auth-${id++}`; })(),
    });
    const principal = { id: "editor" };
    const document = await service.create(principal, { markdown: "body" });
    await service.appendCollaborationUpdate(principal, document.id, "update");
    const batch = await service.collaborationUpdates(principal, document.id);

    await expect(service.compactCollaborationUpdates(principal, document.id, "snapshot", batch.includedUpdateIds))
      .rejects.toMatchObject({ code: "MDFN_FORBIDDEN", status: 403 });
    expect(actions).toContain("collaborate");
    expect(actions).toContain("compact-collaboration");
    expect((await service.collaborationUpdates(principal, document.id)).updates).toEqual(["update"]);
  });

  it("authorizes protected editorial decisions separately from document updates", async () => {
    const actions: string[] = [];
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: (action) => {
        actions.push(action);
        return action !== "suggestion:decide" && action !== "review:transition";
      },
      createId: (() => { let id = 0; return () => `editorial-auth-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "body" });
    await expect(service.update(principal, document.id, { expectedVersion: 1, markdown: "updated" }))
      .resolves.toMatchObject({ markdown: "updated" });
    const suggested = await service.createSuggestion(principal, document.id, {
      expectedVersion: 2,
      anchor: { from: 0, to: 7 },
      replacement: "accepted",
    });
    const suggestionId = suggested.sidecar?.suggestions?.[0]?.id;

    await expect(service.decideSuggestion(principal, document.id, suggestionId!, {
      expectedVersion: 3,
      decision: "accepted",
    })).rejects.toMatchObject({ code: "MDFN_FORBIDDEN" });
    await expect(service.transitionReview(principal, document.id, {
      expectedVersion: 3,
      state: "in-review",
    })).rejects.toMatchObject({ code: "MDFN_FORBIDDEN" });
    expect(actions).toEqual(expect.arrayContaining(["update", "suggestion:create", "suggestion:decide", "review:transition"]));
  });

  it("authorizes restoration of protected editorial snapshots separately", async () => {
    const actions: string[] = [];
    let restricted = false;
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: (action) => {
        actions.push(action);
        return !restricted || !["history:restore", "suggestion:decide", "review:transition"].includes(action);
      },
      createId: (() => { let id = 0; return () => `restore-auth-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "original" });
    const reviewing = await service.transitionReview(principal, document.id, {
      expectedVersion: 1,
      state: "in-review",
    });
    restricted = true;

    await expect(service.version(principal, document.id, 1)).resolves.toMatchObject({ version: 1 });
    const updated = await service.update(principal, document.id, {
      expectedVersion: reviewing.version,
      markdown: "updated",
    });
    actions.length = 0;
    await expect(service.restoreVersion(principal, document.id, {
      version: 1,
      expectedVersion: updated.version,
    })).rejects.toMatchObject({ code: "MDFN_FORBIDDEN", status: 403 });
    expect(actions).toEqual(["history:restore"]);

    await expect(service.read(principal, document.id)).resolves.toMatchObject({
      markdown: "updated",
      version: updated.version,
      sidecar: { reviewState: "in-review" },
    });
  });

  it("allows history restore without ordinary history or update permission", async () => {
    const actions: string[] = [];
    let restoreOnly = false;
    const service = createMdfnService({
      database: memoryAdapter(),
      durability: "ephemeral",
      authorize: (action) => {
        actions.push(action);
        return !restoreOnly || action === "history:restore";
      },
      createId: (() => { let id = 0; return () => `restore-only-${id++}`; })(),
    });
    const principal = { id: "author" };
    const document = await service.create(principal, { markdown: "original" });
    const reviewing = await service.transitionReview(principal, document.id, {
      expectedVersion: document.version,
      state: "in-review",
    });
    const updated = await service.update(principal, document.id, {
      expectedVersion: reviewing.version,
      markdown: "updated",
    });
    restoreOnly = true;
    actions.length = 0;

    await expect(service.restoreVersion(principal, document.id, {
      version: reviewing.version,
      expectedVersion: updated.version,
    })).resolves.toMatchObject({
      markdown: "original",
      sidecar: { reviewState: "in-review" },
      version: updated.version + 1,
    });
    expect(actions).toEqual(["history:restore", "history:restore"]);
  });

  it("keeps editorial state and audit history server-authoritative", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `integrity-${id++}`; })() });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "hello" });
    const commented = await service.createComment(principal, created.id, { expectedVersion: 1, anchor: { from: 0, to: 5 }, body: "review" });
    await expect(service.update(principal, created.id, { expectedVersion: commented.version, sidecar: { ...commented.sidecar, comments: [], audit: [] } }))
      .rejects.toMatchObject({ code: "MDFN_EDITORIAL_MUTATION_FORBIDDEN", status: 403 });
    const stored = await service.read(principal, created.id);
    expect(stored.sidecar?.comments).toHaveLength(1);
    expect(stored.sidecar?.audit).toHaveLength(1);
  });

  it("maps protected anchors while accepting unprotected sidecar updates", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true, createId: (() => { let id = 0; return () => `sidecar-${id++}`; })() });
    const principal = { id: "author" };
    const created = await service.create(principal, { markdown: "hello world" });
    const commented = await service.createComment(principal, created.id, {
      expectedVersion: created.version,
      anchor: { from: 6, to: 11 },
      body: "review",
    });
    const updated = await service.update(principal, created.id, {
      expectedVersion: commented.version,
      markdown: "say hello world",
      sidecar: {
        ...reorderObjectKeys(commented.sidecar),
        assets: [{ id: "asset-1", mediaType: "image/png", name: "proof.png" }],
        historyRef: "history-2",
      },
    });

    expect(updated.sidecar?.comments?.[0]?.anchor).toEqual({ from: 10, to: 15 });
    expect(updated.sidecar?.assets).toEqual([{ id: "asset-1", mediaType: "image/png", name: "proof.png" }]);
    expect(updated.sidecar?.historyRef).toBe("history-2");
  });

  it("rejects protected editorial state during document creation", async () => {
    const service = createMdfnService({ database: memoryAdapter(), durability: "ephemeral", authorize: () => true });
    const principal = { id: "author" };
    await expect(service.create(principal, {
      markdown: "hello",
      sidecar: { reviewState: "approved", comments: [], suggestions: [], audit: [] },
    })).rejects.toMatchObject({ code: "MDFN_EDITORIAL_MUTATION_FORBIDDEN", status: 403 });
  });
});
