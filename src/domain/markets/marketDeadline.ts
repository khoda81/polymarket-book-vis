import type { Market } from "@polymarket/client";
import type { RelativeTimeDisplay } from "../../shared/math";

const DEADLINE_UNITS = [
  { ms: 1_000, suffix: "s", min: 1_000, max: 60_000 },
  { ms: 60_000, suffix: "m", min: 60_000, max: 3_600_000 },
  { ms: 3_600_000, suffix: "h", min: 3_600_000, max: 86_400_000 },
  { ms: 86_400_000, suffix: "d", min: 86_400_000, max: Infinity },
] as const;

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
  const magnitudeMs = Math.abs(remainingMs);
  if (magnitudeMs < 1_000)
    return { text: "now", nextChangeMs: Math.max(1, 1_000 + remainingMs) };

  const unit = DEADLINE_UNITS.find((candidate) => magnitudeMs < candidate.max)!;
  const quantumMs =
    unit.ms *
    10 ** Math.max(-1, Math.floor(Math.log10(magnitudeMs / unit.ms)) - 1);
  const ticks =
    remainingMs > 0
      ? Math.ceil(magnitudeMs / quantumMs)
      : Math.floor(magnitudeMs / quantumMs);
  const value = Number(((ticks * quantumMs) / unit.ms).toFixed(1));
  const duration = `${value}${unit.suffix}`;
  const nextChangeMs =
    remainingMs > 0
      ? magnitudeMs - Math.max(unit.min, (ticks - 1) * quantumMs)
      : Math.min((ticks + 1) * quantumMs, unit.max) - magnitudeMs;

  return {
    text: remainingMs > 0 ? `in ${duration}` : `${duration} ago`,
    nextChangeMs: Math.max(1, nextChangeMs),
  };
}
