import { describe, expect, it } from "vitest";
import { ComposioLinearContextAdapter, type ComposioRunner } from "../src/index.js";

const request = { root: ".", issue: "ENG-1", account: "work", expectedWorkspace: "workspace-1", limits: { maxSources: 20, maxBytes: 100_000, maxDepth: 3 } };

describe("ComposioLinearContextAdapter", () => {
  it("requires explicit account and workspace", async () => {
    const adapter = new ComposioLinearContextAdapter({ runner: async () => ({ code: 0, stdout: "0.4.1", stderr: "" }) });
    const result = await adapter.preflight({ ...request, account: undefined, expectedWorkspace: undefined });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("REVIEWFN_COMPOSIO_ACCOUNT_REQUIRED");
  });
  it("captures issue comments and attached document content", async () => {
    const runner: ComposioRunner = async (args) => {
      if (args[0] === "--version") return { code: 0, stdout: "0.4.1", stderr: "" };
      const slug = args[1];
      if (slug === "LINEAR_GET_LINEAR_ISSUE") return { code: 0, stderr: "", stdout: JSON.stringify({ data: { issue: { id: "i1", identifier: "ENG-1", title: "Feature", description: "Do it", url: "https://linear.app/x/ENG-1", organization: { id: "workspace-1", name: "Acme" }, comments: { nodes: [{ id: "c1", body: "clarify" }], pageInfo: { hasNextPage: false } }, documents: { nodes: [{ id: "d1", title: "Design" }], pageInfo: { hasNextPage: false } } } } }) };
      return { code: 0, stderr: "", stdout: JSON.stringify({ data: { document: { id: "d1", title: "Design", content: "architecture" } } }) };
    };
    const result = await new ComposioLinearContextAdapter({ runner }).fetch(request);
    expect(result.sources.map((source) => source.type)).toEqual(["issue", "comment", "document"]);
    expect(result.incompleteReasons).toEqual([]);
  });
  it("rejects the wrong workspace instead of returning empty context", async () => {
    const runner: ComposioRunner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ issue: { id: "i", identifier: "ENG-1", title: "x", description: "x", organization: { id: "other" } } }) });
    await expect(new ComposioLinearContextAdapter({ runner }).fetch(request)).rejects.toThrow(/workspace mismatch/);
  });
  it("records inaccessible document content as incomplete", async () => {
    const runner: ComposioRunner = async (args) => args[1] === "LINEAR_GET_LINEAR_ISSUE"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ issue: { id: "i", identifier: "ENG-1", title: "x", description: "x", organization: { id: "workspace-1" }, documents: { nodes: [{ id: "d" }] } } }) }
      : { code: 1, stdout: "", stderr: "permission denied" };
    const result = await new ComposioLinearContextAdapter({ runner }).fetch(request);
    expect(result.sources.some((source) => source.type === "document" && source.status === "failed")).toBe(true);
    expect(result.incompleteReasons).toHaveLength(1);
  });
  it("follows comment and document cursors before declaring context complete", async () => {
    const calls: Array<{ slug: string; data: Record<string, unknown> }> = [];
    const runner: ComposioRunner = async (args) => {
      const slug = args[1];
      const data = JSON.parse(args[args.indexOf("-d") + 1]) as Record<string, unknown>;
      calls.push({ slug, data });
      if (slug === "LINEAR_GET_LINEAR_ISSUE") return { code: 0, stderr: "", stdout: JSON.stringify({ issue: { id: "i", identifier: "ENG-1", title: "x", description: "x", organization: { id: "workspace-1" }, comments: { nodes: [{ id: "c1", body: "first" }], pageInfo: { hasNextPage: true, endCursor: "comments-next" } }, documents: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "documents-next" } } } }) };
      const variables = data.variables as { after?: string; id?: string };
      if (variables.after === "comments-next") return { code: 0, stderr: "", stdout: JSON.stringify({ data: { issue: { comments: { nodes: [{ id: "c2", body: "second" }], pageInfo: { hasNextPage: false } } } } }) };
      if (variables.after === "documents-next") return { code: 0, stderr: "", stdout: JSON.stringify({ data: { issue: { documents: { nodes: [{ id: "d1", title: "Design", content: "full design" }], pageInfo: { hasNextPage: false } } } } }) };
      throw new Error(`unexpected call ${JSON.stringify({ slug, data })}`);
    };
    const result = await new ComposioLinearContextAdapter({ runner }).fetch(request);
    expect(result.sources.filter((source) => source.type === "comment")).toHaveLength(2);
    expect(result.sources.find((source) => source.type === "document")?.content).toBe("full design");
    expect(result.incompleteReasons).toEqual([]);
    expect(calls.filter((call) => call.slug === "LINEAR_RUN_QUERY_OR_MUTATION")).toHaveLength(2);
  });
});
