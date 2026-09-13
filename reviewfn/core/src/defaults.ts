import type { ReviewFnConfig, ReviewPolicy } from "./types.js";

export const DEFAULT_POLICY: ReviewPolicy = {
  version: 1,
  mode: "advisory",
  requiredCategories: ["behavior", "architecture", "compatibility", "test"],
  blockingSeverities: ["critical", "high"],
  allowRepositoryTightening: true,
  sourceAuthority: {
    acceptedTypes: ["issue", "comment", "document", "repository_markdown"],
    commentsMayClarify: true,
    waiverAuthorities: [],
  },
  limits: {
    contextMaxSources: 100,
    contextMaxBytes: 2_000_000,
    contextMaxDepth: 4,
    harnessTimeoutMs: 30 * 60_000,
    testTimeoutMs: 15 * 60_000,
    maxOutputBytes: 10_000_000,
    maxFindings: 100,
  },
  retention: { reportDays: 30, transcriptDays: 7, testLogDays: 7 },
};

export const DEFAULT_CONFIG: ReviewFnConfig = {
  version: 1,
  profile: "requirements",
  harness: { adapter: "codex", version: "1", executable: "codex" },
  inference: { provider: "openai", model: "configured", auth: "api-key", credentialEnv: "CODEX_API_KEY" },
  context: [{ adapter: "repository-markdown", paths: ["README.md", "docs/**/*.md"] }],
  review: { categories: ["behavior", "architecture", "compatibility", "test", "documentation"], evidenceRequired: true },
  execution: { adapter: "local-isolated", tests: [], timeoutMs: 15 * 60_000, maxOutputBytes: 10_000_000 },
  output: { destinations: ["local"], mode: "advisory" },
  retention: { reportDays: 30, transcriptDays: 7, testLogDays: 7 },
  fallback: [],
};
