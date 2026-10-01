import { expect, test } from "bun:test";
import { ghostObservationColumns } from "./ghostObservationMarkers";
import {
  observationTime,
  type ObservationFrame,
  type ObservedToken,
} from "../../domain/pressure/observationClock";

function token(
  tokenId: string,
  observedAtMs: number,
  color = "#fff",
): ObservedToken {
  return {
    tokenId,
    observedAtMs: observationTime(observedAtMs),
    name: tokenId,
    color,
  };
}

function frame(
  newestMs: number,
  tokens: readonly ObservedToken[],
): Extract<ObservationFrame, { kind: "observed" }> {
  return {
    kind: "observed",
    newestMs: observationTime(newestMs),
    tokens,
  };
}

test("ghost observation markers preserve transformed x to physical-pixel precision", () => {
  const columns = ghostObservationColumns(
    frame(2_000, [token("older", 1_500)]),
    1_000,
    100,
    2,
    4,
  );

  expect(columns).toHaveLength(1);
  // 500ms on a 1s half-life projects to x≈30.95 CSS px. On DPR 2 the
  // nearest physical-pixel center is 31.25px, not an arbitrary 8px bucket.
  expect(columns[0]!.xCss).toBe(30.75);
});

test("ghost observation markers group only truly screen-coincident pixels", () => {
  const columns = ghostObservationColumns(
    frame(2_000, [
      token("newest", 2_000, "#f00"),
      token("nearby", 1_999, "#0f0"),
      token("separate", 1_990, "#00f"),
    ]),
    1_000,
    100,
    2,
    4,
  );

  expect(columns).toHaveLength(2);
  expect(columns[0]!.tokens.map(({ tokenId }) => tokenId)).toEqual([
    "newest",
    "nearby",
  ]);
  expect(columns[1]!.tokens.map(({ tokenId }) => tokenId)).toEqual([
    "separate",
  ]);
});
