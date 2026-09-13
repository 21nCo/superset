# uifn

`uifn` is the clean-room UI primitive and component system for Superfunctions. Its stable architecture is one private behavior runtime, one public controller contract, one owned DOM layer, thin framework-native adapters, framework-isolated styled packages, and a deterministic package/source delivery pipeline.

## Stable package graph

| Package | Layer | Current role |
| --- | --- | --- |
| `@uifn/core` | core | Framework-agnostic controllers and pure logic |
| `@uifn/dom` | DOM | Owned browser-service boundary |
| `@uifn/adapter-kit` | adapters | Shared binding and conformance contract |
| `@uifn/react` | adapters | React headless package |
| `@uifn/svelte` | adapters | Svelte headless package |
| `@uifn/solid` | adapters | Solid headless package |
| `@uifn/tokens` | styling | Semantic token contracts |
| `@uifn/theme` | styling | Theme contracts and mounting |
| `@uifn/recipes` | styling | Framework-neutral part recipes |
| `@uifn/theme-tailwind` | styling | Generated Tailwind integration |
| `@uifn/components` | styled-neutral | Framework-neutral contracts, CSS, recipes, and metadata |
| `@uifn/components-react` | styled adapter | React styled-package boundary |
| `@uifn/components-svelte` | styled adapter | Svelte styled-package boundary |
| `@uifn/components-solid` | styled adapter | Solid styled-package boundary |
| `@uifn/registry` | delivery | Source installation, locks, diff, update, versioned presets, and Create CLI |
| `@uifn/storybook` | workshop | Storybook integration and documentation tooling |

The authoritative machine-readable DAG is `uifn/package-graph.json`. React, Svelte, and Solid are equal stable targets. Stable packages cannot depend on examples, product demos, or experimental products.

The private `@uifn/create` editor is a client of the same preset contract. Run `npm --workspace @uifn/create run dev` for the schema-driven configurator.

## Experimental products

`@uifn/patterns` and `@uifn/sf` are independently versioned experimental products. They publish under the `experimental` dist-tag, have separate gates and changelogs, and cannot block, enter, or be bundled into the stable release lane.

## Verification

Run package-surface checks from the repository root:

```bash
npm run verify:uifn-package-graph
npm run verify:uifn-stable
npm run verify:uifn-lanes
```

`verify:uifn-stable` covers only the stable lane. Run `npm run verify:uifn-phase-01` for the isolated proof that the stable lane executes with the experimental workspaces absent. `verify:uifn-lanes` always reports experimental results separately. The full 1.0 release remains fail-closed until the architecture, behavior, accessibility, compatibility, performance, security, and release gates are complete.

Private React, Svelte, and Solid Workbench apps live under `uifn/examples`. Integrated pattern and Superfunction panels are experimental-demo surfaces and are excluded from the stable package result.

## Versioning

Breaking cleanup is authorized before 1.0; legacy compatibility scaffolding is removed instead of preserved. After 1.0, stable public packages follow semantic versioning. Source-installed consumers use `uifn diff` and `uifn update` to review local changes.
