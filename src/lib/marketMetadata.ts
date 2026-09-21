import type { Event } from "@polymarket/client";

export function indexRawMarketsById(
  rawMarkets: readonly unknown[],
): Map<string, unknown> {
  const indexed = new Map<string, unknown>();
  for (const rawMarket of rawMarkets) {
    const record = asRecord(rawMarket);
    if (record?.id !== undefined) indexed.set(String(record.id), rawMarket);
  }
  return indexed;
}

export function resolutionOrder(
  event: Event,
  rawMarkets: readonly unknown[],
): Map<string, number> {
  const rawById = indexRawMarketsById(rawMarkets);

  const sorted = event.markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionTimestamp(rawById.get(String(market.id)), market),
    }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.timestamp);
      const bKnown = Number.isFinite(b.timestamp);
      if (aKnown && bKnown)
        return a.timestamp - b.timestamp || a.originalIndex - b.originalIndex;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const order = new Map<string, number>();
  for (const [index, { market }] of sorted.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) order.set(String(tokenId), index);
  }
  return order;
}

export function resolutionTimestamp(...sources: readonly unknown[]): number {
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;
    const state = asRecord(record.state);

    for (const candidate of [
      state?.endDate,
      state?.end_date,
      record.endDate,
      record.endDateIso,
      record.end_date,
      record.end_date_iso,
    ]) {
      if (candidate instanceof Date) return candidate.getTime();
      if (typeof candidate === "number" && Number.isFinite(candidate))
        return candidate;
      if (typeof candidate === "string") {
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return Infinity;
}

export function sameDisplayTitle(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return normalizeDisplayTitle(a) === normalizeDisplayTitle(b);
}

function normalizeDisplayTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
