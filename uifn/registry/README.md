# @uifn/registry

The signed, offline-capable registry and transaction-safe source installer for uifn.

Status: `ga-candidate`. The stable catalog contains the 69 canonical components for React, Svelte, and Solid. Vue and Angular are intentionally unsupported.

## One delivery pipeline

Package exports and copied-source modules are generated together from the canonical uifn anatomy. A source template is byte-identical to its package source before installation. The generated catalog records the canonical version, generator version, definition hash, generator hash, template hashes, output hashes, MIT license, dependency requirements, and clean-room provenance.

The bundled catalog is verified with a detached Ed25519 signature before it is used. It does not require a registry network request, and the signing private key is never shipped in the package or repository.

## Maintainer signing

The repository contains only the pinned public key, catalog digest, and detached signature. Never place the private key in the checkout, an `.env` file, shell history, command arguments, CI logs, or a persistent temporary file.

### Interim macOS Keychain custody

Until release signing moves to shared infrastructure, the development key is held as a device-only generic-password item in the login Keychain:

- Service: `uifn-registry-signing-key`
- Account: `local-release-signer`
- Expected key ID: `af26384964522699ef39dd80`

On the authorized Mac, sign from `zsh` without materializing a PEM file:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/sign-uifn-registry.mjs \
  --private-key <(security find-generic-password \
    -a local-release-signer \
    -s uifn-registry-signing-key \
    -w 2>/dev/null | xxd -r -p)
```

The `xxd` step decodes the hexadecimal representation emitted by `security` for the multiline PEM value. Confirm that the command reports key ID `af26384964522699ef39dd80`, review both generated signature files, and run the repository-wide stable gate before committing them. A missing item, a different key ID, or a Keychain access denial is a hard failure; do not generate a replacement key merely to make verification pass.

### AWS KMS migration

Before signing becomes a team operation, replace the local key with an AWS KMS asymmetric signing key configured as:

- Key spec: `ECC_NIST_EDWARDS25519`
- Key usage: `SIGN_VERIFY`
- Origin: `AWS_KMS` (preferred over importing the temporary development key)
- Signing algorithm: `ED25519_SHA_512`
- `Sign` message type: `RAW`

AWS KMS accepts at most 4,096 bytes per `Sign` request, while the generated registry catalog is substantially larger. The KMS cutover therefore requires signature-envelope schema v2. Sign this domain-separated digest rather than the complete catalog bytes:

```text
UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)
```

Pure Ed25519 signs that small byte sequence in KMS and remains independently verifiable offline with the public key returned by `GetPublicKey`. The verifier must recompute the catalog digest and domain-separated payload itself; it must never trust a digest supplied only by the signature envelope.

The migration is complete only when all of the following are true:

1. Schema-v2 signing and offline-verification tests cover payload tampering, digest tampering, wrong domains, wrong keys, malformed envelopes, and legacy-schema handling.
2. A dedicated release role is the only principal allowed to call `kms:Sign`, restricted to the exact key and `ED25519_SHA_512` algorithm.
3. The signing job runs only in a protected release environment after review. Pull-request code, forked workflows, and ordinary build jobs cannot invoke it.
4. The new public key, key ID, schema-v2 verifier, catalog signature, and generated TypeScript signature are reviewed and landed atomically.
5. `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-uifn-stable.mjs` passes against the final signed catalog, and the KMS signing event is present in CloudTrail.
6. The old Keychain item is retained only for a bounded rollback window, then deleted after all supported releases trust the KMS key.

AWS KMS supports importing asymmetric key material, so preserving the existing key through BYOK is possible. Prefer a newly generated KMS key for the team trust root because the current key originated as a temporary development credential. See the AWS documentation for [Ed25519 asymmetric keys](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html), [the `Sign` API and message-size limit](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), and [imported key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html).

## CLI

```bash
uifn list --json
uifn info button --framework react --json
uifn add button --framework react --cwd . --dry-run --json
uifn add button --framework react --cwd . --json
uifn diff --cwd . --json
uifn update button --cwd . --dry-run --json
uifn doctor --cwd . --json
uifn remove button --cwd . --dry-run --json
uifn validate --json
uifn preset encode --style atlas --base-color mauve --json
uifn preset decode <code> --json
uifn preset resolve --cwd . --json
uifn init --preset <code> --dry-run --json
uifn apply --preset <code> --only theme,font --dry-run --json
```

Versioned presets are documented in `docs/PRESET.md`. `init` and `apply` reuse the same transaction, dirty-conflict, and rollback machinery as `add`. The first approved mutation matrix is `react-vite` with `package` or `source` install.

`add` validates the complete plan before writing. It rejects unsupported frameworks, dependency conflicts, dirty tracked files, traversal, symlink escapes, checksum failures, invalid signatures, dependency cycles, and license/provenance failures. Successful writes are staged on the consumer filesystem and committed atomically; an interruption restores the original bytes.

`--dry-run` returns the exact public plan and writes nothing. Repeating an unchanged install is byte-idempotent.

## Consumer metadata

Source installs write:

- `components/uifn/<framework>/...` — generated source owned by the consumer.
- `.uifn/registry.lock` — schema v2 lock entries with framework, version, dependencies, per-file source/output/installed hashes, canonical/generator versions, and provenance.
- `.uifn/preset.json` — normalized `UIFnPresetV1` code plus managed-file hashes used by `uifn apply` and `uifn preset resolve`.
- `.uifn/selected-components.json` — the selected source-mode component index.
- dependency additions in `package.json`, only when they are not already compatible.

Local edits are never silently overwritten or removed. Conflict diagnostics report base, local, and incoming SHA-256 hashes without exposing file contents or local absolute paths.

## Maintainer checks

```bash
npm run generate:check
npm run typecheck
npm test
npm run build
```

The repository-wide delivery gate also creates independent package/source consumers for React, Svelte, and Solid and verifies type checking, production build, SSR, hydration, browser semantics, accessibility, and semantic-trace equivalence.
