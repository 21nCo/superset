import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { runAuthenticatedOfficialConformance } from "../src/conformance.js";

it("scrubs opaque credentials from runner output and never inherits authenticated stdio", async () => {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.write('{"echo":"opaque-runner-value"}'); child.stderr.write("failure opaque-runner-value"); child.emit("close", 1); });
    return child;
  });
  const result = await runAuthenticatedOfficialConformance({ url: "http://127.0.0.1:1/mcp", headers: { "x-api-key": "opaque-runner-value" }, stdio: "inherit" });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("opaque-runner-value");
  expect(result.stdout).toContain("[REDACTED]");
  expect(spawn.mock.calls[0][2].stdio).toBe("pipe");
});
