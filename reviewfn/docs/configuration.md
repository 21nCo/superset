# Configuration

ReviewFn uses versioned JSON files at `.reviewfn/config.json` and `.reviewfn/policy.json`. Unknown adapters fail preflight. Secret values never belong in either file; `credentialEnv` names an environment variable without recording its value.

In GitHub Actions, pass `--trusted-config-from-base`. ReviewFn reads both files using `git show BASE:path`, so a pull request cannot weaken the policy controlling its own review.

The configuration selects the profile, harness, inference provider/model/auth, context adapters, approved argv test commands, outputs and retention. Commands are argv arrays and never pass through a shell.

`composio-linear` requires:

- `account`: explicit Composio account alias, word ID, or connected-account ID;
- `expectedWorkspace`: expected Linear organization/team identity;
- `issue`: key such as `ENG-123`.

`repository-markdown` accepts exact repository-relative paths or `**/*.md` suffix patterns. Traversal and symlink escapes are refused.

Fallback entries are provenance only. ReviewFn never selects one automatically; an operator must explicitly rerun a compatible configuration.

Version 0.1 accepts only `advisory` output mode. Both configuration and policy validation reject `gate`; required-check behavior needs a later, separately calibrated and authorized release.
