import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("@mcpfn/inspector", () => ({ McpFnInspector: { create: ({ target }: any) => {
  let handle: any;
  return { connect: async () => { handle = await target.open({ requestId: "inspect-test", diagnostic: async () => {} }); },
    snapshot: async () => ({ tools: [{ description: "opaque-inspect-value" }] }), close: async () => handle?.close() };
} } }));
import { runCli } from "../src/index.js";

it("scrubs acquired credentials from inspect stdout and its output file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcpfn-inspect-"));
  vi.stubEnv("MCPFN_INSPECT_TEST_TOKEN", "opaque-inspect-value");
  let stdout = "", stderr = "";
  try {
    const code = await runCli(["inspect", "http://127.0.0.1:1/mcp", "--api-key-env", "MCPFN_INSPECT_TEST_TOKEN", "--output", "snapshot.json"], {
      cwd: root, stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    });
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain("opaque-inspect-value");
    expect(await readFile(path.join(root, "snapshot.json"), "utf8")).toBe(stdout);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
