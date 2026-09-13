export const harnessOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requirements", "assessments", "evidence", "findings", "inspectedPaths", "uninspected"],
  properties: {
    requirements: { type: "array", items: { $ref: "#/$defs/requirement" } },
    assessments: { type: "array", items: { $ref: "#/$defs/assessment" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    findings: { type: "array", items: { $ref: "#/$defs/finding" } },
    inspectedPaths: { type: "array", items: { type: "string" } },
    uninspected: { type: "array", items: { type: "object", additionalProperties: false, required: ["scope", "reason"], properties: { scope: { type: "string" }, reason: { type: "string" } } } },
  },
  $defs: {
    sourceReference: { type: "object", additionalProperties: false, required: ["sourceId", "anchor"], properties: { sourceId: { type: "string" }, anchor: { type: "string" }, excerpt: { type: "string" } } },
    codeAnchor: { type: "object", additionalProperties: false, required: ["commit", "path"], properties: { commit: { type: "string" }, path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, symbol: { type: "string" } } },
    requirement: { type: "object", additionalProperties: false, required: ["id", "statement", "sources", "category", "scope", "classification", "dependencies", "extraction"], properties: { id: { type: "string" }, statement: { type: "string" }, sources: { type: "array", minItems: 1, items: { $ref: "#/$defs/sourceReference" } }, category: { enum: ["behavior", "architecture", "compatibility", "test", "migration", "documentation", "non_goal", "other"] }, scope: { type: "string" }, classification: { enum: ["mandatory", "advisory"] }, dependencies: { type: "array", items: { type: "string" } }, ambiguity: { type: "string" }, extraction: { type: "object", additionalProperties: false, required: ["harness", "promptDigest"], properties: { harness: { type: "string" }, promptDigest: { type: "string" } } } } },
    assessment: { type: "object", additionalProperties: false, required: ["requirementId", "status", "evidenceIds", "reasoning", "gaps", "confidence"], properties: { requirementId: { type: "string" }, status: { enum: ["implemented", "partial", "missing", "unverified", "not_applicable"] }, evidenceIds: { type: "array", items: { type: "string" } }, reasoning: { type: "string" }, gaps: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 }, waiverReference: { $ref: "#/$defs/sourceReference" } } },
    evidence: { type: "object", additionalProperties: false, required: ["id", "kind", "description"], properties: { id: { type: "string" }, kind: { enum: ["source", "code", "diff", "test", "artifact"] }, description: { type: "string" }, source: { $ref: "#/$defs/sourceReference" }, code: { $ref: "#/$defs/codeAnchor" }, receiptId: { type: "string" }, artifactDigest: { type: "string" } } },
    finding: { type: "object", additionalProperties: false, required: ["fingerprint", "severity", "category", "title", "trigger", "impact", "direction", "evidenceIds", "basis", "requirementIds", "lifecycle"], properties: { fingerprint: { type: "string" }, severity: { enum: ["critical", "high", "medium", "low", "info"] }, category: { type: "string" }, title: { type: "string" }, trigger: { type: "string" }, impact: { type: "string" }, direction: { type: "string" }, anchor: { $ref: "#/$defs/codeAnchor" }, evidenceIds: { type: "array", items: { type: "string" } }, basis: { enum: ["reproduced", "inferred"] }, requirementIds: { type: "array", items: { type: "string" } }, lifecycle: { enum: ["new", "still_valid", "resolved", "superseded", "needs_revalidation"] } } },
  },
} as const;
