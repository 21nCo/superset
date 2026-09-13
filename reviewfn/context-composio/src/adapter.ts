import { spawn } from "node:child_process";

import { sha256, type ContextAdapter, type ContextManifest, type ContextRequest, type ContextSource, type PreflightResult } from "@superfunctions/reviewfn-core";

export interface ComposioCommandResult { code: number | null; stdout: string; stderr: string }
export type ComposioRunner = (args: string[], signal?: AbortSignal) => Promise<ComposioCommandResult>;

const defaultRunner: ComposioRunner = async (args, signal) => new Promise((resolve, reject) => {
  const child = spawn("composio", args, { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.once("error", reject);
  child.once("exit", (code) => { signal?.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
});

export interface ComposioContextOptions { runner?: ComposioRunner }

export class ComposioLinearContextAdapter implements ContextAdapter {
  public readonly id = "composio-linear";
  private readonly runner: ComposioRunner;
  public constructor(options: ComposioContextOptions = {}) { this.runner = options.runner ?? defaultRunner; }

  public async preflight(request: ContextRequest): Promise<PreflightResult> {
    const diagnostics: PreflightResult["diagnostics"] = [];
    if (!request.issue) diagnostics.push({ code: "REVIEWFN_LINEAR_ISSUE_REQUIRED", level: "error", message: "A Linear issue identifier is required." });
    if (!request.account) diagnostics.push({ code: "REVIEWFN_COMPOSIO_ACCOUNT_REQUIRED", level: "error", message: "An explicit Composio connected-account alias or ID is required." });
    if (!request.expectedWorkspace) diagnostics.push({ code: "REVIEWFN_LINEAR_WORKSPACE_REQUIRED", level: "error", message: "expectedWorkspace is required to prevent cross-workspace reads." });
    const version = await this.runner(["--version"], request.signal).catch((error) => ({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    if (version.code !== 0) diagnostics.push({ code: "REVIEWFN_COMPOSIO_UNAVAILABLE", level: "error", message: `Composio CLI is unavailable: ${version.stderr.trim() || `exit ${String(version.code)}`}.` });
    return { ok: diagnostics.every((item) => item.level !== "error"), resolved: diagnostics.some((item) => item.level === "error") ? undefined : { provider: "composio", model: "none", auth: "connected-account", harnessVersion: version.stdout.trim() || "unknown" }, diagnostics };
  }

  public async fetch(request: ContextRequest): Promise<Omit<ContextManifest, "digest">> {
    if (!request.issue || !request.account || !request.expectedWorkspace) throw new Error("issue, account, and expectedWorkspace are required.");
    const payload = await this.execute("LINEAR_GET_LINEAR_ISSUE", { issue_id: request.issue }, request.account, request.signal);
    const issue = findIssue(payload);
    if (!issue) throw new Error(`Composio returned no accessible Linear issue for ${request.issue}.`);
    const workspaceCandidates = collectWorkspaceCandidates(issue);
    if (!workspaceCandidates.some((candidate) => candidate.toLowerCase() === request.expectedWorkspace!.toLowerCase())) {
      throw new Error(`Linear workspace mismatch: expected ${request.expectedWorkspace}; received ${workspaceCandidates.length ? workspaceCandidates.join(", ") : "no workspace identity"}.`);
    }

    const sources: ContextSource[] = [];
    const incompleteReasons: string[] = [];
    let consumed = 0;
    const add = (source: Omit<ContextSource, "digest">) => {
      if (sources.length >= request.limits.maxSources) { incompleteReasons.push(`Linear source limit ${request.limits.maxSources} reached.`); return false; }
      const original = source.content ?? "";
      const remaining = request.limits.maxBytes - consumed;
      if (remaining <= 0) { incompleteReasons.push(`Linear byte limit ${request.limits.maxBytes} reached.`); return false; }
      const content = Buffer.byteLength(original) <= remaining ? original : Buffer.from(original).subarray(0, remaining).toString("utf8");
      const status = content === original ? source.status : "truncated";
      sources.push({ ...source, status, content, digest: sha256(content) });
      consumed += Buffer.byteLength(content);
      if (status === "truncated") incompleteReasons.push(`${source.id} was truncated by the context byte limit.`);
      return status !== "truncated";
    };
    const issueId = stringField(issue, "id") ?? request.issue;
    const issueIdentifier = stringField(issue, "identifier") ?? request.issue;
    add({ id: `linear:issue:${issueId}`, type: "issue", canonicalUrl: stringField(issue, "url"), workspace: request.expectedWorkspace, retrievedAt: new Date().toISOString(), updatedAt: stringField(issue, "updatedAt"), providerVersion: "LINEAR_GET_LINEAR_ISSUE", status: "available", content: JSON.stringify(issueWithoutConnections(issue), null, 2) });

    const comments = [...connectionNodes(issue.comments)];
    let commentPage = pageInfo(issue.comments);
    const commentCursors = new Set<string>();
    while (commentPage.hasNextPage && commentPage.endCursor && !commentCursors.has(commentPage.endCursor) && comments.length < request.limits.maxSources) {
      commentCursors.add(commentPage.endCursor);
      const page = await this.fetchIssueConnection("comments", issueId, commentPage.endCursor, request.account, request.signal);
      const connection = findConnection(page, "comments");
      comments.push(...connectionNodes(connection));
      commentPage = pageInfo(connection);
    }
    for (const comment of comments) {
      const id = stringField(comment, "id") ?? sha256(JSON.stringify(comment)).slice(0, 16);
      if (!add({ id: `linear:comment:${id}`, type: "comment", workspace: request.expectedWorkspace, retrievedAt: new Date().toISOString(), updatedAt: stringField(comment, "updatedAt"), providerVersion: "LINEAR_GET_LINEAR_ISSUE", status: "available", parentId: `linear:issue:${issueId}`, content: stringField(comment, "body") ?? JSON.stringify(comment, null, 2) })) break;
    }
    if (commentPage.hasNextPage) incompleteReasons.push(`Linear comments for ${issueIdentifier} remain incomplete at cursor ${commentPage.endCursor ?? "unknown"}.`);

    const documents = [...connectionNodes(issue.documents), ...arrayObjects(issue.documents)];
    let documentPage = pageInfo(issue.documents);
    const documentCursors = new Set<string>();
    while (documentPage.hasNextPage && documentPage.endCursor && !documentCursors.has(documentPage.endCursor) && documents.length < request.limits.maxSources) {
      documentCursors.add(documentPage.endCursor);
      const page = await this.fetchIssueConnection("documents", issueId, documentPage.endCursor, request.account, request.signal);
      const connection = findConnection(page, "documents");
      documents.push(...connectionNodes(connection));
      documentPage = pageInfo(connection);
    }
    if (documentPage.hasNextPage) incompleteReasons.push(`Linear documents for ${issueIdentifier} remain incomplete at cursor ${documentPage.endCursor ?? "unknown"}.`);
    const seenDocuments = new Set<string>();
    for (const summary of documents) {
      const id = stringField(summary, "id");
      if (!id || seenDocuments.has(id)) continue;
      seenDocuments.add(id);
      let document = summary;
      if (!stringField(summary, "content")) {
        try { document = findDocument(await this.fetchDocument(id, request.account, request.signal)) ?? summary; }
        catch (error) {
          sources.push({ id: `linear:document:${id}`, type: "document", canonicalUrl: stringField(summary, "url"), workspace: request.expectedWorkspace, retrievedAt: new Date().toISOString(), digest: sha256(""), status: "failed", parentId: `linear:issue:${issueId}`, error: error instanceof Error ? error.message : String(error) });
          incompleteReasons.push(`Unable to fetch Linear document ${id}.`);
          continue;
        }
      }
      const content = stringField(document, "content");
      if (!content) {
        sources.push({ id: `linear:document:${id}`, type: "document", canonicalUrl: stringField(document, "url"), workspace: request.expectedWorkspace, retrievedAt: new Date().toISOString(), digest: sha256(""), status: "unsupported", parentId: `linear:issue:${issueId}`, error: "Document content was not returned." });
        incompleteReasons.push(`Linear document ${id} did not include content.`);
      } else add({ id: `linear:document:${id}`, type: "document", canonicalUrl: stringField(document, "url"), workspace: request.expectedWorkspace, retrievedAt: new Date().toISOString(), updatedAt: stringField(document, "updatedAt"), providerVersion: "LINEAR_RUN_QUERY_OR_MUTATION", status: "available", parentId: `linear:issue:${issueId}`, content });
    }
    return { version: 1, sources, selection: { candidates: [request.issue], selected: [`linear:issue:${issueId}`], rule: `explicit issue ${request.issue} using explicit Composio account ${request.account}` }, limits: request.limits, incompleteReasons };
  }

  private async execute(slug: string, data: Record<string, unknown>, account: string, signal?: AbortSignal): Promise<unknown> {
    const result = await this.runner(["execute", slug, "--account", account, "-d", JSON.stringify(data)], signal);
    if (result.code !== 0) throw new Error(`${slug} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
    try { return JSON.parse(result.stdout); }
    catch (error) { throw new Error(`${slug} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private fetchDocument(id: string, account: string, signal?: AbortSignal): Promise<unknown> {
    const query = "query($id: String!) { document(id: $id) { id title content url updatedAt } }";
    return this.execute("LINEAR_RUN_QUERY_OR_MUTATION", { query_or_mutation: query, variables: { id } }, account, signal);
  }

  private fetchIssueConnection(connection: "comments" | "documents", issueId: string, after: string, account: string, signal?: AbortSignal): Promise<unknown> {
    const fields = connection === "comments" ? "id body createdAt updatedAt user { id name }" : "id title content url updatedAt";
    const query = `query($issueId: String!, $after: String) { issue(id: $issueId) { ${connection}(first: 50, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } } }`;
    return this.execute("LINEAR_RUN_QUERY_OR_MUTATION", { query_or_mutation: query, variables: { issueId, after } }, account, signal);
  }
}

function records(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) { for (const item of value) records(item, output); return output; }
  const record = value as Record<string, unknown>;
  output.push(record);
  for (const item of Object.values(record)) records(item, output);
  return output;
}

function findIssue(value: unknown): Record<string, unknown> | undefined {
  return records(value).find((record) => typeof record.identifier === "string" && typeof record.title === "string") ?? records(value).find((record) => typeof record.title === "string" && typeof record.description === "string" && typeof record.id === "string");
}

function findDocument(value: unknown): Record<string, unknown> | undefined {
  return records(value).find((record) => typeof record.id === "string" && typeof record.content === "string" && typeof record.title === "string");
}

function findConnection(value: unknown, name: "comments" | "documents"): unknown {
  return records(value).map((record) => record[name]).find((candidate) => candidate && typeof candidate === "object");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined { return typeof record[key] === "string" ? record[key] as string : undefined; }
function arrayObjects(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function connectionNodes(value: unknown): Record<string, unknown>[] { return value && typeof value === "object" ? arrayObjects((value as Record<string, unknown>).nodes) : []; }
function pageInfo(value: unknown): { hasNextPage: boolean; endCursor?: string } {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>).pageInfo : undefined;
  if (!candidate || typeof candidate !== "object") return { hasNextPage: false };
  const info = candidate as Record<string, unknown>;
  return { hasNextPage: info.hasNextPage === true, endCursor: typeof info.endCursor === "string" ? info.endCursor : undefined };
}

function collectWorkspaceCandidates(issue: Record<string, unknown>): string[] {
  const result = new Set<string>();
  for (const record of records(issue)) {
    for (const key of ["workspace", "workspaceId", "organization", "organizationId"]) {
      const value = record[key];
      if (typeof value === "string") result.add(value);
      else if (value && typeof value === "object" && !Array.isArray(value)) for (const field of ["id", "key", "name", "slugId"]) { const candidate = (value as Record<string, unknown>)[field]; if (typeof candidate === "string") result.add(candidate); }
    }
  }
  const team = issue.team;
  if (team && typeof team === "object" && !Array.isArray(team)) for (const field of ["id", "key", "name"]) { const candidate = (team as Record<string, unknown>)[field]; if (typeof candidate === "string") result.add(candidate); }
  return [...result];
}

function issueWithoutConnections(issue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(issue).filter(([key]) => !["comments", "documents", "attachments"].includes(key)));
}
