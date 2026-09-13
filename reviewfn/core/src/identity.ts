import { digestJson } from "./canonical.js";
import type { Finding } from "./types.js";

export function findingFingerprint(finding: Omit<Finding, "fingerprint"> | Finding): string {
  return digestJson({
    category: finding.category,
    title: finding.title.trim().toLowerCase(),
    trigger: finding.trigger.trim().toLowerCase(),
    anchor: finding.anchor ? { commit: finding.anchor.commit, path: finding.anchor.path, startLine: finding.anchor.startLine, endLine: finding.anchor.endLine, symbol: finding.anchor.symbol } : undefined,
    requirementIds: [...finding.requirementIds].sort(),
  });
}
