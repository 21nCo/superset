# ADR-0001: first-release decisions

Status: accepted for the 0.1 advisory release, 12 September 2026.

- Distribution uses the repository's established `@superfunctions` npm scope (`@superfunctions/reviewfn-*`) and the `reviewfn` CLI binary. The proposed package names and the unscoped binary name were unregistered when checked; publishing still requires the repository owner's normal npm authorization.
- Node.js 22 is the runtime floor. It matches the maintained automation path and enables one supported runtime across the CLI, harness and isolated execution.
- Codex CLI is the first harness. It must support `exec`, JSONL, structured output, read-only sandboxing, cancellation and ephemeral execution. Pi versus OpenCode remains a measured P4 capability decision and is not required for the first advisory release.
- API-key, ChatGPT, access-token, workload-identity and Codex Action proxy auth are declared separately. Compatibility is preflighted; there is no silent provider, model, auth or sandbox fallback. Raw keys are forbidden for PR review, and the bundled Action accepts only a credential-isolating proxy URL.
- JSON report schema version 1 is the normalization boundary. Raw vendor events remain optional redacted artifacts.
- Trusted policy is loaded from the base revision in CI. Repository changes may only tighten a trusted policy.
- GitHub advisory checks conclude `neutral`, including a model verdict of `ready`. Required-check mapping is reserved for a separately calibrated gate policy.
- Configuration and policy validation reject gate mode in version 0.1 rather than exposing an unauthorized dormant switch.
- Reports default to 30-day retention; transcripts and test logs default to seven days. Operators can shorten these values.
- The first supported CI platform is GitHub Actions. The CLI remains CI-neutral.
- The code is MIT licensed, matching the repository. Package metadata and tarball contents are verified by the release gate.
