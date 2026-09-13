# clifn

Reusable CLI primitives for Superfunctions packages and downstream CLIs.

`clifn` remains a single package at `clifn/core`, published as `@clifn/core`. It is the shared parser-agnostic CLI toolkit for generic concerns that repeat across Superfunctions CLIs, while each owning CLI keeps its product-specific command graph and behavior.

Current public subpaths:

- `@clifn/core/credentials`
- `@clifn/core/config`
- `@clifn/core/client`
- `@clifn/core/ui`
- `@clifn/core/stdio`
- `@clifn/core/prompt`

New additive subpaths are exported for the generic CLI-builder surface:

- `@clifn/core/output`
- `@clifn/core/runner`
- `@clifn/core/config-loader`
- `@clifn/core/env`
- `@clifn/core/diagnostics`
- `@clifn/core/exec`
- `@clifn/core/scaffold`

## Install

```bash
npm install @clifn/core
```

## Conduct CLI-style usage

```ts
import { createCredentialStore } from "@clifn/core/credentials";
import { createProjectConfig } from "@clifn/core/config";
import { createApiClient } from "@clifn/core/client";
import { readJsonStdin, writeJsonStdout } from "@clifn/core/stdio";
import { ui } from "@clifn/core/ui";

const credentials = createCredentialStore();
const config = createProjectConfig();
const profile = String(config.get("profile") ?? "default");

const api = createApiClient({
  credentials,
  profile,
  projectId: String(config.get("projectId") ?? ""),
});

const input = await readJsonStdin<{ command: string }>();
ui.info(`running command: ${input.command}`);
const result = await api.post("/runs", input);
writeJsonStdout(result.data);
```

## Generic CLI usage

```ts
import { prompt } from "@clifn/core/prompt";
import { ui } from "@clifn/core/ui";

const target = await prompt.select("Target environment", [
  "local",
  "staging",
  "production",
]);
const confirmed = await prompt.confirm(`Deploy to ${target}?`);

if (!confirmed) {
  ui.warn("deployment cancelled");
} else {
  ui.success(`deployment started for ${target}`);
}
```

## Shared CLI-builder quick start

```ts
import { runAction } from "@clifn/core/runner";

const exitCode = await runAction(
  async ({ name }, ctx) => {
    ctx.output.info(`hello ${name}`);
  },
  { name: "world" },
  {
    verbose: false,
  }
);

process.exitCode = exitCode;
```

## Parser compatibility patterns

`clifn` stays parser-agnostic. The owning CLI keeps parser choice and parser dependencies, while `clifn` supplies the reusable execution and output primitives underneath.

The current repository already uses all three parser styles:

- `hostfn/cli`, `plugfn/cli`, and `extfn/cli` use `commander`
- `apifn/cli` uses `cac`
- `datafn/cli` uses raw `node:util.parseArgs`

The parser canaries under `clifn/core/tests/fixtures/*` prove that `runAction()` and the shared output service work in each style without adding parser libraries to `clifn` runtime dependencies.

### `commander`

```ts
import { Command } from "commander";
import { runAction } from "@clifn/core/runner";

const program = new Command();

program.option("--json", "Emit machine-readable output");
program
  .command("greet")
  .option("--name <name>", "Name to greet", "world")
  .action(async (options, command) => {
    const globals = command.parent?.opts() ?? {};

    return runAction(
      async ({ name }, ctx) => {
        ctx.output.info(`hello ${name}`);
      },
      { name: options.name },
      {
        mode: globals.json ? "json" : "text",
      }
    );
  });
```

### `cac`

```ts
import { cac } from "cac";
import { runAction } from "@clifn/core/runner";

const cli = cac("demo");

cli.option("--json", "Emit machine-readable output");
cli
  .command("greet")
  .option("--name <name>", "Name to greet")
  .action((options) =>
    runAction(
      async ({ name }, ctx) => {
        return {
          data: {
            ok: true,
            name,
          },
        };
      },
      { name: options.name ?? "world" },
      {
        mode: options.json ? "json" : "text",
      }
    )
  );
```

### `node:util.parseArgs`

