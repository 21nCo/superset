# Report schema version 1

A report records three independent axes:

- execution: `queued`, `running`, `completed`, `failed`, `canceled`, or `superseded`;
- coverage: `complete` or `incomplete`, with reasons;
- verdict: `ready`, `changes_requested`, or `needs_verification`, absent when no valid assessment exists.

Requirements contain immutable source anchors and exactly one assessment. Assessments distinguish `implemented`, `partial`, `missing`, `unverified`, and source-waived `not_applicable`. Evidence links to a context source, exact-head code anchor, diff, test receipt, or content-addressed artifact.

Findings carry a stable fingerprint, severity, concrete trigger/impact/direction, reproduced-versus-inferred basis, requirement links and lifecycle. Model confidence never substitutes for evidence validity.

`contextManifestDigest` identifies the normalized snapshot bytes and `contextManifestArtifact` names the corresponding content-addressed stored artifact. Test receipts contain exact argv, commit, timing, exit status, stdout/stderr digests and limitations; they do not claim a retrievable log artifact unless one was actually persisted.

The validator rejects duplicate identifiers, unknown requirements/evidence/sources, stale commit anchors, invalid line ranges, unjustified exclusions, over-limit findings, incomplete-ready reports and any verdict inconsistent with deterministic policy.
