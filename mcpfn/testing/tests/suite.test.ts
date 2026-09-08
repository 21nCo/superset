import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { customTarget } from "@mcpfn/client";
import { McpFnRegistry, createMcpFnServer, structuredResult } from "@mcpfn/core";

import { catalogHash, runMcpFnClientProfileContract, runMcpFnTargetSuite } from "../src/index.js";

describe("McpFn target suite", () => {
  it("records effective profile catalogs, fixtures, portability, and stale snapshots", async () => {
    const target = () => customTarget({
      kind: "profile-fixture",
      open: async () => {
        const server = createMcpFnServer({
          info: { name: "profile-contract", version: "1.0.0" },
          registry: new McpFnRegistry().register({
            name: "echo",
            description: "Echo safely.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
            handler: async (input) => structuredResult(input),
          }),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { transport: clientTransport, close: () => server.close() };
      },
    });
    const expected = catalogHash([{
      name: "echo",
      description: "Echo safely.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    }]);
    const report = await runMcpFnClientProfileContract([
      {
        id: "generic/v1",
        target,
        expectedCatalogHash: expected,
        fixtures: [{ id: "echo-minimal", tool: "echo", arguments: { value: "secret-not-reported" } }],
      },
      { id: "stale/v1", target, expectedCatalogHash: "sha256:stale" },
    ]);
    expect(report.ok).toBe(false);
    expect(report.profiles[0]).toMatchObject({ ok: true, toolNames: ["echo"], fixtures: [{ ok: true }] });
    expect(JSON.stringify(report)).not.toContain("secret-not-reported");
    expect(report.profiles[1].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "catalog-snapshot-mismatch" }),
    ]));
  });
  it("uses one target/session engine for external-shaped and in-memory targets", async () => {
    const server = createMcpFnServer({
      info: { name: "suite-target", version: "1.0.0" },
      registry: new McpFnRegistry().register({
        name: "echo",
        description: "Echo an input in the shared suite.",
        inputSchema: { type: "object" },
        handler: async (input) => structuredResult(input),
      }),
    });
    const report = await runMcpFnTargetSuite({
      target: customTarget({
        kind: "fixture",
        descriptor: {
          mode: "external-shaped",
          url: "https://target.example/mcp?api_key=secret#access_token=token",
        },
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      manifest: server.manifest(),
      scenarios: [{
        name: "echo",
        tool: "echo",
        arguments: { value: "ok" },
        expect: { structuredContent: { value: "ok" } },
      }],
    });
    expect(report).toMatchObject({
      ok: true,
      target: { kind: "fixture", mode: "external-shaped" },
      manifestChecked: true,
      total: 1,
      passed: 1,
    });
    expect(JSON.stringify(report.target)).not.toContain("secret");
    expect(JSON.stringify(report.target)).not.toContain("access_token=token");
    expect(JSON.stringify(report.target)).toContain("REDACTED");
    expect(report.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "transport-close", outcome: "succeeded" }),
    ]));
  });

  it("rejects an invalid report cap before opening the target", async () => {
    const open = vi.fn();
    await expect(runMcpFnTargetSuite({
      target: customTarget({ kind: "never-opened", open }),
      maxReportBytes: 1,
    })).rejects.toThrow(/at least 1024/);
    expect(open).not.toHaveBeenCalled();
  });

  it("marks target reports incomplete when observed events exceed the scenario cap", async () => {
    let server: ReturnType<typeof createMcpFnServer>;
    server = createMcpFnServer({
      info: { name: "event-heavy-target", version: "1.0.0" },
      additionalCapabilities: { logging: {} },
      registry: new McpFnRegistry().register({
        name: "notify",
        description: "Emit enough notifications to exercise the event cap.",
        inputSchema: { type: "object" },
        handler: async () => {
          for (let index = 0; index < 5; index += 1) {
            await server.sendLoggingMessage({ level: "info", data: { index } });
          }
          return structuredResult({ ok: true });
        },
      }),
    });

    const report = await runMcpFnTargetSuite({
      target: customTarget({
        kind: "fixture",
        open: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          return { transport: clientTransport, close: () => server.close() };
        },
      }),
      scenarios: [
        { name: "notify", tool: "notify" },
        {
          name: "drain notifications",
          kind: "auth.assert",
          phase: "drain",
          expect: { outcome: "allowed" },
        },
      ],
      scenarioRun: {
        maxObservedEvents: 2,
        auth: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { outcome: "allowed" };
        },
      },
    });

    expect(report).toMatchObject({
      ok: false,
      status: "incomplete",
      droppedObservedEvents: 3,
      incompleteReason: "Observed client events exceeded maxObservedEvents",
      results: [
        { status: "passed", droppedObservedEvents: 3 },
        { status: "passed" },
      ],
    });
  });
});
