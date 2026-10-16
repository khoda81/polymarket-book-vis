import { expect, test } from "bun:test";
import type { Event, Market } from "@polymarket/client";
import { eventTimingDisplay } from "./eventTiming";

const KICKOFF = Date.parse("2026-10-14T19:00:00Z");

function market(
  endDate: string,
  gameStartTime?: string,
  closed = false,
): Market {
  return {
    state: { endDate, closed },
    sports: { gameStartTime },
    resolution: { umaResolutionStatus: null },
    outcomes: {
      yes: { price: "0.5" },
      no: { price: "0.5" },
    },
  } as unknown as Market;
}

function event(overrides: Partial<Event>): Event {
  return {
    state: {},
    sports: { bestLines: [], teams: [] },
    markets: [],
    ...overrides,
  } as Event;
}

test("live sports results show the reported match clock, not a due resolution", () => {
  expect(
    eventTimingDisplay(
      event({
        state: { live: true },
        sports: {
          period: "1H",
          elapsed: "36",
          bestLines: [],
          teams: [],
        },
        markets: [market("2026-10-14T19:00:00Z", "2026-10-14 19:00:00+00")],
      }),
      KICKOFF + 36 * 60_000,
    ),
  ).toEqual({
    text: "1H · 36′",
    title: "Live match clock reported by Polymarket",
  });
});

test("sports schedules and ordinary market ends keep distinct semantics", () => {
  expect(
    eventTimingDisplay(
      event({
        markets: [market("2026-10-14T19:00:00Z", "2026-10-14 19:00:00+00")],
      }),
      KICKOFF - 35 * 60_000,
    ),
  ).toEqual({ text: "starts in 35m", title: "Reported game start" });

  expect(
    eventTimingDisplay(
      event({ markets: [market("2026-10-14T19:00:00Z")] }),
      KICKOFF - 35 * 60_000,
    ),
  ).toEqual({
    text: "T−35m",
    title: "Time until next reported market end",
  });
});

test("passed end dates are not presented as pending resolutions", () => {
  expect(
    eventTimingDisplay(
      event({ markets: [market("2026-10-14T19:00:00Z")] }),
      KICKOFF + 35 * 60_000,
    ),
  ).toEqual({
    text: "end 35m ago",
    title: "Time since latest reported market end",
  });
});
