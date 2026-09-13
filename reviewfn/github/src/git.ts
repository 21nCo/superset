import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256, type ChangeSnapshot, type CodeAnchor, type SourceControlAdapter } from "@superfunctions/reviewfn-core";

const execFileAsync = promisify(execFile);
export type GitRunner = (args: string[], cwd: string) => Promise<string>;
const defaultRunner: GitRunner = async (args, cwd) => (await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 })).stdout.trim();

export interface GitSourceOptions {
  runner?: GitRunner;
  currentPullRequestHead?: (pullRequest: number) => Promise<string>;
  host?: string;
}

export class GitSourceControlAdapter implements SourceControlAdapter {
  public readonly id = "git";
  private readonly runner: GitRunner;
  public constructor(private readonly options: GitSourceOptions = {}) { this.runner = options.runner ?? defaultRunner; }

  public async capture(root: string, base: string, head: string, pullRequest?: number): Promise<ChangeSnapshot> {
    const [baseCommit, headCommit, repositoryId, checkoutHead] = await Promise.all([
      this.runner(["rev-parse", "--verify", `${base}^{commit}`], root),
      this.runner(["rev-parse", "--verify", `${head}^{commit}`], root),
      this.runner(["config", "--get", "remote.origin.url"], root).catch(() => "local"),
      this.runner(["rev-parse", "HEAD"], root),
    ]);
    if (checkoutHead !== headCommit) throw new Error(`Review workspace is at ${checkoutHead}, but requested head is ${headCommit}. Check out the exact head in an isolated workspace.`);
    const mergeBaseCommit = await this.runner(["merge-base", baseCommit, headCommit], root);
    const [diff, names, targetBranch] = await Promise.all([
      this.runner(["diff", "--binary", "--full-index", mergeBaseCommit, headCommit], root),
      this.runner(["diff", "--name-only", "-z", mergeBaseCommit, headCommit], root),
      this.runner(["rev-parse", "--abbrev-ref", base], root).catch(() => base),
    ]);
    return {
      repositoryId,
      host: this.options.host ?? hostFromRemote(repositoryId),
      pullRequest,
      targetBranch,
      baseCommit,
      headCommit,
      mergeBaseCommit,
      diffDigest: sha256(diff),
      changedPaths: names.split("\0").filter(Boolean).sort(),
      capturedAt: new Date().toISOString(),
    };
  }

  public async currentHead(root: string, pullRequest?: number): Promise<string> {
    if (pullRequest !== undefined && this.options.currentPullRequestHead) return this.options.currentPullRequestHead(pullRequest);
    return this.runner(["rev-parse", "HEAD"], root);
  }

  public async verifyAnchor(root: string, anchor: CodeAnchor): Promise<boolean> {
    if (!anchor.path || anchor.path.startsWith("/") || anchor.path.split(/[\\/]/).includes("..")) return false;
    const content = await this.runner(["show", `${anchor.commit}:${anchor.path}`], root).catch(() => undefined);
    if (content === undefined) return false;
    const lines = content.split(/\r?\n/);
    if (anchor.startLine !== undefined && (anchor.startLine < 1 || anchor.startLine > lines.length)) return false;
    if (anchor.endLine !== undefined && (anchor.endLine < (anchor.startLine ?? 1) || anchor.endLine > lines.length)) return false;
    return true;
  }
}

function hostFromRemote(remote: string): string {
  const match = remote.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)/);
  return match?.[1] ?? "local";
}
