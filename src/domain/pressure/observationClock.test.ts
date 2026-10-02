import { expect, test } from "bun:test";
import {
  ObservationClock,
  observationReference,
  observationTime,
  opacityReference,
  type ObservationDescription,
  type ObservationPoint,
  type ObservationReference,
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
  expect(
    observationReference(
      frame.kind === "observed" ? frame.tokens : [],
    ),
  ).toEqual({
    kind: "observed",
    newestMs: observationTime(2_000),
  });

  unregisterSecond();
  expect(opacityReference(observationReference(first.values()))).toBe(
    observationTime(1_000),
  );
  first.set("yes", point("yes", 3_000));
  expect(opacityReference(observationReference(first.values()))).toBe(
    observationTime(3_000),
  );
  unregisterFirst();
  expect(clock.read()).toEqual({ kind: "unobserved" });
});

test("quiet periods advance real age without changing pressure opacity or dot positions", () => {
  const clock = new ObservationClock();
  const data = new Map([
    ["new", point("new", 10_000)],
    ["old", point("old", 5_000)],
  ]);
  clock.register({
    points: data,
    describe: (tokenId) => ({ name: tokenId, color: "red" }),
  });
  const reference = opacityReference(observationReference(data.values()));
  const halfLife = 5_000;
  const dot = ghostPositionForAge(reference - 5_000, halfLife);
  expect(stalenessAlpha(5_000, reference, halfLife)).toBe(0.5);
  for (const wallNow of [10_000, 15_000, 60_000]) {
    expect(opacityReference(observationReference(data.values()))).toBe(reference);
    expect(
      stalenessAlpha(5_000, opacityReference(observationReference(data.values())), halfLife),
    ).toBe(0.5);
    const actualAge = wallNow - reference + ageAtGhostPosition(dot, halfLife);
    expect(actualAge).toBe(wallNow - 5_000);
  }
  data.set("new", point("new", 15_000));
  expect(
    stalenessAlpha(5_000, opacityReference(observationReference(data.values())), halfLife),
  ).toBe(0.25);
  expect(ghostPositionForAge(15_000 - 5_000, halfLife)).toBe(0.75);
});
