import type { Market } from "@polymarket/client";
import {
  relativeTimeDisplay,
  type RelativeTimeDisplay,
} from "../../shared/math";

/** The reported market end date, without substituting event or settlement dates. */
export function marketDeadlineMs(market: Pick<Market, "state">): number | null {
  const value = market.state.endDate;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
