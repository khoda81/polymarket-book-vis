import { describe, expect, test } from "bun:test";
import { SpreadAge } from "./spreadAge";

describe("SpreadAge", () => {
  test("initial spread starts at age zero", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 100);

    expect(age.segments(100)).toEqual([{ lo: 0.4, hi: 0.6, ageMs: 0 }]);
  });

  test("unchanged spread preserves age", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 100);
    age.update(0.4, 0.6, 150);

    expect(age.segments(225)).toEqual([{ lo: 0.4, hi: 0.6, ageMs: 125 }]);
  });

  test("shrinking spread preserves the old start time", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 0);
    age.update(0.45, 0.55, 10);

    expect(age.segments(20)).toEqual([{ lo: 0.45, hi: 0.55, ageMs: 20 }]);
  });

  test("expanding spread preserves the center and starts fresh wings", () => {
    const age = new SpreadAge();
    age.update(0.45, 0.55, 0);
    age.update(0.4, 0.6, 10);

    expect(age.segments(10)).toEqual([
      { lo: 0.4, hi: 0.45, ageMs: 0 },
      { lo: 0.45, hi: 0.55, ageMs: 10 },
      { lo: 0.55, hi: 0.6, ageMs: 0 },
    ]);
  });

  test("shifting spread preserves only the overlap", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 0);
    age.update(0.5, 0.7, 10);

    expect(age.segments(20)).toEqual([
      { lo: 0.5, hi: 0.6, ageMs: 20 },
      { lo: 0.6, hi: 0.7, ageMs: 10 },
    ]);
  });

  test("a disjoint move resets the entire current spread", () => {
    const age = new SpreadAge();
    age.update(0.1, 0.2, 0);
    age.update(0.7, 0.9, 10);

    expect(age.segments(15)).toEqual([{ lo: 0.7, hi: 0.9, ageMs: 5 }]);
  });

  test("repeated expand and shrink produces the expected staircase", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 0);
    age.update(0.45, 0.55, 10);
    age.update(0.4, 0.6, 20);

    expect(age.segments(30)).toEqual([
      { lo: 0.4, hi: 0.45, ageMs: 10 },
      { lo: 0.45, hi: 0.55, ageMs: 30 },
      { lo: 0.55, hi: 0.6, ageMs: 10 },
    ]);
  });

  test("clear removes all history", () => {
    const age = new SpreadAge();
    age.update(0.4, 0.6, 0);
    age.clear();

    expect(age.segments(100)).toEqual([]);
    age.update(0.45, 0.55, 100);
    expect(age.segments(100)).toEqual([{ lo: 0.45, hi: 0.55, ageMs: 0 }]);
  });
});
