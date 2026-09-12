import { afterEach, describe, expect, it } from "vitest";
import {
  DATAFN_REQUEST_ACTIONS,
  extractStructuralResourceSelectors,
} from "@datafn/core";
import { createDatafnServer } from "../server.js";
import type { DataFnAction } from "../events.js";

describe("structural resource-selector preflight", () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0, servers.length).map((server) => server.close()));
  });

  it("keeps DataFnAction aligned with the core protocol inventory", () => {
    const actions: readonly DataFnAction[] = DATAFN_REQUEST_ACTIONS;
    expect(actions).toEqual([
      "status",
      "query",
      "mutation",
      "transact",
      "search",
      "seed",
      "clone",
      "pull",
      "push",
      "reconcile",
    ]);
  });

  it("lets authorize plugins preflight selectors without payload traversal", async () => {
    const seen: string[][] = [];
    const server = await createDatafnServer({
      schema: {
        resources: [
          {
            name: "tasks",
            version: 1,
            fields: [{ name: "title", type: "string", required: true }],
            permissions: {
              read: { fields: ["title"] },
              write: { fields: [] },
            },
          },
        ],
      },
      authorize: (_context, action, payload) => {
        const extracted = extractStructuralResourceSelectors(action, payload);
        if (!extracted.ok) return false;
        seen.push([...extracted.result.selectors]);
        return extracted.result.selectors.every((resource) => resource === "tasks");
      },
    });
    servers.push(server);

    const allowed = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "tasks",
          filters: { metadata: { resource: "secrets" } },
          record: { resources: ["billing"] },
        }),
      }),
    );
    expect(allowed.status).not.toBe(403);
    expect(seen).toEqual([["tasks"]]);

    const denied = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "billing",
          filters: { metadata: { resource: "tasks" } },
        }),
      }),
    );
    const deniedBody = (await denied.json()) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(deniedBody.ok).toBe(false);
    expect(deniedBody.error?.code).toBe("FORBIDDEN");
    expect(seen).toEqual([["tasks"], ["billing"]]);
  });
  it("rejects nested unsupported versions before HTTP or executor authorization", async () => {
    let authorized = 0;
    const server = await createDatafnServer({
      schema: { resources: [{ name: "tasks", version: 1, fields: [] }] },
      authorize: () => { authorized++; return true; },
    });
    servers.push(server);
    const payload = [{ resource: "tasks", protocolVersion: "2" }];
    const response = await server.router.handle(new Request("http://localhost/datafn/query", {
      method: "POST", body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("DATAFN_UNSUPPORTED_PROTOCOL_VERSION");
    await expect(server.executor.query(payload)).rejects.toMatchObject({ code: "DATAFN_UNSUPPORTED_PROTOCOL_VERSION" });
    expect(authorized).toBe(0);
  });

  it("derives REST selectors from the URL and accepts selector-less status", async () => {
    const server = await createDatafnServer({
      schema: { resources: [{ name: "tasks", version: 1, fields: [] }] },
      rest: true,
    });
    servers.push(server);
    const status = await server.router.handle(new Request("http://localhost/datafn/status"));
    expect(status.status).toBe(200);
    const response = await server.router.handle(new Request("http://localhost/datafn/resources/tasks"));
    // Schema authorization can deny the query; structural parsing must accept it.
    expect(((await response.json()) as { error?: { code: string } }).error?.code).not.toBe("DFQL_INVALID");
  });

  it.each(["%2e%2e%2fetc", "tasks%2Fprivate", "tasks%00"])("rejects malformed REST resource %s before authorization", async segment => {
    let authorized = 0;
    const server = await createDatafnServer({ schema: { resources: [{ name: "tasks", version: 1, fields: [] }] }, rest: true, authorize: () => { authorized++; return true; } });
    servers.push(server);
    const response = await server.router.handle(new Request(`http://localhost/datafn/resources/${segment}`));
    expect(response.status).toBe(400);
    expect(authorized).toBe(0);
  });

});
