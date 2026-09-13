# GitHub Action setup

The Action runs on `pull_request` opened, synchronize and reopened events or an explicitly authorized dispatch. Checkout the exact PR head with full history and `persist-credentials: false`. Pin the Action and CLI versions.

The bundled composite Action accepts only a credential-isolating Responses API proxy URL. The trusted base configuration must select `action-proxy` auth. It never accepts or exports a raw OpenAI key, and the harness subprocess receives no GitHub token. Provision the proxy outside the untrusted review job; the official `openai/codex-action@v1` is the reference proxy implementation. Raw API-key mode is limited to local reviews without a pull-request identity and fails closed for PR runs.

Public forks do not receive secrets; an unauthenticated run is incomplete and non-passing. A privileged rerun requires explicit maintainer authorization and an isolated runner.

Use `contents: read` while acquiring context, reviewing and testing. Give `pull-requests: write`, `issues: write` and `checks: write` only to the publication step/job. ReviewFn maintains one summary per profile and rechecks the remote head before publication.

The initial result is advisory. Its GitHub check is neutral even when the report verdict is ready. Do not make it a required merge gate until an adjudicated held-out evaluation establishes acceptable precision/recall and a separate policy authorizes exact check-conclusion mapping.

Generated artifacts should upload `report.json`, `report.md`, normalized events and the context manifest. Retention follows policy; transcripts are private/opt-in and redacted.
