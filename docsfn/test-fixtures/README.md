# docsfn test fixtures

This folder is the canonical fixture corpus for docsfn migration, release-gate coverage, and package-contract verification.

## Package contract baseline

- Core package publish name: `@docsfn/core`
- React peers: `react` and `react-dom` support `^18.3.0 || ^19.0.0`
- Next peer: `next` support is explicitly `^15.0.0`
- Svelte peer: `svelte` support is `>=5.20.0 <6`
- SvelteKit peer: `@sveltejs/kit` support is explicitly `^2.0.0`

## Fixture inventory

- `repo/datafn-docs`: canonical snapshot of `datafn/docs`
- `repo/searchfn-docs`: canonical snapshot of `searchfn/docs`

Parity targets used by `docsfn/scripts/migration-check.mjs`:

- `datafn-docs` routes include `/docs` and `/docs/documentation/server/routes`
- `searchfn-docs` routes include `/docs` and `/docs/reference/client`
- sidebar top-level labels match fixture snapshots for both sites
- compatibility checks require `meta.json` control files and Mermaid fences
- `datafn-docs` additionally requires Tabs/Tab compatibility syntax presence

The snapshots intentionally exclude generated and machine-local artifacts:

- `node_modules/`
- `.next/`
- `.turbo/`
- `.vercel/`
- `dist/`
- `.DS_Store`

## Refresh policy

Refresh fixtures only when source docs content or wiring changes and before release-gate updates.
Use these commands from repository root:

```bash
mkdir -p docsfn/test-fixtures/repo/datafn-docs docsfn/test-fixtures/repo/searchfn-docs
rsync -a --delete --exclude node_modules --exclude .next --exclude .turbo --exclude .vercel --exclude dist --exclude .DS_Store datafn/docs/ docsfn/test-fixtures/repo/datafn-docs/
rsync -a --delete --exclude node_modules --exclude .next --exclude .turbo --exclude .vercel --exclude dist --exclude .DS_Store searchfn/docs/ docsfn/test-fixtures/repo/searchfn-docs/
```

Do not hand-edit copied fixture content except for explicit test-only fixture additions documented in phase reports.

## Validation commands

Run these from repository root after fixture refresh:

```bash
npm ci
node docsfn/scripts/migration-check.mjs
node docsfn/scripts/release-gate.mjs
```
