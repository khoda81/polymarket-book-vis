import { expect, test } from "bun:test";
import { finiteNumber, timestampMs } from "./parse";

test("finiteNumber accepts numbers and numeric strings only", () => {
  expect(finiteNumber(1.5)).toBe(1.5);
  expect(finiteNumber(" 42 ")).toBe(42);
  expect(finiteNumber("")).toBeNull();
  expect(finiteNumber("  ")).toBeNull();
  expect(finiteNumber("abc")).toBeNull();
  expect(finiteNumber(Number.NaN)).toBeNull();
  expect(finiteNumber(Infinity)).toBeNull();
  expect(finiteNumber(null)).toBeNull();
});

test("timestampMs reads ISO, Gamma SQL-style, Date and epoch values", () => {
  const ms = Date.UTC(2026, 9, 16, 12, 30);
  expect(timestampMs("2026-10-16T12:30:00Z")).toBe(ms);
  expect(timestampMs("2026-10-16 12:30:00+00")).toBe(ms);
  expect(timestampMs("2026-10-16 15:30:00+03")).toBe(ms);
  expect(timestampMs("2026-10-16")).toBe(Date.UTC(2026, 9, 16));
  expect(timestampMs(new Date(ms))).toBe(ms);
  expect(timestampMs(ms)).toBe(ms);
  expect(timestampMs("")).toBeNull();
  expect(timestampMs("not a date")).toBeNull();
  expect(timestampMs(undefined)).toBeNull();
});
