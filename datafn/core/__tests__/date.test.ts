/**
 * Date conversion utilities tests
 * Tests TV-DTE-001, TV-DTE-002 from TEST_VECTORS.md
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  toEpochMs,
  fromEpochMs,
  coerceDateFieldsToEpoch,
  parseDateFieldsToDate,
  toBoundsEpochMs,
  formatBoundEpochMs,
} from "../src/date.js";

const ISO = "2024-01-01T00:00:00.000Z";
const EPOCH = 1704067200000;

describe("toEpochMs (TV-DTE-001)", () => {
  it("Date → epoch", () => expect(toEpochMs(new Date(ISO))).toBe(EPOCH));
  it("ISO string → epoch", () => expect(toEpochMs(ISO)).toBe(EPOCH));
  it("number → idempotent", () => expect(toEpochMs(EPOCH)).toBe(EPOCH));
  it("invalid string throws DFQL_INVALID", () => {
    let caught: unknown;
    try { toEpochMs("not-a-date"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
  it("invalid Date throws DFQL_INVALID", () => {
    let caught: unknown;
    try { toEpochMs(new Date("bad")); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
  it("null throws DFQL_INVALID", () => {
    let caught: unknown;
    try { toEpochMs(null); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
  it("invalid epoch number throws DFQL_INVALID", () => {
    let caught: unknown;
    try { toEpochMs(Number.NaN); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
});

describe("fromEpochMs (TV-DTE-001)", () => {
  it("number → Date", () => expect(fromEpochMs(EPOCH).toISOString()).toBe(ISO));
  it("ISO string → Date", () => expect(fromEpochMs(ISO).toISOString()).toBe(ISO));
  it("Date → idempotent", () => {
    const d = new Date(ISO);
    expect(fromEpochMs(d)).toBe(d);
  });
  it("invalid string throws DFQL_INVALID", () => {
    let caught: unknown;
    try { fromEpochMs("not-a-date"); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
  it("invalid Date throws DFQL_INVALID", () => {
    let caught: unknown;
    try { fromEpochMs(new Date("bad")); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
  it("invalid number throws DFQL_INVALID", () => {
    let caught: unknown;
    try { fromEpochMs(Number.POSITIVE_INFINITY); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });
});

describe("coerceDateFieldsToEpoch (TV-DTE-002)", () => {
  const fields = [
    { name: "title", type: "string" as const },
    { name: "createdAt", type: "date" as const },
    { name: "count", type: "number" as const },
  ];

  it("converts date field to epoch", () => {
    const record: Record<string, unknown> = { title: "Test", createdAt: new Date(ISO), count: 5 };
    coerceDateFieldsToEpoch(record, fields);
    expect(record.createdAt).toBe(EPOCH);
  });

  it("leaves non-date fields unchanged", () => {
    const record: Record<string, unknown> = { title: "Test", createdAt: new Date(ISO), count: 5 };
    coerceDateFieldsToEpoch(record, fields);
    expect(record.title).toBe("Test");
    expect(record.count).toBe(5);
  });

  it("null date field is skipped", () => {
    const record: Record<string, unknown> = { createdAt: null };
    coerceDateFieldsToEpoch(record, fields);
    expect(record.createdAt).toBeNull();
  });

  it("undefined date field is skipped", () => {
    const record: Record<string, unknown> = {};
    coerceDateFieldsToEpoch(record, fields);
    expect(record.createdAt).toBeUndefined();
  });

  it("invalid date string throws DFQL_INVALID", () => {
    const record: Record<string, unknown> = { createdAt: "not-a-date" };
    let caught: unknown;
    try { coerceDateFieldsToEpoch(record, fields); } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: "DFQL_INVALID" });
  });

  it("mutates record in place and returns it", () => {
    const record: Record<string, unknown> = { createdAt: new Date(ISO) };
    const result = coerceDateFieldsToEpoch(record, fields);
    expect(result).toBe(record);
  });
});

describe("parseDateFieldsToDate (TV-DTE-002)", () => {
  const fields = [
    { name: "createdAt", type: "date" as const },
    { name: "count", type: "number" as const },
  ];

  it("converts epoch to Date", () => {
    const record: Record<string, unknown> = { createdAt: EPOCH };
    parseDateFieldsToDate(record, fields);
    expect(record.createdAt).toBeInstanceOf(Date);
    expect((record.createdAt as Date).toISOString()).toBe(ISO);
  });

  it("converts ISO string to Date", () => {
    const record: Record<string, unknown> = { createdAt: ISO };
    parseDateFieldsToDate(record, fields);
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("leaves non-date fields unchanged", () => {
    const record: Record<string, unknown> = { createdAt: EPOCH, count: 5 };
    parseDateFieldsToDate(record, fields);
    expect(record.count).toBe(5);
  });

  it("null date field is skipped", () => {
    const record: Record<string, unknown> = { createdAt: null };
    parseDateFieldsToDate(record, fields);
    expect(record.createdAt).toBeNull();
  });

  it("roundtrip: epoch → Date → epoch", () => {
    const record: Record<string, unknown> = { createdAt: EPOCH };
    parseDateFieldsToDate(record, fields);
    coerceDateFieldsToEpoch(record, fields);
    expect(record.createdAt).toBe(EPOCH);
  });
});

describe("timezone-less datetime parsing contract", () => {
  const TZ_LESS = "2026-06-15T12:00:00";
  const UTC_EPOCH = Date.parse("2026-06-15T12:00:00.000Z");

  it("toEpochMs, fromEpochMs, and toBoundsEpochMs resolve the same instant", () => {
    expect(toEpochMs(TZ_LESS)).toBe(UTC_EPOCH);
    expect(fromEpochMs(TZ_LESS).getTime()).toBe(UTC_EPOCH);
    expect(toBoundsEpochMs(TZ_LESS)).toBe(UTC_EPOCH);
  });

  it("parsing does not depend on the process timezone", () => {
    // Run in a child process pinned to a non-UTC zone: the canonical
    // conversion must still resolve the timezone-less string as UTC.
    const require = createRequire(import.meta.url);
    const runner = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const result = spawnSync(process.execPath, [
      runner, "run", "__tests__/date.test.ts", "--maxWorkers=1", "--minWorkers=1",
      "--testNamePattern=toEpochMs, fromEpochMs, and toBoundsEpochMs resolve the same instant",
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  }, 20000);
});

describe("toBoundsEpochMs", () => {
  it("parses timezone-less ISO datetimes as UTC", () => {
    expect(toBoundsEpochMs("2026-06-15T12:00:00")).toBe(
      Date.parse("2026-06-15T12:00:00.000Z"),
    );
  });
  it("keeps explicit timezone designators", () => {
    expect(toBoundsEpochMs(ISO)).toBe(EPOCH);
  });
  it("passes epoch numbers and Date objects through", () => {
    expect(toBoundsEpochMs(EPOCH)).toBe(EPOCH);
    expect(toBoundsEpochMs(new Date(ISO))).toBe(EPOCH);
  });
  it("returns NaN for non-date values so callers can skip them", () => {
    expect(Number.isNaN(toBoundsEpochMs({ ciphertext: "x" }))).toBe(true);
  });
});

describe("formatBoundEpochMs", () => {
  it("formats finite bounds as ISO strings", () => {
    expect(formatBoundEpochMs(EPOCH)).toBe(ISO);
  });
  it("never throws on invalid bounds", () => {
    expect(formatBoundEpochMs(Number.NaN)).toBe("NaN");
    expect(formatBoundEpochMs(Infinity)).toBe("Infinity");
    expect(formatBoundEpochMs(1e20)).toBe("100000000000000000000");
  });
});
