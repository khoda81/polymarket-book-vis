import type { Market } from "@polymarket/client";
import {
  relativeTimeDisplay,
  type RelativeTimeDisplay,
} from "../../shared/math";
import { timestampMs } from "../../shared/parse";

export type MarketTimeMarker =
  | { readonly kind: "game-start"; readonly timeMs: number }
  | { readonly kind: "reported-end"; readonly timeMs: number };

/** The reported market end date, without substituting event or settlement dates. */
export function marketDeadlineMs(market: Pick<Market, "state">): number | null {
  return timestampMs(market.state.endDate);
}

/**
 * The honest schedule marker for a market row.
 *
 * Gamma can use `endDate` as kickoff for sports markets. Prefer its explicit
 * `gameStartTime` there so a live match is never presented as already ended.
 */
export function marketTimeMarker(
  market: Pick<Market, "sports" | "state">,
): MarketTimeMarker | null {
  const gameStartMs = timestampMs(market.sports.gameStartTime);
  if (gameStartMs !== null) return { kind: "game-start", timeMs: gameStartMs };

  const endMs = marketDeadlineMs(market);
  return endMs === null ? null : { kind: "reported-end", timeMs: endMs };
}

/** Compact wall-clock offset. A passed deadline says nothing about resolution. */
export function deadlineDisplay(
  deadlineMs: number | null,
  nowMs: number,
): RelativeTimeDisplay {
  if (deadlineMs === null) return { text: "No end date", nextChangeMs: null };

  const remainingMs = deadlineMs - nowMs;
  if (remainingMs === 0) return { text: "now", nextChangeMs: 1 };

  const direction = remainingMs > 0 ? "remaining" : "elapsed";
  const duration = relativeTimeDisplay(
    Math.abs(remainingMs) / 1_000,
    direction,
  );

  return {
    text: remainingMs > 0 ? `in ${duration.text}` : `${duration.text} ago`,
    nextChangeMs: duration.nextChangeMs,
  };
}

export function marketTimeDisplay(
  marker: MarketTimeMarker | null,
  nowMs: number,
): RelativeTimeDisplay {
  if (marker === null) return deadlineDisplay(null, nowMs);

  const display = deadlineDisplay(marker.timeMs, nowMs);
  if (marker.kind === "reported-end") return display;
  if (display.text === "now") return { ...display, text: "starts now" };
  return {
    ...display,
    text: display.text.startsWith("in ")
      ? `starts ${display.text}`
      : `started ${display.text}`,
  };
}

export function marketTimeTooltip(marker: MarketTimeMarker | null): string {
  if (marker === null)
    return "Polymarket does not report an end date for this market";

  const label =
    marker.kind === "game-start" ? "Reported game start" : "Reported end";
  const date = new Date(marker.timeMs);
  return `${label}: ${date.toLocaleString()} (${date.toISOString()})`;
}
