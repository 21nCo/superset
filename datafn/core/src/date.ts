/**
 * Shared date conversion utilities (DTE-001, DTE-002)
 */

import type { DatafnFieldSchema } from "./types.js";
import { isDatafnE2eeEnvelope } from "./e2ee.js";

function dfqlInvalid(msg: string): never {
  throw { code: "DFQL_INVALID", message: msg };
}

function assertFiniteEpoch(value: number): void {
  if (!Number.isFinite(value)) {
    dfqlInvalid(`Invalid epoch milliseconds: ${String(value)}`);
  }
}

/**
 * ISO datetimes without a timezone designator (date-only forms are already
 * parsed as UTC by ECMAScript, so they are excluded here).
 */
const TIMEZONE_LESS_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Canonical string-to-epoch conversion shared by validation, persistence,
 * and read coercion. Timezone-less ISO datetimes are interpreted as UTC so
 * the same accepted string resolves to the same instant regardless of the
 * process timezone. Returns NaN for unparseable strings.
 */
function parseDateStringEpochMs(value: string): number {
  const normalized = TIMEZONE_LESS_DATETIME_RE.test(value)
    ? `${value}Z`
    : value;
  return Date.parse(normalized);
}

/**
 * Convert a Date, ISO string, or epoch number to epoch milliseconds.
 * Idempotent: if already a number, returns it directly.
 */
export function toEpochMs(value: unknown): number {
  if (typeof value === "number") {
    assertFiniteEpoch(value);
    return value;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    assertFiniteEpoch(ms);
    return ms;
  }
  if (typeof value === "string") {
    const ms = parseDateStringEpochMs(value);
    assertFiniteEpoch(ms);
    return ms;
  }
  dfqlInvalid(`Cannot convert to epoch ms: ${String(value)}`);
}

/**
 * Convert an epoch number, ISO string, or Date to a Date object.
 * Idempotent: if already a Date, returns it directly.
 */
export function fromEpochMs(value: unknown): Date {
  if (value instanceof Date) {
    assertFiniteEpoch(value.getTime());
    return value;
  }
  if (typeof value === "number") {
    assertFiniteEpoch(value);
    return new Date(value);
  }
  if (typeof value === "string") {
    const ms = parseDateStringEpochMs(value);
    assertFiniteEpoch(ms);
    return new Date(ms);
  }
  dfqlInvalid(`Cannot convert to Date: ${String(value)}`);
}

/**
 * Epoch milliseconds for min/max bounds comparison. Timezone-less ISO
 * datetimes are interpreted as UTC so absolute bounds are independent of the
 * server's local timezone. Returns NaN for values that are not date-like
 * (e.g. e2ee envelopes), letting callers skip them.
 */
export function toBoundsEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return parseDateStringEpochMs(value);
  return Number.NaN;
}

/**
 * Format an epoch-ms bound for error messages. Never throws: invalid or
 * out-of-range bounds fall back to their raw string form.
 */
export function formatBoundEpochMs(bound: number): string {
  const date = new Date(bound);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(bound);
}

type FieldLike = Pick<DatafnFieldSchema, "name" | "type">;

/**
 * Mutate record in place: convert date-typed fields to epoch milliseconds.
 *
 * LOW-024: This function intentionally mutates the record in-place and returns it
 * (callers rely on the mutation side-effect, as verified by existing tests).
 * If a non-mutating variant is needed, create a separate helper that copies first.
 */
export function coerceDateFieldsToEpoch(
  record: Record<string, unknown>,
  fields: readonly FieldLike[],
): Record<string, unknown> {
  for (const field of fields) {
    if (field.type !== "date") continue;
    const val = record[field.name];
    if (val === null || val === undefined) continue;
    if (isDatafnE2eeEnvelope(val)) continue;
    record[field.name] = toEpochMs(val);
  }
  return record;
}

/**
 * Mutate record in place: convert date-typed fields to Date objects.
 *
 * LOW-024: This function intentionally mutates the record in-place and returns it
 * (callers rely on the mutation side-effect, as verified by existing tests).
 * If a non-mutating variant is needed, create a separate helper that copies first.
 */
export function parseDateFieldsToDate(
  record: Record<string, unknown>,
  fields: readonly FieldLike[],
): Record<string, unknown> {
  for (const field of fields) {
    if (field.type !== "date") continue;
    const val = record[field.name];
    if (val === null || val === undefined) continue;
    if (isDatafnE2eeEnvelope(val)) continue;
    record[field.name] = fromEpochMs(val);
  }
  return record;
}