```ts
import { parseArgs } from "node:util";
import { runAction } from "@clifn/core/runner";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    json: { type: "boolean" },
  },
});

if (positionals[0] === "greet") {
  await runAction(
    async ({ name }, ctx) => {
      ctx.output.info(`hello ${name}`);
    },
    { name: values.name ?? "world" },
    {
      mode: values.json ? "json" : "text",
    }
  );
}
```

Consumer ownership stays explicit:

- `clifn` owns the parser-agnostic runner/output/diagnostics/config/env/exec/scaffold helpers
- the consuming CLI owns command registration, parser wiring, and parser package installation
- parser libraries such as `commander` and `cac` remain consumer dependencies or test-only canary dependencies, not `clifn` runtime dependencies

## API Overview

### Compatibility promise

- Existing imports for `@clifn/core/credentials`, `@clifn/core/config`, `@clifn/core/client`, `@clifn/core/ui`, `@clifn/core/stdio`, and `@clifn/core/prompt` remain valid.
- The new subpaths are additive and do not replace any existing import path.
- `@clifn/core/ui` remains the compatibility-facing terminal helper path even as newer shared output primitives land in `@clifn/core/output`.

### `@clifn/core/credentials`

- `createCredentialStore(path?)` -> INI profile store.
- `MissingProfileError` -> typed error when profile is not found.

### `@clifn/core/config`

- `createProjectConfig(path?)` -> JSON project config store.
- `InvalidConfigError` -> typed error for invalid JSON/object shapes.

### `@clifn/core/client`

- `createApiClient(config)` -> authenticated HTTP client with retries.
- `HttpFailureError` -> typed error for non-2xx responses.
- `HttpRequestError` -> typed error for network/transport failures.

### `@clifn/core/ui`

- `ui.success`, `ui.error`, `ui.warn`, `ui.info`
- `ui.spinner(message)` -> start/stop/succeed/fail
- `ui.table(rows)` -> deterministic table output

### `@clifn/core/stdio`

- `readJsonStdin<T>()` -> parse one JSON document from stdin.
- `writeJsonStdout(value)` -> serialize one JSON document + trailing newline.
- `InvalidJsonStdinError` -> typed deterministic parse failure.

### `@clifn/core/prompt`

- `prompt.select`
- `prompt.multiSelect`
- `prompt.text`
- `prompt.confirm`

### New shared CLI-builder modules

These module entrypoints are the generic surface that repository CLIs can share:

- `@clifn/core/output`
  - generic text/JSON output service contract
  - quiet/verbose behavior
  - deterministic table rendering
  - spinner surface
- `@clifn/core/runner`
  - parser-agnostic action runner contract
  - normalized action context with output, diagnostics, exec, scaffold, cwd, env, and non-interactive state
- `@clifn/core/config-loader`
  - shared config discovery and typed loading contract for TS/JS/MJS/CJS/JSON configs
  - uses the same Jiti-informed `.ts` loading path already established in `packages/cli` and `apifn/cli`
- `@clifn/core/env`
  - generic environment readers for strings, integers, and booleans
  - explicit missing, invalid, and out-of-range error codes for shared CLI callers
- `@clifn/core/diagnostics`
  - shared diagnostic model plus deterministic sort/redaction/formatting surface
- `@clifn/core/exec`
  - subprocess execution contract for buffered capture, streaming, and timeout reporting
- `@clifn/core/scaffold`
  - deterministic file and directory scaffolding contract with explicit overwrite policy

## Adoption boundary

`clifn` is the shared home for generic CLI-builder concerns that appear across existing repository CLIs such as:

- `packages/cli` and `apifn/cli` for config loading patterns
- `hostfn/cli`, `plugfn/cli`, and `apifn/cli` for output and command-runner patterns
- `plugfn/cli` and `mcpfn/cli` for structured diagnostics and test/reporting surfaces

Responsibilities that belong in `clifn`:

- generic action execution
- generic output formatting and machine-readable output
- config discovery/loading contracts
- generic env readers
- generic diagnostics formatting
- generic subprocess helpers
- generic scaffolding helpers

Responsibilities that stay in the owning CLI:

- product-specific command graphs
- business/domain validation
- domain-specific scan rules
- deployment or packaging rules tied to one product
- browser-extension orchestration and manifest-aware behavior

## Representative adoption notes

