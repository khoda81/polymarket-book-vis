import { describe, expect, test } from "bun:test";
import { diffusionVisual, nextDiffusionChangeDelayMs } from "./diffusion";

describe("diffusionVisual", () => {
  test("fresh evidence is concentrated and fully opaque at its center", () => {
    const fresh = diffusionVisual(0, 5);
    expect(fresh.peakAlpha).toBe(1);
    expect(fresh.sigmaPx).toBeCloseTo(0.85);
  });

  test("older evidence spreads while its peak falls", () => {
    const fresh = diffusionVisual(0, 5);
    const older = diffusionVisual(5_000, 5);
    expect(older.sigmaPx).toBeGreaterThan(fresh.sigmaPx);
    expect(older.peakAlpha).toBeLessThan(fresh.peakAlpha);
  });

  test("unknown evidence at infinite age is invisible", () => {
    expect(diffusionVisual(Infinity, 5).peakAlpha).toBe(0);
    expect(nextDiffusionChangeDelayMs(Infinity, 5)).toBe(Infinity);
  });

  test("quantized rendering schedules a future visual change", () => {
    const delay = nextDiffusionChangeDelayMs(0, 5);
    expect(delay).toBeGreaterThan(1);
    expect(Number.isFinite(delay)).toBe(true);
  });
});
