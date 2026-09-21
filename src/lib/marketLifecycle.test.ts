import { expect, test } from "bun:test";
import type { Market, TokenId } from "@polymarket/client";
import {
  initialMarketLifecycle,
  resolveMarketLifecycle,
  summarizeEventMarketStatus,
} from "./marketLifecycle";

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    conditionId: "condition-1",
    state: {
      active: true,
      closed: false,
      acceptingOrders: true,
    },
    outcomes: {
      yes: {
        label: "Up",
        tokenId: "yes-token" as TokenId,
        positionId: null,
        price: "0.5",
      },
      no: {
        label: "Down",
        tokenId: "no-token" as TokenId,
        positionId: null,
        price: "0.5",
      },
    },
    metrics: {},
    prices: {},
    trading: {},
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus: null,
      resolvedBy: null,
    },
    rewards: {},
    sports: {},
    events: [],
    tags: [],
    positionIds: [],
    ...overrides,
  } as Market;
}

test("initial lifecycle distinguishes live, awaiting, and resolved", () => {
  expect(initialMarketLifecycle(market())).toEqual({
    kind: "live",
  });

  expect(
    initialMarketLifecycle(
      market({
        state: {
          active: false,
          closed: true,
          acceptingOrders: false,
        },
      }),
    ),
  ).toEqual({ kind: "awaiting-resolution" });

  const resolved = market();
  resolved.state.closed = true;
  resolved.outcomes.yes.price = "1" as Market["outcomes"]["yes"]["price"];
  resolved.outcomes.no.price = "0" as Market["outcomes"]["no"]["price"];
  expect(initialMarketLifecycle(resolved)).toEqual({
    kind: "resolved",
    winningTokenId: "yes-token" as TokenId,
    winningOutcome: "Up",
  });
});

test("resolution update carries the actual winner instead of hiding the market", () => {
  expect(
    resolveMarketLifecycle(
      { kind: "live" },
      {
        conditionId: "condition-1",
        assetIds: ["yes-token", "no-token"],
        winningTokenId: "no-token" as TokenId,
        winningOutcome: "Down",
      },
      "yes-token" as TokenId,
      "no-token" as TokenId,
      "Up",
      "Down",
    ),
  ).toEqual({
    kind: "resolved",
    winningTokenId: "no-token" as TokenId,
    winningOutcome: "Down",
  });
});

test("event status only becomes resolved when every market is resolved", () => {
  expect(
    summarizeEventMarketStatus([
      {
        kind: "resolved",
        winningTokenId: "a" as TokenId,
        winningOutcome: "Yes",
      },
      {
        kind: "resolved",
        winningTokenId: "b" as TokenId,
        winningOutcome: "No",
      },
    ]),
  ).toEqual({ kind: "resolved" });

  expect(
    summarizeEventMarketStatus([
      { kind: "awaiting-resolution" },
      {
        kind: "resolved",
        winningTokenId: "b" as TokenId,
        winningOutcome: "No",
      },
    ]),
  ).toEqual({ kind: "awaiting-resolution" });

  expect(
    summarizeEventMarketStatus([
      { kind: "live" },
      {
        kind: "resolved",
        winningTokenId: "b" as TokenId,
        winningOutcome: "No",
      },
    ]),
  ).toEqual({ kind: "trading" });
});
