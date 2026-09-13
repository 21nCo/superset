import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/bus.js";
import { MemoryStorageAdapter } from "../../adapters/memoryStorage.js";
import { SyncEngine } from "../engine.js";

const schema: any = {
  resources: [
    {
      name: "goal",
      version: 1,
      idPrefix: "goal:",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "label", type: "string", required: false },
        { name: "type", type: "string", required: true },
        { name: "status", type: "string", required: true },
        { name: "parentId", type: "string", required: false },
        { name: "parentPath", type: "string", required: false },
        { name: "sortOrder", type: "number", required: false },
      ],
    },
    {
      name: "combination",
      version: 1,
      idPrefix: "combination:",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "label", type: "string", required: false },
        { name: "type", type: "string", required: true },
        { name: "items", type: "array", required: true, default: [] },
      ],
    },
  ],
  relations: [
    {
      from: "goal",
      to: "goal",
      type: "htree",
      relation: "children",
      inverse: "parent",
      fkField: "parentId",
      pathField: "parentPath",
    },
  ],
};

describe("SyncEngine push", () => {
  it("pushes contiguous changelog batches with their original client id", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorageAdapter(["goal"]);
      await storage.changelogAppend({
        clientId: "client:old",
        mutationId: "mut:old",
        timestampMs: 1,
        mutation: {
          resource: "goal",
          version: 1,
          operation: "insert",
          id: "goal:old",
          record: {
            id: "goal:old",
            type: "INDEFINITE",
            status: "NOT_STARTED",
          },
          clientId: "client:old",
          mutationId: "mut:old",
        },
      });
      await storage.changelogAppend({
        clientId: "client:new",
        mutationId: "mut:new",
        timestampMs: 2,
        mutation: {
          resource: "goal",
          version: 1,
          operation: "insert",
          id: "goal:new",
          record: {
            id: "goal:new",
            type: "INDEFINITE",
            status: "NOT_STARTED",
          },
          clientId: "client:new",
          mutationId: "mut:new",
        },
      });

      const push = vi.fn().mockResolvedValue({
        ok: true,
        result: {
          ok: true,
          applied: ["mut"],
          cursor: "1",
          cursorBefore: "0",
        },
      });
      const remote: any = {
        push,
        pull: vi.fn(),
        clone: vi.fn(),
        query: vi.fn(),
        mutation: vi.fn(),
        transact: vi.fn(),
        seed: vi.fn(),
        reconcile: vi.fn(),
      };

      const engine = new SyncEngine(
        storage,
        remote,
        new EventBus(),
        "client:new",
        schema,
        { pushMaxRetries: 0 },
      );

      await engine.processPush();

      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0][0].clientId).toBe("client:old");
      expect(push.mock.calls[0][0].mutations).toHaveLength(1);
      expect(push.mock.calls[0][0].mutations[0].mutationId).toBe("mut:old");
      expect(
        (await storage.changelogList()).map((entry) => entry.mutationId),
      ).toEqual(["mut:new"]);

      await engine.processPush();

      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1][0].clientId).toBe("client:new");
      expect(push.mock.calls[1][0].mutations).toHaveLength(1);
      expect(push.mock.calls[1][0].mutations[0].mutationId).toBe("mut:new");
      expect(await storage.changelogList()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reruns push when requested while a push is in flight", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorageAdapter(["goal"]);
      await storage.changelogAppend({
        clientId: "client:1",
        mutationId: "mut:1",
        timestampMs: 1,
        mutation: {
          resource: "goal",
          version: 1,
          operation: "insert",
          id: "goal:1",
          record: {
            id: "goal:1",
            type: "INDEFINITE",
            status: "NOT_STARTED",
          },
          clientId: "client:1",
          mutationId: "mut:1",
        },
      });

      let resolveFirstPush:
        | ((value: {
            ok: boolean;
            result: {
              ok: boolean;
              applied: string[];
              cursor: string;
              cursorBefore: string;
            };
          }) => void)
        | undefined;
      const push = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstPush = resolve as typeof resolveFirstPush;
            }),
        )
        .mockResolvedValue({
          ok: true,
          result: {
            ok: true,
            applied: ["mut:2"],
            cursor: "2",
            cursorBefore: "1",
          },
        });
      const remote: any = {
        push,
        pull: vi.fn(),
        clone: vi.fn(),
        query: vi.fn(),
        mutation: vi.fn(),
        transact: vi.fn(),
        seed: vi.fn(),
        reconcile: vi.fn(),
      };

      const engine = new SyncEngine(
        storage,
        remote,
        new EventBus(),
        "client:1",
        schema,
        { pushMaxRetries: 0 },
      );

      const firstRun = engine.processPush();
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));

      await storage.changelogAppend({
        clientId: "client:1",
        mutationId: "mut:2",
        timestampMs: 2,
        mutation: {
          resource: "goal",
          version: 1,
          operation: "insert",
          id: "goal:2",
          record: {
            id: "goal:2",
            type: "INDEFINITE",
            status: "NOT_STARTED",
          },
          clientId: "client:1",
          mutationId: "mut:2",
        },
      });

      await engine.processPush();
      resolveFirstPush?.({
        ok: true,
        result: {
          ok: true,
          applied: ["mut:1"],
          cursor: "1",
          cursorBefore: "0",
        },
      });
      await firstRun;
      await vi.runOnlyPendingTimersAsync();

      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1][0].mutations).toHaveLength(1);
      expect(push.mock.calls[1][0].mutations[0].mutationId).toBe("mut:2");
      expect(await storage.changelogList()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acks terminal failed push mutations and later applied mutations", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:terminal",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "unrelate",
        id: "goal:1",
        relations: { children: ["goal:missing"] },
        clientId: "client:1",
        mutationId: "mut:terminal",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:applied",
      timestampMs: 2,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:applied",
        record: {
          id: "goal:applied",
          type: "INDEFINITE",
          status: "NOT_STARTED",
        },
        clientId: "client:1",
        mutationId: "mut:applied",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid relation target",
        details: { path: "relations.children" },
      },
      result: {
        ok: false,
        applied: ["mut:applied"],
        errors: [
          {
            mutationId: "mut:terminal",
            code: "DFQL_INVALID",
            message: "Invalid relation target",
            path: "relations.children",
            retryable: false,
          },
        ],
        cursor: "2",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("resends compacted writes when the replacing delete is rejected", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:merge",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "merge",
        id: "goal:missing",
        record: { label: "recoverable write" },
        clientId: "client:1",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:delete",
      timestampMs: 2,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "delete",
        id: "goal:missing",
        clientId: "client:1",
      },
    });

    const failedDelete = {
      ok: false,
      error: {
        code: "RELATION_RESTRICTED",
        message: "Delete restricted",
      },
      result: {
        ok: false,
        applied: [] as string[],
        errors: [{
          mutationId: "mut:delete",
          code: "RELATION_RESTRICTED",
          message: "Delete restricted",
          path: "operation",
          retryable: false,
        }],
        cursor: "0",
        cursorBefore: "0",
      },
    };
    const push = vi.fn()
      .mockResolvedValueOnce(failedDelete)
      .mockResolvedValueOnce({
        ...failedDelete,
        result: {
          ...failedDelete.result,
          applied: ["mut:merge"],
        },
      });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };
    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][0].mutations.map((item: any) => item.mutationId))
      .toEqual(["mut:delete"]);
    expect(push.mock.calls[1][0].mutations.map((item: any) => item.mutationId))
      .toEqual(["mut:merge", "mut:delete"]);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("does not replay a compacted write after its replacing delete applied", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    for (const [seq, mutation] of [
      [1, {
        resource: "goal",
        version: 1,
        operation: "merge",
        id: "goal:deleted",
        record: { label: "must stay deleted" },
        clientId: "client:1",
        mutationId: "mut:merge-deleted",
      }],
      [2, {
        resource: "goal",
        version: 1,
        operation: "delete",
        id: "goal:deleted",
        clientId: "client:1",
        mutationId: "mut:delete-applied",
      }],
      [3, {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:unrelated",
        record: { type: "INDEFINITE", status: "NOT_STARTED" },
        clientId: "client:1",
        mutationId: "mut:unrelated-terminal",
      }],
    ] as const) {
      await storage.changelogAppend({
        clientId: "client:1",
        mutationId: mutation.mutationId,
        timestampMs: seq,
        mutation,
      });
    }
    const push = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "DFQL_INVALID", message: "Unrelated failure" },
      result: {
        ok: false,
        applied: ["mut:delete-applied"],
        errors: [{
          mutationId: "mut:unrelated-terminal",
          code: "DFQL_INVALID",
          message: "Unrelated failure",
          path: "mutations[mut:unrelated-terminal]",
          retryable: false,
        }],
        cursor: "1",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };
    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].mutations.map((item: any) => item.mutationId))
      .toEqual(["mut:delete-applied", "mut:unrelated-terminal"]);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("does not replay a write when any of multiple replacing deletes applied", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    const mutations = [
      {
        resource: "goal", version: 1, operation: "merge",
        id: "goal:x", record: { label: "must stay deleted" },
        clientId: "client:1", mutationId: "mut:merge-x",
      },
      {
        resource: "goal", version: 1, operation: "delete",
        id: "goal:x", clientId: "client:1", mutationId: "mut:delete-x-1",
      },
      {
        resource: "goal", version: 1, operation: "delete",
        id: "goal:x", clientId: "client:1", mutationId: "mut:delete-x-2",
      },
      {
        resource: "goal", version: 1, operation: "merge",
        id: "goal:y", record: { label: "retry independently" },
        clientId: "client:1", mutationId: "mut:merge-y",
      },
      {
        resource: "goal", version: 1, operation: "delete",
        id: "goal:y", clientId: "client:1", mutationId: "mut:delete-y",
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      await storage.changelogAppend({
        clientId: "client:1",
        mutationId: mutation.mutationId,
        timestampMs: index + 1,
        mutation,
      });
    }
    const failedResult = {
      ok: false,
      error: { code: "MUTATION_FAILED", message: "Retryable deletes" },
      result: {
        ok: false,
        applied: ["mut:delete-x-1"],
        errors: [
          {
            mutationId: "mut:delete-x-2", code: "MUTATION_FAILED",
            message: "Retry delete x", path: "mutations[mut:delete-x-2]",
            retryable: true,
          },
          {
            mutationId: "mut:delete-y", code: "MUTATION_FAILED",
            message: "Retry delete y", path: "mutations[mut:delete-y]",
            retryable: false,
          },
        ],
        cursor: "1",
        cursorBefore: "0",
      },
    };
    const push = vi.fn()
      .mockResolvedValueOnce(failedResult)
      .mockResolvedValueOnce(failedResult);
    const remote: any = {
      push,
      pull: vi.fn(), clone: vi.fn(), query: vi.fn(), mutation: vi.fn(),
      transact: vi.fn(), seed: vi.fn(), reconcile: vi.fn(),
    };
    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls[0][0].mutations.map((item: any) => item.mutationId))
      .toEqual(["mut:delete-x-1", "mut:delete-x-2", "mut:delete-y"]);
    expect(push.mock.calls[1][0].mutations.map((item: any) => item.mutationId))
      .toEqual([
        "mut:delete-x-1",
        "mut:delete-x-2",
        "mut:merge-y",
        "mut:delete-y",
      ]);
    expect(push.mock.calls[1][0].mutations.map((item: any) => item.mutationId))
      .not.toContain("mut:merge-x");
  });

  it("keeps retryable failed push mutations queued", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:retryable",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:retryable",
        record: {
          id: "goal:retryable",
          type: "INDEFINITE",
          status: "NOT_STARTED",
        },
        clientId: "client:1",
        mutationId: "mut:retryable",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "MUTATION_FAILED",
        message: "Mutation failed",
        details: { path: "mutations[mut:retryable]" },
      },
      result: {
        ok: false,
        applied: [],
        errors: [
          {
            mutationId: "mut:retryable",
            code: "MUTATION_FAILED",
            message: "Mutation failed",
            path: "mutations[mut:retryable]",
            retryable: true,
          },
        ],
        cursor: "0",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(
      (await storage.changelogList()).map((entry) => entry.mutationId),
    ).toEqual(["mut:retryable"]);
  });

  it("acks only the contiguous terminal and applied prefix before a retryable failure", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:terminal",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "unrelate",
        id: "goal:1",
        relations: { children: ["goal:missing"] },
        clientId: "client:1",
        mutationId: "mut:terminal",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:applied-before-retryable",
      timestampMs: 2,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:applied-before-retryable",
        record: {
          id: "goal:applied-before-retryable",
          type: "INDEFINITE",
          status: "NOT_STARTED",
        },
        clientId: "client:1",
        mutationId: "mut:applied-before-retryable",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:retryable",
      timestampMs: 3,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:retryable",
        record: {
          id: "goal:retryable",
          type: "INDEFINITE",
          status: "NOT_STARTED",
        },
        clientId: "client:1",
        mutationId: "mut:retryable",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:applied-after-retryable",
      timestampMs: 4,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:applied-after-retryable",
        record: {
          id: "goal:applied-after-retryable",
          type: "INDEFINITE",
          status: "NOT_STARTED",
        },
        clientId: "client:1",
        mutationId: "mut:applied-after-retryable",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "MUTATION_FAILED",
        message: "Mutation failed",
        details: { path: "mutations[mut:retryable]" },
      },
      result: {
        ok: false,
        applied: [
          "mut:applied-before-retryable",
          "mut:applied-after-retryable",
        ],
        errors: [
          {
            mutationId: "mut:terminal",
            code: "DFQL_INVALID",
            message: "Invalid relation target",
            path: "relations.children",
            retryable: false,
          },
          {
            mutationId: "mut:retryable",
            code: "MUTATION_FAILED",
            message: "Mutation failed",
            path: "mutations[mut:retryable]",
            retryable: true,
          },
        ],
        cursor: "4",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(
      (await storage.changelogList()).map((entry) => entry.mutationId),
    ).toEqual(["mut:retryable", "mut:applied-after-retryable"]);
  });

  it("drops stale record mutations when the local record is deleted before push", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:merge",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "merge",
        id: "goal:deleted-before-push",
        record: {
          id: "goal:deleted-before-push",
          label: "stale",
        },
        clientId: "client:1",
        mutationId: "mut:merge",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:delete",
      timestampMs: 2,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "delete",
        id: "goal:deleted-before-push",
        clientId: "client:1",
        mutationId: "mut:delete",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        applied: ["mut:delete"],
        cursor: "1",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].mutations).toEqual([
      expect.objectContaining({
        operation: "delete",
        id: "goal:deleted-before-push",
        mutationId: "mut:delete",
      }),
    ]);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("resends and acks a compacted mutation before a retryable delete failure", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:stale-merge",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "merge",
        id: "goal:deleted-before-push",
        record: { label: "stale" },
        clientId: "client:1",
        mutationId: "mut:stale-merge",
      },
    });
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:retry-delete",
      timestampMs: 2,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "delete",
        id: "goal:deleted-before-push",
        clientId: "client:1",
        mutationId: "mut:retry-delete",
      },
    });

    const firstFailure = {
      ok: true,
      error: { code: "MUTATION_FAILED", message: "retry", details: {} },
      result: {
        ok: false,
        applied: [],
        errors: [{
          mutationId: "mut:retry-delete",
          code: "MUTATION_FAILED",
          message: "retry",
          path: "mutations[mut:retry-delete]",
          retryable: true,
        }],
        cursor: "0",
        cursorBefore: "0",
      },
    };
    const push = vi.fn()
      .mockResolvedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        ...firstFailure,
        result: {
          ...firstFailure.result,
          applied: ["mut:stale-merge"],
        },
      });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };
    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push.mock.calls[0][0].mutations).toEqual([
      expect.objectContaining({ mutationId: "mut:retry-delete" }),
    ]);
    expect(push.mock.calls[1][0].mutations).toEqual([
      expect.objectContaining({ mutationId: "mut:stale-merge" }),
      expect.objectContaining({ mutationId: "mut:retry-delete" }),
    ]);
    expect(
      (await storage.changelogList()).map((entry) => entry.mutationId),
    ).toEqual(["mut:retry-delete"]);
  });

  it("sanitizes stale changelog record fields against the current schema before push", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:1",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "insert",
        id: "goal:1",
        record: {
          id: "goal:1",
          label: "old",
          type: "INDEFINITE",
          status: "NOT_STARTED",
          parent: 0,
          parentId: "goal:parent",
          parentPath: "goal:root",
        },
        clientId: "client:1",
        mutationId: "mut:1",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        applied: ["mut:1"],
        cursor: "1",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    const payload = push.mock.calls[0][0];
    expect(payload.mutations[0].record.parent).toBeUndefined();
    expect(payload.mutations[0].record.parentId).toBe("goal:parent");
    expect(payload.mutations[0].record.parentPath).toBe("goal:root");
    expect(await storage.changelogList()).toEqual([]);
  });

  it("sanitizes stale relation metadata against the current schema before push", async () => {
    const storage = new MemoryStorageAdapter(["goal"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:1",
      timestampMs: 1,
      mutation: {
        resource: "goal",
        version: 1,
        operation: "relate",
        id: "goal:1",
        relations: {
          children: [{ $ref: "goal:child", sortOrder: 0 }],
        },
        clientId: "client:1",
        mutationId: "mut:1",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        applied: ["mut:1"],
        cursor: "1",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    const payload = push.mock.calls[0][0];
    expect(payload.mutations[0].relations.children).toEqual([
      { $ref: "goal:child" },
    ]);
    expect(await storage.changelogList()).toEqual([]);
  });

  it("applies schema defaults to stale insert records before push", async () => {
    const storage = new MemoryStorageAdapter(["combination"]);
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mut:1",
      timestampMs: 1,
      mutation: {
        resource: "combination",
        version: 1,
        operation: "insert",
        id: "combination:1",
        record: {
          id: "combination:1",
          label: "space",
          type: "NOTEBOOK",
        },
        clientId: "client:1",
        mutationId: "mut:1",
      },
    });

    const push = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        applied: ["mut:1"],
        cursor: "1",
        cursorBefore: "0",
      },
    });
    const remote: any = {
      push,
      pull: vi.fn(),
      clone: vi.fn(),
      query: vi.fn(),
      mutation: vi.fn(),
      transact: vi.fn(),
      seed: vi.fn(),
      reconcile: vi.fn(),
    };

    const engine = new SyncEngine(
      storage,
      remote,
      new EventBus(),
      "client:1",
      schema,
      { pushMaxRetries: 0 },
    );

    await engine.processPush();

    expect(push).toHaveBeenCalledTimes(1);
    const payload = push.mock.calls[0][0];
    expect(payload.mutations[0].record.items).toEqual([]);
    expect(await storage.changelogList()).toEqual([]);
  });
});

it("serializes reserved resource names as own pull cursor keys", async () => {
  const names = ["constructor", "prototype", "__proto__"];
  const engine = new SyncEngine(new MemoryStorageAdapter(), {} as any, new EventBus(), "reader", {resources: names.map(name => ({name, version: 1, fields: []}))});
  const cursors = JSON.parse(JSON.stringify(await (engine as any).buildPullCursors()));
  for (const name of names) {
    expect(Object.prototype.hasOwnProperty.call(cursors, name)).toBe(true);
    expect(cursors[name]).toBe("0");
  }
});
