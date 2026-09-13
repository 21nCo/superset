# DATA-6 PR 153 retrospective baseline

This is the first frozen historical smoke case for ReviewFn's normalized evaluation schema. It is deliberately a manual adjudication, not a live-model score.

## Snapshot

- PR: `https://github.com/21nCo/super-functions/pull/153`
- base and merge base: `e1b6a55209191fdc909c4e633982657b21096e9a`
- head: `4efa97a895556b745ea679250c0f77a9d432b04e`
- full-index binary diff SHA-256: `dda4484c5e49e162e651d142ad7e9b9ba6c4f5c7a56feec36fb7a8fdb84b4765`
- current Linear issue plus two linked documents SHA-256: `7aecfeb09d558b64fbb258076cd5072dd4aa149bdee3013f895c6ba6f503a24f`

## Adjudication

The exact head exposes versioned parsed request types and public parser/extractor functions in `datafn/core/src/protocol.ts:14-133,158-168,566-673`, re-exports them from core and server, and uses the parsed representation in server authorization preflight at `datafn/server/src/server.ts:1311-1318`.

The structural-only, operation coverage, normalization, version failure and exhaustiveness boundaries are exercised in `datafn/core/__tests__/resource-selectors.test.ts:73-433`. Authorization integration is exercised in `datafn/server/src/__tests__/resource-selectors-preflight.test.ts:9-112`. Security integration guidance and single/batched examples are in `datafn/docs/content/docs/documentation/security/resource-selectors.mdx:8-125`.

Focused verification on Node 22 after building declared workspace dependencies:

- core typecheck: passed;
- structural selector unit suite: 67 passed;
- server typecheck: passed;
- server preflight integration suite: 7 passed.

The first script-free server attempt could not resolve unbuilt workspace packages. That was setup noise; rebuilding `@datafn/core`, `@superfunctions/observability`, `@superfunctions/db`, and `@superfunctions/http` made both the test and typecheck pass.

One completion gap remains: the architecture document requires a downstream Skillplane test with no local selector traversal, but the exact 28-file PR change set contains no Skillplane migration or cross-repository receipt. The case is therefore adjudicated non-acceptable and blocked on `DATA6-DOWNSTREAM-MIGRATION`.

## Limitations

Linear does not expose a contemporaneous issue/document version through the available connector, so this uses the current source snapshot and is marked retrospective. No downstream Skillplane code was inspected. With one hand-adjudicated case, all aggregate percentages are smoke signals only and are not release-quality model estimates.
