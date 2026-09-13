# Evaluation

`reviewfn evaluate --input evaluation.json` consumes frozen cases and observed outcomes. Each case records source/change digests, human-adjudicated requirements, known gaps, valid findings, acceptability, retrospective status and limitations.

The result always includes numerators and denominators for requirement-extraction recall, gap-detection recall, finding precision, false-block rate, evidence validity and completion rate. Failed and missing outcomes remain in completion denominators. Runtime, tokens and measurable cost are reported only when observed; unavailable values remain null.

Comparisons name every changed harness, version, provider, model, prompt, context or budget dimension. A result with more than one changed dimension is confounded and must not be described as a model-only ranking.

Historical cases require exact contemporaneous heads and source snapshots. When source version history cannot be recovered, mark the case retrospective. Prior bot labels and assistant judgments are candidate labels, not adjudicated ground truth.

The repository includes `evaluation/data6-pr153.json` and its evidence ledger as a first retrospective schema smoke test. It must not be presented as model-quality evidence: it contains one human-adjudicated case, current rather than contemporaneous Linear source content, and no token, cost, or live-model timing observations.
