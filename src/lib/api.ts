export interface GammaMarket {
  closed: boolean;
  clobTokenIds: string[];
  endDate: string;
  groupItemTitle: string;
}

export interface GammaEvent {
  title: string;
  slug: string;
  markets: GammaMarket[];
}

export interface SearchSuggestion {
  title: string;
  slug: string;
  volume?: string;
}

export async function fetchSearchSuggestions(
  query: string,
): Promise<SearchSuggestion[]> {
  if (!query) return [];
  try {
    const r = await fetch(
      `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}&limit_per_type=20`,
    );
    if (!r.ok) return [];
    const items = await r.json();
    return items.events ?? [];
  } catch {
    return [];
  }
}

export async function fetchEventBySlug(slug: string): Promise<GammaEvent> {
  const r = await fetch(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
  );
  if (!r.ok) throw new Error(`Gamma API returned ${r.status}`);
  const events: GammaEvent[] = await r.json();
  if (!events.length) throw new Error("Event not found");
  const event = events[0];
  // The API returns clobTokenIds as a JSON string, e.g. '["123","456"]'
  for (const market of event.markets) {
    if (typeof market.clobTokenIds === "string") {
      market.clobTokenIds = JSON.parse(market.clobTokenIds);
    }
  }
  return event;
}
