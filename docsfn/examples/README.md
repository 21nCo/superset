# docsfn examples

Reference example sites used by the release gate.

## Included apps

- `next-docs-site` - Next 15 + React 18/19
- `sveltekit-docs-site` - SvelteKit 2 + Svelte 5 (>=5.20.0)

Both examples load canonical fixtures through `DOCSFN_FIXTURE_ROOT`.

## Canonical proof-route inventory

The release gate and `migration-check.mjs` treat these as the phase-00 proof-route contract. The ids are fixed and sorted to keep the inventory deterministic.

| Proof id | App | Surface | Route pattern | Route files |
| --- | --- | --- | --- | --- |
| `next-api` | `next-docs-site` | `api` | `/docs/api/{...slug}` | `app/docs/[[...slug]]/page.tsx` |
| `next-blog` | `next-docs-site` | `blog` | `/blog/{...slug}` | `app/blog/[...slug]/page.tsx` |
| `next-docs` | `next-docs-site` | `docs` | `/docs/{...slug}` | `app/docs/[[...slug]]/page.tsx` |
| `next-embedded` | `next-docs-site` | `embedded` | `/embedded/{...slug}` | `app/embedded/[[...slug]]/page.tsx` |
| `sveltekit-api` | `sveltekit-docs-site` | `api` | `/docs/api/{...slug}` | `src/routes/docs/[...slug]/+page.ts`, `src/routes/docs/[...slug]/+page.svelte` |
| `sveltekit-blog` | `sveltekit-docs-site` | `blog` | `/blog/{...slug}` | `src/routes/blog/[...slug]/+page.server.ts`, `src/routes/blog/[...slug]/+page.svelte` |
| `sveltekit-docs` | `sveltekit-docs-site` | `docs` | `/docs/{...slug}` | `src/routes/docs/[...slug]/+page.ts`, `src/routes/docs/[...slug]/+page.svelte` |
| `sveltekit-embedded` | `sveltekit-docs-site` | `embedded` | `/embedded/{...slug}` | `src/routes/embedded/[...slug]/+page.ts`, `src/routes/embedded/[...slug]/+page.svelte` |

The machine-readable copy lives in `docsfn/examples/proof-routes.json`.

## Build matrix (from repo root)

```bash
# Next example against both canonical fixtures
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/next-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/next-docs-site run build

# SvelteKit example against both canonical fixtures
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
```

## Local migration smoke check

Run the contract checks from the repo root:

```bash
npm ci
node docsfn/scripts/release-preflight.mjs
node docsfn/scripts/docs-contract-check.mjs
node docsfn/scripts/release-gate.mjs
node docsfn/scripts/migration-check.mjs
```
