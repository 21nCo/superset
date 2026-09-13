# ReviewFn

ReviewFn is a portable, evidence-backed pull-request reviewer. It captures an immutable base/head change, freezes authoritative issue and repository context, runs approved tests in a disposable checkout, asks a compatible review harness for structured assessments, validates every source/evidence/code reference, and publishes one current-head advisory summary.

The first release is deliberately advisory. It cannot edit code, push, merge, or treat a completed model invocation as proof that the requested behavior is complete.

## Packages

| Package | Responsibility |
| --- | --- |
| `@superfunctions/reviewfn-core` | Versioned contracts, identity, policy, orchestration, validation, artifacts and rendering |
| `@superfunctions/reviewfn-cli` | Initialization, preflight, review, report rendering and evaluation commands |
| `@superfunctions/reviewfn-harness-codex` | Codex CLI capability checks, bounded execution, JSONL normalization and structured output |
| `@superfunctions/reviewfn-context-composio` | Explicit-account Linear issue/comment/document snapshots through Composio CLI |
| `@superfunctions/reviewfn-github` | Exact Git snapshots and idempotent GitHub summary/check publication |
| `@superfunctions/reviewfn-testing` | Fake adapters, deterministic fixtures, replay metrics and comparison-confound reporting |

Every package is independently installable. No package depends on another Superfunctions runtime.

## Local quick start

Requires Node.js 22 or newer, Git, and a supported Codex CLI installation.

```sh
npm install --save-dev @superfunctions/reviewfn-cli
npx reviewfn init
npx reviewfn preflight --base origin/main --head HEAD --issue ENG-123
npx reviewfn review --base origin/main --head HEAD --issue ENG-123
```

Reports are written to `.reviewfn/output/report.json` and `.reviewfn/output/report.md`; content-addressed evidence is written under `.reviewfn/artifacts`. Add those two generated directories to the consumer repository's ignore rules.

For a connection-free setup, retain only the `repository-markdown` context adapter. For Linear, add `composio-linear` with an explicit `account`, `expectedWorkspace`, and `issue`. ReviewFn never embeds a personal connected-account ID.

## Guarantees

- Run identity records base, head, merge-base, diff, context, policy, prompt, harness, model and budget provenance.
- Every requirement must resolve to exactly one assessment.
- Incomplete context, quota, timeout, malformed output, cancellation and stale heads cannot produce or publish a passing review.
- Repository tests receive no model, context, or GitHub publishing credentials.
- A PR that changes auto-loaded agent instruction/configuration paths is rejected before inference.
- GitHub publication maintains one profile summary and idempotently updates the same run's check.
- Advisory output uses a neutral GitHub check; gating remains a separately authorized, calibrated policy.

See [configuration](./docs/configuration.md), [security](./docs/security.md), [GitHub setup](./docs/github-action.md), [report contract](./docs/report-schema.md), and [evaluation](./docs/evaluation.md).
