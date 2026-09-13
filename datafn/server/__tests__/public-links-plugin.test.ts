import { describe, expect, it, vi } from "vitest";
import {
  createMemoryIndexedDirectoryStore,
  memoryAdapter,
} from "@superfunctions/db/adapters";
import type { TransactionAdapter } from "@superfunctions/db";
import type { DatafnSchema } from "@datafn/core";
import {
  createDatafnPublicLinksPlugin,
  createDatafnServer,
  createMemoryDatafnPlacementDirectory,
  datafnMultiRegionPlugin,
  withDatafnPublicLinksSchema,
  type DatafnPublicLinkPrincipal,
  type DatafnServer,
  type SearchProvider,
} from "../src/index.js";
import {
  drainPermissionDirectoryOutbox,
  drainPermissionDirectorySync,
} from
  "../src/execution/mutation/permission-directory-outbox.js";

type TestContext = {
  ownerActorId: string | null;
  publicLink: DatafnPublicLinkPrincipal | null;
};

const shareable = {
  shareable: {
    levels: ["viewer", "editor", "owner"],
    default: "private",
    visibilityDefault: "private",
    supportsScopeGrants: true,
    crossNsShareable: true,
    principalMode: "opaque-id",
  },
} as const;

const schema = {
  resources: [
    {
      name: "linkTag",
      version: 1,
      idPrefix: "tag",
      capabilities: ["timestamps", "audit", shareable],
      fields: [
        { name: "id", type: "string" as const, required: true, unique: true },
        { name: "label", type: "string" as const, required: false },
      ],
      indices: { base: ["label"], search: ["label"] },
      permissions: {
        read: { fields: ["id", "label"] },
        write: { fields: ["id", "label"] },
      },
    },
    {
      name: "note",
      version: 1,
      idPrefix: "note",
      fields: [
        { name: "id", type: "string" as const, required: true, unique: true },
        { name: "title", type: "string" as const, required: false },
      ],
      indices: { base: ["title"], search: ["title"] },
      permissions: {
        read: { fields: ["id", "title"] },
        write: { fields: ["id", "title"] },
      },
    },
  ],
  relations: [],
} satisfies DatafnSchema;

