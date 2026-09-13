export interface GitHubApiOptions { owner: string; repository: string; token: string; baseUrl?: string; fetch?: typeof fetch }

export class GitHubApi {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  public constructor(private readonly options: GitHubApiOptions) {
    if (!/^[A-Za-z0-9_.-]+$/.test(options.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error("Invalid GitHub repository identity.");
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  public async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    if (!endpoint.startsWith("/") || endpoint.includes("..")) throw new Error("Unsafe GitHub endpoint.");
    const response = await this.fetcher(`${this.baseUrl}${endpoint}`, {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "reviewfn/0.1", "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${endpoint} failed with ${response.status}.`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  public endpoint(path: string): string { return `/repos/${this.options.owner}/${this.options.repository}${path}`; }
}
