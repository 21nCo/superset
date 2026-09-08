/**
 * Record read-path normalization helpers.
 */

import type { DatafnResourceSchema } from "./types.js";

// Resource schemas are long-lived singletons, so cache the per-resource field
// scan. Contract: DatafnResourceSchema objects are treated as immutable for
// their lifetime (validateSchema normalizes into fresh objects); mutating a
// schema's fields array after first use would leave this cache stale.
const nonNullableFieldNamesCache = new WeakMap<DatafnResourceSchema, string[]>();

function getNonNullableFieldNames(resource: DatafnResourceSchema): string[] {
  let names = nonNullableFieldNamesCache.get(resource);
  if (!names) {
    names = resource.fields
      .filter((field) => field.nullable !== true)
      .map((field) => field.name);
    nonNullableFieldNamesCache.set(resource, names);
  }
  return names;
}

/**
 * Removes `null` values for fields the schema declares as non-nullable.
 *
 * Storage can legitimately hold `null` for a non-nullable field: optional
 * fields map to nullable columns on SQL adapters, and `replace` clears
 * omitted fields with `null` because that is the only clear representation
 * every supported adapter persists (Drizzle and Prisma ignore `undefined`)
 * and the only one that survives JSON change tracking. Normalizing on read
 * exposes those fields as `undefined` again, matching `DatafnResourceRecord`.
 *
 * Fields with `nullable: true` keep their `null`, and fields not declared in
 * the resource schema (capability fields, `__ns`, ...) are left untouched.
 * Returns the original record when nothing had to be stripped.
 */
export function stripNullsForNonNullableFields(
  record: Record<string, unknown>,
  resource: DatafnResourceSchema | undefined,
): Record<string, unknown> {
  if (!resource) return record;
  let copy: Record<string, unknown> | undefined;
  for (const name of getNonNullableFieldNames(resource)) {
    if (record[name] !== null) continue;
    // Copy lazily and only when a null is actually stripped: stored records
    // must never be mutated in place.
    copy ??= { ...record };
    delete copy[name];
  }
  return copy ?? record;
}
