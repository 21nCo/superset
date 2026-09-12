# ReviewFn CLI

ReviewFn freezes a Git change, extracts requirements from repository Markdown, invokes a configured structured-output harness, runs approved validation commands, validates immutable evidence, and writes an advisory JSON/Markdown report.

## Configuration

Create trusted `reviewfn.config.json` on the base branch:

```json
{
  "base": "origin/main",
  "requirementsFile": "docs/change-requirements.md",
  "policyFile": ".reviewfn/policy.md",
  "harness": {
    "command": "codex",
    "args": ["exec", "--json", "-"],
    "provider": "openai",
    "model": "configured-by-codex",
    "auth": "api-key",
    "version": "pinned-by-runner"
  },
  "tests": [{ "command": "npm", "args": ["test"] }]
}
```

Run `reviewfn doctor` and then `reviewfn review`. Reports are private (`0600`) files under `.reviewfn/` by default. The harness must accept the frozen request on stdin and return the normalized JSON object on stdout. Composio can materialize a Linear issue and its documents into the configured Markdown source before ReviewFn runs; ReviewFn itself does not require a Composio account.

To publish, add `github: { "repository": "owner/name", "pullRequest": 123 }` to the trusted configuration and invoke `reviewfn publish` in a separate job with `GITHUB_TOKEN`. Publication revalidates the report, compares its reviewed commit with the current PR head, and creates or updates one marker-keyed summary.

The included Action is advisory. Check publication, inline comments, credential brokering, and fork-safe job separation must be configured by the consuming repository; the review process itself receives no publishing capability.
