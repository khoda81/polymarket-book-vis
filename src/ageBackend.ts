import { HalfBook, type TokenBook } from "@/lib/orderBook";
import type { AgeSegment } from "@/lib/spreadAge";
import { StaleSignedVolume } from "@/lib/staleSignedVolume";
import type { Event } from "@polymarket/client";
import type { PolymarketCPV } from "./component";

const BOOTSTRAP_TIMEOUT_MS = 500;
const UNKNOWN_VOLUME = 1e-12;

interface BackendAgeState {
  readonly tokenId: string;
  readonly bid: number;
  readonly ask: number;
  readonly observedAtMs: number;
  readonly segments: readonly AgeSegment[];
}

interface BackendAgeResponse {
  readonly serverNowMs: number;
  readonly states: readonly BackendAgeState[];
}

interface PendingBootstrap {
  readonly serverNowMs: number;
  readonly receivedAtLocalMs: number;
  readonly state: BackendAgeState;
}

interface AgeMarketRuntimeState {
  readonly field: StaleSignedVolume;
  lastUpdateMs: number;
  visibilityInitialized: boolean;
}

interface AgeViewRuntime {
  markets: Map<string, AgeMarketRuntimeState>;
  onBookUpdate(tokenId: string, nowMs: number): void;
}

/**
 * Register markets with the always-on collector and seed the cleaned age-view
 * state before each token's first real book update.
 *
 * The backend stores only spread-age timestamps. Historical signed volume is
 * deliberately unknown: bootstrap replays the surviving spread history with
 * effectively-neutral depth. The first real Polymarket book then overwrites
 * every currently constrained region, while old in-spread regions retain the
 * correct opacity and a neutral historical color until live motion teaches us
 * their force naturally.
 */
export function installAgeBackend(chart: PolymarketCPV): void {
  const component = chart as unknown as {
    books: Record<string, TokenBook<string>>;
    ageView: AgeViewRuntime;
    load(event: Event): Promise<void>;
  };

  const pending = new Map<string, PendingBootstrap>();
  const seeded = new Set<string>();

  const originalLoad = component.load.bind(component);
  component.load = async (event: Event) => {
    pending.clear();
    seeded.clear();

    const response = await bootstrapEvent(event);
    if (response) {
      const receivedAtLocalMs = performance.now();
      for (const state of response.states)
        pending.set(state.tokenId, {
          serverNowMs: response.serverNowMs,
          receivedAtLocalMs,
          state,
        });
    }

    await originalLoad(event);
  };

  const originalOnBookUpdate = component.ageView.onBookUpdate.bind(
    component.ageView,
  );
  component.ageView.onBookUpdate = (tokenId: string, nowMs: number) => {
    const bootstrap = pending.get(tokenId);
    if (bootstrap && !seeded.has(tokenId)) {
      seeded.add(tokenId);
      pending.delete(tokenId);
      seedAgeField(component.ageView, tokenId, nowMs, bootstrap);
    }

    originalOnBookUpdate(tokenId, nowMs);
  };
}

async function bootstrapEvent(event: Event): Promise<BackendAgeResponse | null> {
  const tokens = event.markets.flatMap((market) => {
    if (!market.state.active || !market.outcomes.yes.tokenId) return [];
    return [{
      tokenId: market.outcomes.yes.tokenId as string,
      eventId: event.id,
      marketId: market.id,
      question: market.question,
      resolutionAtMs: marketResolutionTimestamp(market),
    }];
  });

  if (tokens.length === 0) return null;

  try {
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as BackendAgeResponse;
  } catch {
    // Backend is optional. Without it we retain the previous local-only
    // behavior and start age recording from this page load.
    return null;
  }
}

function seedAgeField(
  ageView: AgeViewRuntime,
  tokenId: string,
  firstLiveUpdateMs: number,
  bootstrap: PendingBootstrap,
): void {
  const segments = [...bootstrap.state.segments]
    .filter(validAgeSegment)
    .sort((a, b) => a.sinceMs - b.sinceMs || a.lo - b.lo);
  if (segments.length === 0) return;

  const field = new StaleSignedVolume();
  const timestamps = [...new Set(segments.map((segment) => segment.sinceMs))]
    .sort((a, b) => a - b);

  for (const timestamp of timestamps) {
    const surviving = segments.filter((segment) => segment.sinceMs <= timestamp);
    const bid = Math.min(...surviving.map((segment) => segment.lo));
    const ask = Math.max(...surviving.map((segment) => segment.hi));
    const localTimestamp =
      bootstrap.receivedAtLocalMs - (bootstrap.serverNowMs - timestamp);
    field.update(syntheticBook(bid, ask), localTimestamp);
  }

  ageView.markets.set(tokenId, {
    field,
    lastUpdateMs: firstLiveUpdateMs,
    // Let the normal real-book update decide whether this market is empty and
    // should start hidden. Synthetic bootstrap liquidity must not affect that.
    visibilityInitialized: false,
  });
}

function syntheticBook(bid: number, ask: number): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  if (bid > 0)
    usdToYes.setLevel("age-seed-bid", { price: bid, take: UNKNOWN_VOLUME });

  const yesToUsd = new HalfBook<string>();
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });
  if (ask < 1) {
    const inverse = ask === 0 ? Infinity : 1 / ask;
    yesToUsd.setLevel("age-seed-ask", {
      price: inverse,
      take: ask === 0 ? UNKNOWN_VOLUME : UNKNOWN_VOLUME * ask,
    });
  }

  return { usdToYes, yesToUsd };
}

function validAgeSegment(segment: AgeSegment): boolean {
  return (
    Number.isFinite(segment.lo) &&
    Number.isFinite(segment.hi) &&
    Number.isFinite(segment.sinceMs) &&
    segment.lo >= 0 &&
    segment.hi <= 1 &&
    segment.lo <= segment.hi
  );
}

function marketResolutionTimestamp(
  market: Event["markets"][number],
): number | undefined {
  const record = market as unknown as Record<string, unknown>;
  const value = record.endDateIso ?? record.endDate;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
