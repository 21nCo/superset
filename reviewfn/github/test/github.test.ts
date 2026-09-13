import { describe, expect, it } from "vitest";
import type { ReviewReport } from "@superfunctions/reviewfn-core";
import { GitHubAdvisoryPublisher, GitHubApi, GitSourceControlAdapter } from "../src/index.js";

function report(): ReviewReport {
  return { schemaVersion: 1, runId: "run1", attemptId: "attempt", createdAt: "2026-01-01T00:00:00Z", change: { repositoryId: "repo", host: "github.com", pullRequest: 1, targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "d".repeat(64), changedPaths: [], capturedAt: "2026-01-01T00:00:00Z" }, contextManifestDigest: "c".repeat(64), contextManifestArtifact: `context-manifest-${"c".repeat(64)}`, configuration: { schemaVersion: 1, policyDigest: "p", promptDigest: "q", harness: { id: "codex", version: "1" }, inference: { provider: "openai", model: "model", auth: "api-key" }, execution: { adapter: "isolated", timeoutMs: 1, maxOutputBytes: 1 }, contextAdapters: [], profile: "requirements" }, execution: "completed", coverage: "complete", coverageReasons: [], verdict: "ready", requirements: [], assessments: [], evidence: [], findings: [], tests: [], inspectedPaths: [], uninspected: [], limitations: [] };
}

describe("GitSourceControlAdapter", () => {
  it("captures immutable base/head/merge-base and full diff", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") return args[2].startsWith("base") ? "a".repeat(40) : "b".repeat(40);
      if (args[0] === "config") return "https://github.com/acme/repo.git";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "b".repeat(40);
      if (args[0] === "merge-base") return "a".repeat(40);
      if (args[0] === "diff" && args.includes("--name-only")) return "src/a.ts\0src/b.ts\0";
      if (args[0] === "diff") return "patch";
      if (args[0] === "rev-parse") return "main";
      return "";
    };
    const snapshot = await new GitSourceControlAdapter({ runner }).capture(".", "base", "head", 7);
    expect(snapshot.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(snapshot.host).toBe("github.com");
    expect(calls.some((args) => args.includes("--binary") && args.includes("--full-index"))).toBe(true);
  });
  it("rejects escaping code anchors", async () => expect(await new GitSourceControlAdapter({ runner: async () => "" }).verifyAnchor(".", { commit: "a".repeat(40), path: "../secret" })).toBe(false));
});

describe("GitHubAdvisoryPublisher", () => {
  it("maintains one summary and one check for repeated delivery", async () => {
    let comment: { id: number; body: string } | undefined;
    let check: { id: number; external_id: string } | undefined;
    const calls: Array<{ method: string; url: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); const method = init?.method ?? "GET"; calls.push({ method, url });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (url.includes("/pulls/1")) return json({ head: { sha: "b".repeat(40) } });
      if (url.includes("/issues/1/comments") && method === "GET") return json(comment ? [comment] : []);
      if (url.includes("/issues/1/comments") && method === "POST") { comment = { id: 9, body: JSON.parse(String(init?.body)).body }; return json(comment, 201); }
      if (url.includes("/issues/comments/9") && method === "PATCH") { comment = { id: 9, body: JSON.parse(String(init?.body)).body }; return json(comment); }
      if (url.includes("/commits/") && url.includes("/check-runs")) return json({ check_runs: check ? [check] : [] });
      if (url.endsWith("/check-runs") && method === "POST") { check = { id: 4, external_id: JSON.parse(String(init?.body)).external_id }; return json(check, 201); }
      if (url.endsWith("/check-runs/4") && method === "PATCH") return json(check);
      return json({ error: "unexpected" }, 500);
    };
    const publisher = new GitHubAdvisoryPublisher({ api: new GitHubApi({ owner: "acme", repository: "repo", token: "secret", fetch: fetcher }), pullRequest: 1 });
    const request = { report: report(), rendered: "report", expectedHead: "b".repeat(40), profile: "requirements" };
    expect((await publisher.publish(request)).status).toBe("published");
    expect((await publisher.publish(request)).status).toBe("unchanged");
    expect(calls.filter((call) => call.method === "POST" && call.url.includes("/issues/1/comments"))).toHaveLength(1);
    expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/check-runs"))).toHaveLength(1);
  });
  it("refuses stale publication before reading comments", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ head: { sha: "c".repeat(40) } }), { status: 200 });
    const publisher = new GitHubAdvisoryPublisher({ api: new GitHubApi({ owner: "acme", repository: "repo", token: "secret", fetch: fetcher }), pullRequest: 1 });
    expect((await publisher.publish({ report: report(), rendered: "x", expectedHead: "b".repeat(40), profile: "requirements" })).status).toBe("stale");
  });
});
