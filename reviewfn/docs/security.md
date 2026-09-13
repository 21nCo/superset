# Security model

Trusted components are the pinned ReviewFn installation, administrator/base-revision policy, coordinator, credential resolver and publisher. Pull-request files, branch names, descriptions, comments, retrieved documents, test output and model output are untrusted data.

The Codex adapter uses ephemeral, read-only, structured execution and ignores user configuration and exec-policy rules. If the change touches `AGENTS.md`, `.codex/`, `.agents/` or `.claude/`, ReviewFn stops before inference because those paths may be loaded as instructions by a harness. Base-revision instructions remain administrator-controlled.

Approved tests run as argv commands in a ReviewFn-owned detached worktree at the captured head. Their environment contains only basic runtime variables; model, Composio and GitHub credentials are excluded. Runtime and output are bounded, process groups are terminated on timeout/cancellation, and only the exact owned checkout is removed.

The publisher receives validated report data and a narrowly scoped token. It re-fetches the pull-request head before any write, escapes content through GitHub's JSON API, updates one marker-scoped comment, and never sends credentials to the harness or tests.

Public fork workflows must not receive repository secrets. A fork without a supported credential fails preflight rather than degrading to a passing result. Run privileged reviews only after an authorized maintainer initiates them on an isolated runner; keep checkout credentials disabled and publishing in a separate least-privilege job when adapting the workflow.

Raw API-key Codex CLI execution is supported only for trusted local workspaces without a pull-request identity. ReviewFn refuses raw-key PR inference before starting the harness. The bundled GitHub Action requires a credential-isolating proxy endpoint and never accepts an OpenAI key. In GitHub-hosted CI, use the official OpenAI Codex Action proxy pattern and its `drop-sudo` safety strategy. ChatGPT-managed authentication is limited to trusted private runners and must never copy cached auth into a public job.

Artifact IDs are content-addressed, roots and object names are validated, symlinked stores are rejected, secrets are redacted before transcript/event persistence, and expiry cleanup removes only owned artifact paths.
