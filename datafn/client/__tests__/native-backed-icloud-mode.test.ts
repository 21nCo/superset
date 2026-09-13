import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  createDatafnClient,
  MemoryStorageAdapter,
} from "../src/index.js";
import { SyncEngine } from "../src/sync/engine.js";
import {
  createNativeBackedRemoteAdapter,
  createNativeBackedStorageAdapter,
  createNativeSyncController,
  createWKWebViewBridgeBus,
} from "../../swift-bridge/src/index.js";

type BridgeRequest = {
  protocol: string;
  id: string;
  method: string;
  payload?: any;
};

const schema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: false },
        { name: "completed", type: "boolean" as const, required: false },
      ],
    },
    {
      name: "auditLogs",
      version: 1,
      isRemoteOnly: true,
      fields: [{ name: "kind", type: "string" as const, required: false }],
    },
  ],
  relations: [],
} as const;

function installNativeICloudHost() {
  const storage = Object.assign(new MemoryStorageAdapter(), {
    __datafnNativeBacked: true as const,
  });
  const syncCalls: string[] = [];
  const remoteCalls: string[] = [];

  const postMessage = vi.fn((message: unknown) => {
    const envelope = message as BridgeRequest;

    void (async () => {
      const response = await handleRequest(
        storage,
        envelope,
        syncCalls,
        remoteCalls,
      );
      window.__datafnBridgeReceive__?.(response);
    })();
  });

  (globalThis as any).window = {
    webkit: {
      messageHandlers: {
        datafn: { postMessage },
      },
    },
  };

  return { storage, syncCalls, remoteCalls, postMessage };
}

async function handleRequest(
  storage: MemoryStorageAdapter,
  envelope: BridgeRequest,
  syncCalls: string[],
  remoteCalls: string[],
) {
  switch (envelope.method) {
    case "handshake":
      return success(envelope, {
        bridgeVersion: 1,
        schemaHash: "abc123",
        namespace: "default",
        storageBackend: "coredata",
        syncOwner: "native",
        remoteMode: "icloud",
        indexedDbDisabled: true,
        cloudKitPrivateOnly: true,
        capabilities: ["storage", "remote", "sync", "events", "health"],
      });
    case "sync.start":
    case "sync.stop":
    case "sync.pullNow":
    case "sync.cloneNow":
    case "sync.reconcileNow":
    case "sync.schedulePush":
      syncCalls.push(envelope.method);
      return success(envelope, null);
    case "remote.query": {
      remoteCalls.push(envelope.method);
      const queries = Array.isArray(envelope.payload)
        ? envelope.payload
        : [envelope.payload];
      const results = await Promise.all(
        queries.map(async (query) => ({
          source: "native-icloud-runtime",
          data:
            query?.resource === "tasks"
              ? await storage.listRecords("tasks")
              : [],
        })),
      );
      return success(
        envelope,
        {
          ok: true,
          result: Array.isArray(envelope.payload) ? results : results[0],
        },
      );
    }
    case "storage.getRecord":
      return success(
        envelope,
        await storage.getRecord(envelope.payload.resource, envelope.payload.id),
      );
    case "storage.listRecords":
      return success(
        envelope,
        await storage.listRecords(envelope.payload.resource),
      );
    case "storage.upsertRecord":
      await storage.upsertRecord(envelope.payload.resource, envelope.payload.record);
      return success(envelope, null);
    case "storage.deleteRecord":
      await storage.deleteRecord(envelope.payload.resource, envelope.payload.id);
      return success(envelope, null);
    case "storage.mergeRecord":
      return success(
        envelope,
        await storage.mergeRecord(
          envelope.payload.resource,
          envelope.payload.id,
          envelope.payload.partial,
        ),
      );
    case "storage.findRecords":
      return success(
        envelope,
        await storage.findRecords(
          envelope.payload.resource,
          envelope.payload.field,
          envelope.payload.value,
        ),
      );
    case "storage.getHydrationState":
      return success(
        envelope,
        await storage.getHydrationState(envelope.payload.resource),
      );
    case "storage.setHydrationState":
      await storage.setHydrationState(
        envelope.payload.resource,
        envelope.payload.state,
      );
      return success(envelope, null);
    case "storage.changelogAppend":
      return success(
        envelope,
        await storage.changelogAppend(envelope.payload.entry),
      );
    case "storage.changelogList":
      return success(
        envelope,
        await storage.changelogList(envelope.payload.options),
      );
    case "storage.changelogAck":
      await storage.changelogAck(envelope.payload.options);
      return success(envelope, null);
    case "storage.getCursor":
      return success(
        envelope,
        await storage.getCursor(envelope.payload.resource),
      );
    case "storage.setCursor":
      await storage.setCursor(envelope.payload.resource, envelope.payload.cursor);
      return success(envelope, null);
    case "storage.countRecords":
      return success(
        envelope,
        await storage.countRecords(envelope.payload.resource),
      );
    case "storage.close":
      await storage.close();
      return success(envelope, null);
    case "storage.clearAll":
      await storage.clearAll();
      return success(envelope, null);
    case "storage.healthCheck":
      return success(envelope, await storage.healthCheck());
    default:
      return {
        protocol: envelope.protocol,
        id: envelope.id,
        ok: false as const,
        error: {
          code: "BRIDGE_METHOD_UNSUPPORTED",
          message: "Unsupported bridge method",
          details: { path: "method", method: envelope.method },
        },
      };
  }
}

