import type { Event } from "@polymarket/client";

declare const eventSlugBrand: unique symbol;
export type EventSlug = string & { readonly [eventSlugBrand]: true };

export type PinState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unpinned"; readonly slug: EventSlug }
  | { readonly kind: "pinned"; readonly slug: EventSlug };

export interface DashboardEntry {
  readonly event: Event;
  readonly announceLifecycle: boolean;
}

export function toEventSlug(value: unknown): EventSlug | null {
  if (typeof value !== "string") return null;
  const slug = value.trim();
  return slug.length > 0 ? (slug as EventSlug) : null;
}

export function eventSlug(event: Event): EventSlug | null {
  return toEventSlug(event.slug);
}

export function eventLabel(event: Event): string {
  return event.title?.trim() || event.slug?.trim() || "event";
}

export function pinState(
  event: Event,
  pinned: readonly EventSlug[],
): PinState {
  const slug = eventSlug(event);
  if (!slug) return { kind: "unavailable" };
  return pinned.includes(slug)
    ? { kind: "pinned", slug }
    : { kind: "unpinned", slug };
}

export function normalizePinnedSlugs(values: readonly unknown[]): EventSlug[] {
  const result: EventSlug[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const slug = toEventSlug(value);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    result.push(slug);
  }
  return result;
}

export function orderEntries(
  entries: readonly DashboardEntry[],
  pinned: readonly EventSlug[],
): DashboardEntry[] {
  const rank = new Map<string, number>(
    pinned.map((slug, index) => [slug, index]),
  );
  const insertion = new Map(
    entries.map((entry, index) => [entry.event.id, index]),
  );

  return [...entries].sort((a, b) => {
    const aSlug = eventSlug(a.event);
    const bSlug = eventSlug(b.event);
    const aRank = aSlug ? rank.get(aSlug) : undefined;
    const bRank = bSlug ? rank.get(bSlug) : undefined;

    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return (insertion.get(a.event.id) ?? 0) - (insertion.get(b.event.id) ?? 0);
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
