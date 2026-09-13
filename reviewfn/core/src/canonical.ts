import { createHash, randomUUID } from "node:crypto";

import type { JsonValue } from "./types.js";

function canonicalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles.");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = canonicalize(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function createAttemptId(): string {
  return randomUUID();
}
