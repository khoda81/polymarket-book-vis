import { expect, test } from "bun:test";
import type { ConditionId, Market, TokenId } from "@polymarket/client";
import {
  initialMarketLifecycle,
  resolveMarketLifecycle,
  summarizeEventMarketStatus,
} from "./marketLifecycle";

const CONDITION_ID = "condition-1" as ConditionId;
const YES_TOKEN_ID = "yes-token" as TokenId;
const NO_TOKEN_ID = "no-token" as TokenId;

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    conditionId: CONDITION_ID,
    state: {
      active: true,
      closed: false,
      acceptingOrders: true,
    },
    outcomes: {
      yes: {
        label: "Up",
        tokenId: YES_TOKEN_ID,
        positionId: null,
        price: "0.5",
      },
      no: {
        label: "Down",
        tokenId: NO_TOKEN_ID,
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
    winningTokenId: YES_TOKEN_ID,
    winningOutcome: "Up",
  });
});

test("resolution update carries the actual winner instead of hiding the market", () => {
  expect(
    resolveMarketLifecycle(
      { kind: "live" },
      {
        conditionId: CONDITION_ID,
        assetIds: [YES_TOKEN_ID, NO_TOKEN_ID],
        winningAssetId: NO_TOKEN_ID,
        winningOutcome: "Down",
      },
      YES_TOKEN_ID,
      NO_TOKEN_ID,
      "Up",
      "Down",
    ),
  ).toEqual({
    kind: "resolved",
    winningTokenId: NO_TOKEN_ID,
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
