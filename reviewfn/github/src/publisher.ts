import { sha256, type PreflightResult, type PublishRequest, type PublishResult, type ReportPublisher } from "@superfunctions/reviewfn-core";

import { GitHubApi } from "./api.js";

interface PullRequestResponse { head: { sha: string } }
interface Comment { id: number; body?: string }
interface CommentPage extends Array<Comment> {}
interface CheckRun { id: number; external_id?: string }
interface CheckRunsResponse { check_runs: CheckRun[] }

export interface GitHubPublisherOptions {
  api: GitHubApi;
  pullRequest: number;
}

export class GitHubAdvisoryPublisher implements ReportPublisher {
  public readonly id = "github";
  public constructor(private readonly options: GitHubPublisherOptions) {}

  public async preflight(): Promise<PreflightResult> {
    return { ok: Number.isInteger(this.options.pullRequest) && this.options.pullRequest > 0, diagnostics: Number.isInteger(this.options.pullRequest) && this.options.pullRequest > 0 ? [] : [{ code: "REVIEWFN_GITHUB_PR_INVALID", level: "error", message: "A positive pull request number is required." }] };
  }

  public async currentHead(): Promise<string> {
    const pull = await this.options.api.request<PullRequestResponse>("GET", this.options.api.endpoint(`/pulls/${this.options.pullRequest}`));
    return pull.head.sha;
  }

  public async publish(request: PublishRequest): Promise<PublishResult> {
    const current = await this.currentHead();
    if (current !== request.expectedHead) return { status: "stale", error: `PR head is ${current}, not reviewed head ${request.expectedHead}.` };
    const marker = `<!-- reviewfn:${request.profile} -->`;
    const runMarker = `<!-- reviewfn-run:${request.report.runId} -->`;
    const body = `${marker}\n${runMarker}\n${request.rendered}`;
    const comments = await this.listComments();
    const existing = comments.find((comment) => comment.body?.includes(marker));
    let status: PublishResult["status"];
    let reference: string;
    if (existing?.body?.includes(runMarker) && sha256(existing.body) === sha256(body)) {
      status = "unchanged";
      reference = `comment:${existing.id}`;
    } else if (existing) {
      await this.options.api.request("PATCH", this.options.api.endpoint(`/issues/comments/${existing.id}`), { body });
      status = "updated";
      reference = `comment:${existing.id}`;
    } else {
      const created = await this.options.api.request<Comment>("POST", this.options.api.endpoint(`/issues/${this.options.pullRequest}/comments`), { body });
      status = "published";
      reference = `comment:${created.id}`;
    }
    await this.publishCheck(request);
    return { status, reference };
  }

  private async listComments(): Promise<Comment[]> {
    const comments: Comment[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.options.api.request<CommentPage>("GET", this.options.api.endpoint(`/issues/${this.options.pullRequest}/comments?per_page=100&page=${page}`));
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
    throw new Error("GitHub comment pagination exceeded 10,000 comments.");
  }

  private async publishCheck(request: PublishRequest): Promise<void> {
    const conclusion = "neutral";
    const externalId = `${request.profile}:${request.report.runId}`;
    const existing = await this.options.api.request<CheckRunsResponse>("GET", this.options.api.endpoint(`/commits/${request.expectedHead}/check-runs?check_name=${encodeURIComponent(`ReviewFn / ${request.profile}`)}`));
    const prior = existing.check_runs.find((run) => run.external_id === externalId);
    const body = {
      name: `ReviewFn / ${request.profile}`,
      head_sha: request.expectedHead,
      external_id: externalId,
      status: "completed",
      conclusion,
      output: { title: `ReviewFn: ${request.report.verdict ?? "incomplete"}`, summary: request.rendered.slice(0, 65_000) },
    };
    await this.options.api.request(prior ? "PATCH" : "POST", this.options.api.endpoint(prior ? `/check-runs/${prior.id}` : "/check-runs"), body);
  }
}
