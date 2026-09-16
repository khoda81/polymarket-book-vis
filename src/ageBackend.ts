import { HalfBook, type TokenBook } from "@/lib/orderBook";
import type { AgeSegment } from "@/lib/spreadAge";
import type { Event, TokenId } from "@polymarket/client";
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

/**
 * Register markets with the always-on age collector and seed local age state
 * before the first live order-book update is processed.
 *
 * Historical signed volume is intentionally not fabricated. Replayed spreads
 * use near-zero synthetic depth, so prices whose age comes from the backend
 * start visually neutral. The real Polymarket book immediately overwrites all
 * currently constrained regions; subsequent spread movement fills historical
 * colors naturally from live data.
 */
export function installAgeBackend(chart: PolymarketCPV): void {
  const component = chart as unknown as {
    books: Record<string, TokenBook<string>>;
    load(event: Event): Promise<void>;
    updateSpreadAge(tokenId: TokenId, nowMs: number): void;
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

  const originalUpdateSpreadAge = component.updateSpreadAge.bind(component);
  component.updateSpreadAge = (tokenId: TokenId, nowMs: number) => {
    const id = tokenId as string;
    const bootstrap = pending.get(id);

    if (bootstrap && !seeded.has(id)) {
      seeded.add(id);
      pending.delete(id);
      replayAgeTower(component, originalUpdateSpreadAge, id, bootstrap);
    }

    originalUpdateSpreadAge(tokenId, nowMs);
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
    // The visualization remains fully functional without the collector; it
    // simply starts age recording from this page load as before.
    return null;
  }
}

function replayAgeTower(
  component: { books: Record<string, TokenBook<string>> },
  update: (tokenId: TokenId, nowMs: number) => void,
  tokenId: string,
  bootstrap: PendingBootstrap,
): void {
  const segments = [...bootstrap.state.segments]
    .filter(validAgeSegment)
    .sort((a, b) => a.sinceMs - b.sinceMs || a.lo - b.lo);
  if (segments.length === 0) return;

  const realBook = component.books[tokenId];
  if (!realBook) return;

  const timestamps = [...new Set(segments.map((segment) => segment.sinceMs))]
    .sort((a, b) => a - b);

  try {
    for (const timestamp of timestamps) {
      const surviving = segments.filter((segment) => segment.sinceMs <= timestamp);
      const bid = Math.min(...surviving.map((segment) => segment.lo));
      const ask = Math.max(...surviving.map((segment) => segment.hi));
      const localTimestamp =
        bootstrap.receivedAtLocalMs - (bootstrap.serverNowMs - timestamp);

      component.books[tokenId] = syntheticBook(bid, ask);
      update(tokenId as TokenId, localTimestamp);
    }
  } finally {
    component.books[tokenId] = realBook;
  }
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

function marketResolutionTimestamp(market: Event["markets"][number]): number | undefined {
  const value = (market as unknown as Record<string, unknown>).endDateIso ??
    (market as unknown as Record<string, unknown>).endDate;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