function success(envelope: BridgeRequest, result: unknown) {
  return {
    protocol: envelope.protocol,
    id: envelope.id,
    ok: true as const,
    result,
  };
}

describe("native-backed icloud bridge integration", () => {
  afterEach(() => {
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it("TV-API-003 / TV-QRY-003 / TV-QRY-004: embedded icloud mode stays native-backed, schedules native sync, and rejects remote-only resources explicitly", async () => {
    const host = installNativeICloudHost();
    await host.storage.setHydrationState("tasks", "hydrating");
    await host.storage.setHydrationState("tasks", "ready");
    await host.storage.upsertRecord("tasks", {
      id: "task:1",
      title: "Across devices",
      completed: false,
    });

    const startSpy = vi.spyOn(SyncEngine.prototype, "start");
    const schedulePushSpy = vi.spyOn(SyncEngine.prototype, "schedulePush");

    const bus = createWKWebViewBridgeBus();
    const client = createDatafnClient({
      schema,
      clientId: "icloud-client",
      storage: createNativeBackedStorageAdapter(bus),
      sync: {
        owner: "native",
        mode: "sync",
        offlinability: true,
        remoteAdapter: createNativeBackedRemoteAdapter(bus),
        native: {
          syncController: createNativeSyncController(bus),
          remoteMode: "icloud",
          expectedSchemaHash: "abc123",
          failIfUnavailable: true,
        },
      },
    });

    await client.sync.start();
    const mutation = await client.mutate({
      resource: "tasks",
      version: 1,
      operation: "merge",
      id: "task:1",
      record: { completed: true },
    });
    const batch = await client.query([
      { resource: "tasks", version: 1 },
      { resource: "tasks", version: 1 },
    ]);

    await expect(
      client.query({ resource: "auditLogs", version: 1 }),
    ).rejects.toMatchObject({
      code: "DFQL_UNSUPPORTED",
      message: "Remote-only resource is unsupported in icloud mode",
      details: {
        path: "query.resource",
        resource: "auditLogs",
      },
    });

    expect(mutation).toMatchObject({
      ok: true,
      affectedIds: ["task:1"],
    });
    expect(batch).toEqual([
      {
        source: "native-icloud-runtime",
        data: [
          {
            id: "task:1",
            title: "Across devices",
            completed: true,
          },
        ],
      },
      {
        source: "native-icloud-runtime",
        data: [
          {
            id: "task:1",
            title: "Across devices",
            completed: true,
          },
        ],
      },
    ]);
    expect(await host.storage.getRecord("tasks", "task:1")).toMatchObject({
      id: "task:1",
      completed: true,
    });
    expect(await host.storage.changelogList()).toHaveLength(1);
    expect(host.syncCalls).toEqual(
      expect.arrayContaining(["sync.start", "sync.schedulePush"]),
    );
    expect(host.remoteCalls).toEqual(["remote.query"]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(schedulePushSpy).not.toHaveBeenCalled();

    await client.destroy();
  });
});
