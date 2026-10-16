import { expect, test } from "bun:test";
import type { Market } from "@polymarket/client";
import {
  deadlineDisplay,
  marketDeadlineMs,
  marketTimeDisplay,
  marketTimeMarker,
} from "./marketDeadline";

test("only the reported market end date is a deadline", () => {
  const make = (endDate?: string) =>
    ({
      state: { endDate, closedTime: "2026-10-31T23:59:00Z" },
    }) as unknown as Market;
  expect(marketDeadlineMs(make("2026-10-16T03:59:00Z"))).toBe(
    Date.parse("2026-10-16T03:59:00Z"),
  );
  expect(marketDeadlineMs(make())).toBeNull();
  expect(marketDeadlineMs(make("invalid"))).toBeNull();
});

test("relative dates distinguish past, future and missing without asserting resolution", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  expect(deadlineDisplay(now + 6 * 86_400_000, now).text).toBe("in 6d");
  expect(deadlineDisplay(now - 6 * 86_400_000, now).text).toBe("6d ago");
  expect(deadlineDisplay(now + 7 * 86_400_000, now).text).toBe("in 1w");
  expect(deadlineDisplay(now + 60 * 86_400_000, now).text).toBe("in 8.6w");
  expect(deadlineDisplay(null, now)).toEqual({
    text: "No end date",
    nextChangeMs: null,
  });
});

test("sports markets label their reported game start instead of treating kickoff as an end", () => {
  const market = {
    state: { endDate: "2026-10-14T19:00:00Z" },
    sports: { gameStartTime: "2026-10-14 19:00:00+00" },
  } as unknown as Market;
  const marker = marketTimeMarker(market);

  expect(marker).toEqual({
    kind: "game-start",
    timeMs: Date.parse("2026-10-14T19:00:00Z"),
  });
  expect(
    marketTimeDisplay(marker, Date.parse("2026-10-14T18:25:00Z")).text,
  ).toBe("starts in 35m");
  expect(
    marketTimeDisplay(marker, Date.parse("2026-10-14T19:35:00Z")).text,
  ).toBe("started 35m ago");
});

test("invalid or absent sports metadata falls back to the reported market end", () => {
  const market = {
    state: { endDate: "2026-10-16T03:59:00Z" },
    sports: { gameStartTime: "invalid" },
  } as unknown as Market;

  expect(marketTimeMarker(market)).toEqual({
    kind: "reported-end",
    timeMs: Date.parse("2026-10-16T03:59:00Z"),
  });
});

test("deadline clocks schedule the next displayed change rather than pressure frames", () => {
  for (const offset of [
    -85_000_123, -3_620_000, -65_555, -1_500, 0, 999, 1_500, 59_999, 60_000,
    3_600_000, 86_400_000, 900_000_000,
  ]) {
    const now = 1_000_000_000;
    const deadline = now + offset;
    const display = deadlineDisplay(deadline, now);
    const delay = display.nextChangeMs!;
    expect(delay).toBeGreaterThan(0);
    if (delay > 2)
      expect(deadlineDisplay(deadline, now + delay / 2).text).toBe(
        display.text,
      );
    expect(deadlineDisplay(deadline, now + delay + 2).text).not.toBe(
      display.text,
    );
  }
});