describe("DataFn public-links plugin", () => {
  it("returns a retryable placement error when public-link directory lookup fails", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const memoryDirectory = createMemoryIndexedDirectoryStore();
    const unavailableDirectory = {
      ...memoryDirectory,
      async get() {
        throw new Error("directory offline");
      },
    };
    const publicLinks = createDatafnPublicLinksPlugin<{ actorId: string }>({
      getOwnerActorId: (session) => session.actorId,
      getOwnerNamespace: (actorId) => `user:${actorId}`,
      directory: unavailableDirectory,
      resourceRegion: "region:public-links",
    });
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      publicLinks,
      plugins: [
        datafnMultiRegionPlugin({
          regionId: "region:public-links",
          directory: unavailableDirectory,
          placement: {
            directory: createMemoryDatafnPlacementDirectory(),
          },
        }),
      ],
    });

    try {
      const response = await post(
        server,
        "/datafn/public-links/resolve",
        { token: "link:missing.secret" },
      );
      expect(response).toMatchObject({
        status: 503,
        body: {
          error: {
            code: "DATAFN_PLACEMENT_UNAVAILABLE",
            details: { retryable: true, executionStarted: false },
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("routes public links from their direct directory record without the permission index", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const memoryDirectory = createMemoryIndexedDirectoryStore();
    let permissionQueries = 0;
    const get = vi.fn(memoryDirectory.get.bind(memoryDirectory));
    const directory = {
      ...memoryDirectory,
      get,
      async query(input: Parameters<typeof memoryDirectory.query>[0]) {
        permissionQueries++;
        return memoryDirectory.query(input);
      },
    };
    const placement = createMemoryDatafnPlacementDirectory();
    await placement.putIfAbsent({
      namespace: "user:owner",
      regionId: "region:public-links",
      epoch: 1,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const authenticateOwner = vi.fn((request: Request) => {
      const actorId = request.headers.get("x-owner-actor");
      return actorId ? { actorId } : null;
    });
    const publicLinks = createDatafnPublicLinksPlugin<{ actorId: string }>({
      authenticateOwner,
      getOwnerActorId: (session) => session.actorId,
      getOwnerNamespace: (actorId) => `user:${actorId}`,
      directory,
      resourceRegion: "region:public-links",
    });
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      publicLinks,
      plugins: [datafnMultiRegionPlugin({
        regionId: "region:public-links",
        directory,
        placement: { directory: placement },
      })],
    });

    try {
      const created = await post(
        server,
        "/datafn/public-links",
        { resource: "linkTag", scope: "resource", level: "viewer" },
        ownerHeaders(),
      );
      expect(created.status).toBe(200);
      expect(authenticateOwner).toHaveBeenCalledOnce();
      const token = readString(created.body.result.token);
      get.mockClear();
      permissionQueries = 0;

      const response = await post(
        server,
        "/datafn/public-links/resolve",
        { token },
      );
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(get).toHaveBeenCalledWith(
        `datafn:publicLink:${token.slice(0, token.indexOf("."))}`,
      );
      expect(permissionQueries).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("keeps public-link storage plugin-owned and blocks direct data endpoint access", async () => {
    const db = memoryAdapter();
    await db.initialize();

    const publicLinks = createTestPublicLinks();
    const searchCalls: Array<Record<string, unknown>> = [];
    const searchProvider: SearchProvider = {
      name: "public-link-test-search",
      search: async () => [],
      searchAll: async (params) => {
        searchCalls.push(params as Record<string, unknown>);
        return [
          { resource: "linkTag", id: "tag:1", score: 0.9 },
          { resource: "note", id: "note:1", score: 0.8 },
          { resource: "linkTag", id: "tag:2", score: 0.7 },
        ];
      },
      updateIndices: async () => {},
    };
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      allowUnknownResources: false,
      publicLinks,
      searchProvider,
      context: async (request) => ({
        ownerActorId: request.headers.get("x-owner-actor"),
        publicLink: await publicLinks.resolve(db, publicLinks.readToken(request)),
      }),
      authorize: (ctx) => {
        if (ctx.ownerActorId) return true;
        if (ctx.publicLink) return true;
        return false;
      },
      namespaceProvider: {
        getNamespace: (ctx) => ctx.publicLink?.namespace ?? `user:${ctx.ownerActorId ?? "anonymous"}`,
        getActorId: (ctx) => ctx.publicLink?.actorId ?? ctx.ownerActorId ?? undefined,
      },
    });

    const composedSchema = withDatafnPublicLinksSchema(schema);
    expect(schema.resources.some((resource) => resource.name === "publicLink")).toBe(false);
    expect(composedSchema.resources.some((resource) => resource.name === "publicLink")).toBe(true);

    const insert = await post(server, "/datafn/mutation", {
      resource: "linkTag",
      version: 1,
      operation: "insert",
      id: "tag:1",
      clientId: "c1",
      mutationId: "m1",
      record: { id: "tag:1", label: "Shared tag" },
    }, ownerHeaders());
    expect(insert.status).toBe(200);
    expect(insert.body.ok).toBe(true);

    const insertSibling = await post(server, "/datafn/mutation", {
      resource: "linkTag",
      version: 1,
      operation: "insert",
      id: "tag:2",
      clientId: "c1",
      mutationId: "m2",
      record: { id: "tag:2", label: "Sibling tag" },
    }, ownerHeaders());
    expect(insertSibling.status).toBe(200);
    expect(insertSibling.body.ok).toBe(true);

    const insertNote = await post(server, "/datafn/mutation", {
      resource: "note",
      version: 1,
      operation: "insert",
      id: "note:1",
      clientId: "c1",
      mutationId: "m3",
      record: { id: "note:1", title: "Shared note" },
    }, ownerHeaders());
    expect(insertNote.status).toBe(200);
    expect(insertNote.body.ok).toBe(true);

    const created = await post(server, "/datafn/public-links", {
      resource: "linkTag",
      recordId: "tag:1",
      scope: "record",
      level: "viewer",
    }, ownerHeaders());
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.result.tokenHash).toBeUndefined();

    const token = readString(created.body.result.token);
    const tokenHeaders = publicLinkHeaders(token);
    const resolved = await post(server, "/datafn/public-links/resolve", { token });
    expect(resolved.status).toBe(200);
    expect(resolved.body.ok).toBe(true);
    expect(resolved.body.result).toMatchObject({
      principalId: readString(created.body.result.principalId),
      resource: "linkTag",
      recordId: "tag:1",
    });
    const publicRead = await post(server, "/datafn/query", {
      resource: "linkTag",
      version: 1,
      filters: { id: "tag:1" },
      select: ["id", "label"],
    }, tokenHeaders);
    expect(publicRead.status).toBe(200);
    expect(publicRead.body.ok).toBe(true);
    expect(publicRead.body.result.data[0]).toMatchObject({
      id: "tag:1",
      label: "Shared tag",
    });

    const siblingRead = await post(server, "/datafn/query", {
      resource: "linkTag",
      version: 1,
      filters: { id: "tag:2" },
      select: ["id", "label"],
    }, tokenHeaders);
    expect(siblingRead.status).toBe(403);
    expect(siblingRead.body.error.code).toBe("FORBIDDEN");

    const broadRead = await post(server, "/datafn/query", {
      resource: "linkTag",
      version: 1,
      select: ["id", "label"],
    }, tokenHeaders);
    expect(broadRead.status).toBe(403);
    expect(broadRead.body.error.code).toBe("FORBIDDEN");

    const systemRead = await post(server, "/datafn/query", {
      resource: "kv",
      version: 1,
      filters: { id: "kv:any" },
      select: ["id", "value"],
    }, tokenHeaders);
    expect(systemRead.status).toBe(403);
    expect(systemRead.body.error.code).toBe("FORBIDDEN");

    const directPublicLinkRead = await post(server, "/datafn/query", {
      resource: "publicLink",
      version: 1,
      select: ["*"],
    }, tokenHeaders);
    expect(directPublicLinkRead.status).toBe(403);

    const recordSearch = await post(server, "/datafn/search", {
      query: "Shared",
    }, tokenHeaders);
    expect(recordSearch.status).toBe(403);
    expect(recordSearch.body.error.code).toBe("FORBIDDEN");
    expect(searchCalls).toHaveLength(0);

    for (const path of [
      "/datafn/mutation",
      "/datafn/transact",
      "/datafn/seed",
      "/datafn/clone",
      "/datafn/pull",
      "/datafn/push",
      "/datafn/reconcile",
    ]) {
      const denied = await post(server, path, {
        // Valid selector-bearing envelopes reach the plugin authorization gate.
        resource: "linkTag",
        resources: ["linkTag"],
        clientId: "public-client",
        mutations: [],
        steps: [],
      }, tokenHeaders);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("FORBIDDEN");
    }

    const resourceCreated = await post(server, "/datafn/public-links", {
      resource: "linkTag",
      scope: "resource",
      level: "viewer",
    }, ownerHeaders());
    expect(resourceCreated.status).toBe(200);
    expect(resourceCreated.body.ok).toBe(true);

    const resourceSearch = await post(server, "/datafn/search", {
      query: "Shared",
    }, publicLinkHeaders(readString(resourceCreated.body.result.token)));
    expect(resourceSearch.status).toBe(200);
    expect(resourceSearch.body.ok).toBe(true);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].resources).toEqual(["linkTag"]);
    expect(resourceSearch.body.result.results.map((item: Record<string, unknown>) => item.resource))
      .toEqual(["linkTag", "linkTag"]);

    const revoked = await post(server, "/datafn/public-links/revoke", {
      id: readString(created.body.result.id),
    }, ownerHeaders());
    expect(revoked.status).toBe(200);
    expect(revoked.body.ok).toBe(true);

    const revokedResolve = await post(server, "/datafn/public-links/resolve", { token });
    expect(revokedResolve.status).toBe(404);
    expect(revokedResolve.body.error.code).toBe("NOT_FOUND");

    const revokedRead = await post(server, "/datafn/query", {
      resource: "linkTag",
      version: 1,
      filters: { id: "tag:1" },
      select: ["id"],
    }, tokenHeaders);
    expect(revokedRead.status).toBe(403);
  });

  it("keeps directory work pending until a public-link share is committed", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const directory = createMemoryIndexedDirectoryStore();
    const runtime = { regionId: "region:public-links", directory };
    const publicLinks = createDatafnPublicLinksPlugin<{ actorId: string }>({
      authenticateOwner: (request) => {
        const actorId = request.headers.get("x-owner-actor");
        return actorId ? { actorId } : null;
      },
      getOwnerActorId: (session) => session.actorId,
      getOwnerNamespace: (actorId) => `user:${actorId}`,
      directory,
      resourceRegion: runtime.regionId,
    });
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      allowUnknownResources: false,
      publicLinks,
      namespaceProvider: {
        getNamespace: () => "user:owner",
        getActorId: () => "owner",
      },
    });
    let releasePermissionCreate!: () => void;
    const permissionCreateReleased = new Promise<void>((resolve) => {
      releasePermissionCreate = resolve;
    });
    let permissionCreateStarted!: () => void;
    const permissionCreateReached = new Promise<void>((resolve) => {
      permissionCreateStarted = resolve;
    });
    try {
      const inserted = await post(server, "/datafn/mutation", {
        resource: "linkTag",
        version: 1,
        operation: "insert",
        id: "tag:pending-link",
        clientId: "public-link-pending",
        mutationId: "public-link-pending-insert",
        record: { id: "tag:pending-link", label: "Pending link" },
      }, ownerHeaders());
      expect(inserted.status).toBe(200);

      const originalCreate = db.create.bind(db);
      db.create = async (input) => {
        if (input.model === "__datafn_permissions_global") {
          permissionCreateStarted();
          await permissionCreateReleased;
        }
        return originalCreate(input);
      };

      const creating = post(server, "/datafn/public-links", {
        resource: "linkTag",
        recordId: "tag:pending-link",
        scope: "record",
        level: "viewer",
      }, ownerHeaders());
      await permissionCreateReached;

      await expect(drainPermissionDirectoryOutbox(db, runtime))
        .resolves.toEqual({ processed: 0, pending: 0 });
      await expect(db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      )).resolves.toHaveLength(1);

      releasePermissionCreate();
      const created = await creating;
      expect(created.status).toBe(200);
      const indexed = await directory.query({
        index: "datafn.permission.principalResource",
        value: `${readString(created.body.result.principalId)}#linkTag`,
      });
      expect(indexed.records).toHaveLength(1);
      await expect(db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      )).resolves.toHaveLength(0);
    } finally {
      releasePermissionCreate();
      await server.close();
    }
  });

  it("removes public-link and canonical grant rows when sharing throws after the grant write", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const directory = createMemoryIndexedDirectoryStore();
    const publicLinks = createDatafnPublicLinksPlugin<{ actorId: string }>({
      authenticateOwner: (request) => {
        const actorId = request.headers.get("x-owner-actor");
        return actorId ? { actorId } : null;
      },
      getOwnerActorId: (session) => session.actorId,
      getOwnerNamespace: (actorId) => `user:${actorId}`,
      directory,
      resourceRegion: "region:public-links",
    });
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      allowUnknownResources: false,
      publicLinks,
      namespaceProvider: {
        getNamespace: () => "user:owner",
        getActorId: () => "owner",
      },
    });
    try {
      const inserted = await post(server, "/datafn/mutation", {
        resource: "linkTag",
        version: 1,
        operation: "insert",
        id: "tag:throwing-link",
        clientId: "public-link-throw",
        mutationId: "public-link-throw-insert",
        record: { id: "tag:throwing-link", label: "Throwing link" },
      }, ownerHeaders());
      expect(inserted.status).toBe(200);

      const originalCreate = db.create.bind(db);
      db.create = async (input) => {
        if (input.model === "__datafn_permissions_global") {
          await originalCreate(input);
          throw new Error("post-permission write failure");
        }
        return originalCreate(input);
      };

      const created = await post(server, "/datafn/public-links", {
        resource: "linkTag",
        recordId: "tag:throwing-link",
        scope: "record",
        level: "viewer",
      }, ownerHeaders());

      expect(created.status).toBeGreaterThanOrEqual(500);
      await expect(db.findMany({
        model: "publicLink",
        where: [],
        namespace: "user:owner",
      })).resolves.toEqual([]);
      await expect(db.findMany({
        model: "__datafn_permissions_global",
        where: [],
        namespace: "user:owner",
      })).resolves.toEqual([]);
      await expect(db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      )).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("durably retries failed share compensation", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const directory = createMemoryIndexedDirectoryStore();
    const runtime = { regionId: "region:compensation", directory };
    const publicLinks = createDatafnPublicLinksPlugin<{ actorId: string }>({
      authenticateOwner: (request) => {
        const actorId = request.headers.get("x-owner-actor");
        return actorId ? { actorId } : null;
      },
      getOwnerActorId: (session) => session.actorId,
      getOwnerNamespace: (actorId) => `user:${actorId}`,
      directory,
      resourceRegion: runtime.regionId,
    });
    const server = await createDatafnServer<TestContext>({
      schema,
      database: db,
      allowUnknownResources: false,
      publicLinks,
      namespaceProvider: {
        getNamespace: () => "user:owner",
        getActorId: () => "owner",
      },
    });
    const originalCreate = db.create.bind(db);
    const originalTransaction = db.transaction.bind(db);
    const originalInternalUpdate = db.internal.update.bind(db.internal);
    let failCompensation = true;
    let lostOriginalTask = false;
    db.internal.update = async (table, where, data) => {
      if (
        table === "__datafn_permission_directory_outbox" &&
        String(data.mutation ?? "").includes("compensate-failed-share")
      ) {
        lostOriginalTask = true;
        return 0;
      }
      return originalInternalUpdate(table, where, data);
    };
    try {
      const inserted = await post(server, "/datafn/mutation", {
        resource: "linkTag",
        version: 1,
        operation: "insert",
        id: "tag:compensation",
        clientId: "public-link-compensation",
        mutationId: "public-link-compensation-insert",
        record: { id: "tag:compensation", label: "Compensation" },
      }, ownerHeaders());
      expect(inserted.status).toBe(200);
      db.create = async (input) => {
        const result = await originalCreate(input);
        if (input.model === "__datafn_permissions_global") {
          throw new Error("post-permission write failure");
        }
        return result;
      };
      db.transaction = async <R>(
        callback: (trx: TransactionAdapter) => Promise<R>,
      ) => originalTransaction(async (trx) => {
        const originalTransactionDeleteMany = trx.deleteMany.bind(trx);
        trx.deleteMany = async (input) => {
          if (
            failCompensation &&
            input.model === "__datafn_permissions_global"
          ) {
            throw new Error("canonical cleanup unavailable");
          }
          return originalTransactionDeleteMany(input);
        };
        return callback(trx);
      });

      const created = await post(server, "/datafn/public-links", {
        resource: "linkTag",
        recordId: "tag:compensation",
        scope: "record",
        level: "viewer",
      }, ownerHeaders());
      expect(created.status).toBeGreaterThanOrEqual(500);
      const tasksAfterOwnershipLoss = await db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      );
      expect(lostOriginalTask).toBe(true);
      expect(tasksAfterOwnershipLoss).toHaveLength(1);
      const replacement = tasksAfterOwnershipLoss.find((task) =>
        String(task.mutation).includes("compensate-failed-share")
      );
      expect(replacement).toBeDefined();
      const pending = await db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      );
      expect(pending).toHaveLength(1);
      expect(String(pending[0].mutation)).toContain("compensate-failed-share");

      failCompensation = false;
      db.internal.update = originalInternalUpdate;
      await expect(drainPermissionDirectorySync(
        db,
        String(replacement!.id),
        runtime,
      )).resolves.toBe(true);
      await expect(db.findMany({
        model: "__datafn_permissions_global",
        where: [],
        namespace: "user:owner",
      })).resolves.toEqual([]);
      await expect(db.internal.findMany(
        "__datafn_permission_directory_outbox",
        [],
      )).resolves.toEqual([]);
    } finally {
      failCompensation = false;
      db.transaction = originalTransaction;
      db.internal.update = originalInternalUpdate;
      await server.close();
    }
  });
});

function createTestPublicLinks() {
  const directory = createMemoryIndexedDirectoryStore();
  return createDatafnPublicLinksPlugin<{ actorId: string }>({
    authenticateOwner: (request) => {
      const actorId = request.headers.get("x-owner-actor");
      return actorId ? { actorId } : null;
    },
    getOwnerActorId: (session) => session.actorId,
    getOwnerNamespace: (actorId) => `user:${actorId}`,
    directory: {
      ...directory,
      // Simulate an interrupted cache invalidation. The revoked database row
      // must still be authoritative over this deliberately stale entry.
      async delete() {},
    },
  });
}

function ownerHeaders(): Record<string, string> {
  return { "x-owner-actor": "owner" };
}

function publicLinkHeaders(token: string): Record<string, string> {
  return { "x-datafn-public-link-token": token };
}

async function post(
  server: DatafnServer<TestContext>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await server.router.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    {} as TestContext,
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected string");
  }
  return value;
}
