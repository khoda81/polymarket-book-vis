import { expect, test } from "bun:test";
import {
  ObservationClock,
  observationReference,
  observationTime,
  opacityReference,
  type ObservationDescription,
  type ObservationPoint,
} from "./observationClock";
import { stalenessAlpha } from "./pressureField";
import {
  ghostPositionForAge,
  ageAtGhostPosition,
} from "../../rendering/legends/ghostLegendTicks";

const point = (id: string, timestamp: number): ObservationPoint => ({
  tokenId: id,
  observedAtMs: observationTime(timestamp),
});

function source(read: () => readonly ObservationPoint[]) {
  return {
    points: new Map(read().map((point) => [point.tokenId, point])),
    describe: (tokenId: string): ObservationDescription => ({
      name: tokenId,
      color: "red",
    }),
  };
}

test("observation timestamps reject invalid values at the boundary", () => {
  for (const value of [NaN, Infinity, -1])
    expect(() => observationTime(value)).toThrow(RangeError);
  expect(observationTime(0)).toBe(observationTime(0));
});

test("one canonical point stream derives both newest time and token presentation", () => {
  const clock = new ObservationClock();
  const first = new Map([["yes", point("yes", 1_000)]]);
  const unregisterFirst = clock.register({
    points: first,
    describe: (tokenId) => ({ name: tokenId, color: "red" }),
  });
  const unregisterSecond = clock.register(
    source(() => [point("yes", 900), point("no", 2_000)]),
  );

  const frame = clock.read();
  expect(frame.kind).toBe("observed");
  if (frame.kind !== "observed") throw new Error("missing observations");
  expect(frame.tokens).toHaveLength(2);
  expect(frame.tokens.find((t) => t.tokenId === "yes")!.observedAtMs).toBe(
    observationTime(1_000),
  );
  expect(frame.newestMs).toBe(observationTime(2_000));
  expect(observationReference(frame.tokens)).toEqual({
    kind: "observed",
    newestMs: observationTime(2_000),
  });

  unregisterSecond();
  expect(opacityReference(clock.readReference())).toBe(observationTime(2_000));

  first.set("yes", point("yes", 3_000));
  clock.advance(3_000);
  expect(opacityReference(clock.readReference())).toBe(observationTime(3_000));

  unregisterFirst();
  expect(clock.read()).toEqual({ kind: "unobserved" });
  expect(opacityReference(clock.readReference())).toBe(observationTime(3_000));
});

test("global observation time advances across sources and never regresses", () => {
  const clock = new ObservationClock();

  clock.advance(1_000);
  expect(opacityReference(clock.readReference())).toBe(observationTime(1_000));

  clock.advance(2_000);
  expect(opacityReference(clock.readReference())).toBe(observationTime(2_000));

  clock.advance(1_500);
  expect(opacityReference(clock.readReference())).toBe(observationTime(2_000));
});

test("presentation source mutations do not define global causal time", () => {
  const clock = new ObservationClock();
  const points = new Map<string, ObservationPoint>();
  const unregister = clock.register({
    points,
    describe: (tokenId) => ({ name: tokenId, color: "red" }),
  });

  points.set("yes", point("yes", 1_000));
  expect(clock.readReference()).toEqual({ kind: "unobserved" });

  clock.advance(1_000);
  expect(opacityReference(clock.readReference())).toBe(observationTime(1_000));

  points.clear();
  unregister();
  expect(opacityReference(clock.readReference())).toBe(observationTime(1_000));
});

test("quiet periods keep causal opacity fixed until the global clock advances", () => {
  const clock = new ObservationClock();
  clock.advance(10_000);

  const reference = opacityReference(clock.readReference());
  const halfLife = 5_000;
  const dot = ghostPositionForAge(reference - 5_000, halfLife);
  expect(stalenessAlpha(5_000, reference, halfLife)).toBe(0.5);

  for (const wallNow of [10_000, 15_000, 60_000]) {
    const currentReference = opacityReference(clock.readReference());
    expect(currentReference).toBe(reference);
    expect(stalenessAlpha(5_000, currentReference, halfLife)).toBe(0.5);
    const actualAge = wallNow - reference + ageAtGhostPosition(dot, halfLife);
    expect(actualAge).toBe(wallNow - 5_000);
  }

  clock.advance(15_000);
  expect(
    stalenessAlpha(5_000, opacityReference(clock.readReference()), halfLife),
  ).toBe(0.25);
  expect(ghostPositionForAge(15_000 - 5_000, halfLife)).toBe(0.75);
});