### `packages/cli`

- Repeated pattern today:
  - config discovery and loading in `packages/cli/src/utils/load-library-config.ts`
  - config-path fallback logic in `packages/cli/src/utils/config.ts`
- `clifn` adoption target:
  - `@clifn/core/config-loader` for deterministic TS/JS/MJS/CJS/JSON loading
- Product-owned concerns that stay local:
  - schema and library semantics specific to `@superfunctions/cli`

### `apifn/cli`

- Repeated pattern today:
  - `cac` command registration in `apifn/cli/src/index.ts`
  - config loading in `apifn/cli/src/config.ts`
  - output helpers in `apifn/cli/src/utils/output.ts`
- `clifn` adoption target:
  - keep `cac`, but move generic concerns onto `@clifn/core/runner`, `@clifn/core/output`, and `@clifn/core/config-loader`
- Product-owned concerns that stay local:
  - OpenAPI generation, diff semantics, mock/serve behavior, and collection rules

### `hostfn/cli`

- Repeated pattern today:
  - `commander` command registration and repeated async `try/catch` wrappers in `hostfn/cli/src/index.ts`
  - logger formatting in `hostfn/cli/src/utils/logger.ts`
- `clifn` adoption target:
  - keep `commander`, but move shared action execution and output concerns onto `@clifn/core/runner`, `@clifn/core/output`, and `@clifn/core/exec`
- Product-owned concerns that stay local:
  - deployment workflows, SSH/server orchestration, runtime adapters, and host-specific validation

### `plugfn/cli`

- Repeated pattern today:
  - text/json rendering in `plugfn/cli/src/commands/runtime.ts`
  - structured diagnostics in `plugfn/cli/src/commands/test.ts`
- `clifn` adoption target:
  - `@clifn/core/output` for generic mode switching and transport
  - `@clifn/core/diagnostics` for stable diagnostic formatting
  - keep domain-specific formatters local where they encode provider/runtime semantics
- Product-owned concerns that stay local:
  - provider diagnostics, webhook fixtures, and integration-specific data shapes

### extfn adoption contract

`extfn/cli` is an explicit future adopter of the generic `clifn` surface, but only for generic CLI concerns.

`extfn/cli` SHOULD use:

- `@clifn/core/runner` for normalized action execution and exit handling
- `@clifn/core/output` for text/json output, quiet/verbose behavior, and spinner usage
- `@clifn/core/diagnostics` for stable formatting and redaction of generic diagnostics
- `@clifn/core/config-loader` for extension config discovery and loading
- `@clifn/core/env` for generic env parsing
- `@clifn/core/exec` for subprocess orchestration during builds and packaging
- `@clifn/core/scaffold` for template-free deterministic file creation

`extfn/cli` MAY keep:

- its preferred parser (`commander`, `cac`, or raw `parseArgs`)
- product-specific formatter helpers that encode extension semantics

`extfn/cli` MUST stay extfn-owned for:

- Vite-based extension orchestration
- browser launching behavior
- extension packaging rules and archive layout
- manifest-aware scan rules
- plugin-specific contracts such as extension plugin wiring
- target-specific extension validation

If `extfn/cli` needs a generic capability that is not yet exported by `clifn`, that capability should be added to `clifn` first instead of being reimplemented as extfn-local CLI infrastructure.

## Notes

- Package path follows repo convention: `clifn/core` workspace, package name `@clifn/core`.
- `clifn` is designed for public imports only; no private/internal path imports are required.
- The generic modules prefer repository-shared mechanisms, including the existing `packages/cli` loader pattern, before introducing new runtime dependencies.
- `@clifn/core/config-loader` rejects remote config URLs and unsupported extensions with explicit error codes.
- `@clifn/core/env` uses explicit `CLIFN_ENV_*` error codes for missing, invalid, and out-of-range values.

## Conduct v0.3 compatibility note

`clifn` intentionally exposes stable subpath imports for Conduct and other CLIs:

- `@clifn/core/credentials`
- `@clifn/core/config`
- `@clifn/core/client`
- `@clifn/core/ui`
- `@clifn/core/stdio`
- `@clifn/core/prompt`

Use these public subpaths directly; do not import from internal `dist/*` paths.
