import type { MarketId, TokenId } from "@polymarket/client";
import type { EventMarket } from "@/domain/markets/eventDetails";

/** A live, tradable parsed market with `yes-<id>`/`no-<id>` tokens. */
export function eventMarket(
  id: string,
  overrides: Partial<EventMarket> = {},
): EventMarket {
  return {
    id: id as MarketId,
    conditionId: null,
    title: `Market ${id}`,
    groupItemTitle: null,
    question: null,
    yes: { label: "Yes", tokenId: `yes-${id}` as TokenId, price: null },
    no: { label: "No", tokenId: `no-${id}` as TokenId, price: null },
    tradable: true,
    closed: false,
    archived: false,
    negRisk: false,
    reportedLifecycle: { kind: "live" },
    threshold: null,
    resolutionMs: null,
    timeMarker: null,
    iconUrl: null,
    rule: null,
    feeSchedule: null,
    ...overrides,
  };
}
