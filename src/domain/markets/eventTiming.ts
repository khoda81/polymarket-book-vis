import type { Event } from "@polymarket/client";
import { initialMarketLifecycle } from "./marketLifecycle";
import { marketTimeDisplay, marketTimeMarker } from "./marketDeadline";

export interface EventTimingDisplay {
  readonly text: string;
  readonly title: string;
}

/** Honest compact timing for an open event search result. */
export function eventTimingDisplay(
  event: Pick<Event, "markets" | "sports" | "state">,
  nowMs: number,
): EventTimingDisplay | null {
  const period = event.sports.period?.trim() ?? "";
  const elapsed = event.sports.elapsed?.trim() ?? "";
  if (event.state.live === true && (period || elapsed))
    return {
      text: [period, elapsed ? `${elapsed}′` : ""].filter(Boolean).join(" · "),
      title: "Live match clock reported by Polymarket",
    };

  const markers = event.markets.flatMap((market) => {
    if (initialMarketLifecycle(market).kind !== "live") return [];
    const marker = marketTimeMarker(market);
    return marker === null ? [] : [marker];
  });
  const marker =
    markers
      .filter((candidate) => candidate.timeMs >= nowMs)
      .sort((a, b) => a.timeMs - b.timeMs)[0] ??
    markers
      .filter((candidate) => candidate.timeMs < nowMs)
      .sort((a, b) => b.timeMs - a.timeMs)[0];
  if (!marker) return null;

  const display = marketTimeDisplay(marker, nowMs);
  if (marker.kind === "game-start")
    return { text: display.text, title: "Reported game start" };

  if (marker.timeMs > nowMs)
    return {
      text: `T−${display.text.replace(/^in /, "")}`,
      title: "Time until next reported market end",
    };
  return {
    text: marker.timeMs === nowMs ? "end now" : `end ${display.text}`,
    title: "Time since latest reported market end",
  };
}
