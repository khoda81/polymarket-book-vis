import "@/styles/global.css";
import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  subscribeAgeStripTuning,
  type AgeStripTuning,
} from "./ageStrips";
import { PolymarketCPV } from "./component";
import { fmtVol } from "./lib/math";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "./lib/signedVolume";
import { createPublicClient, Event } from "@polymarket/client";

const MIN_SHARE_LEGEND_TICK_DISTANCE_PX = 48;
const NICE_TICK_FAMILIES = [1, 5, 2] as const;
const TICK_EXPONENT_RADIUS = 12;

const grid = document.getElementById("grid")!;
const addEventForm = document.getElementById("add-event-form") as HTMLFormElement;
const eventSearchInput = document.getElementById("event-search") as HTMLInputElement;
const eventSearchResults = document.getElementById("event-search-results")!;
const addEventStatus = document.getElementById("add-event-status")!;
const volumeLegendBar = document.getElementById("volume-legend-bar")!;
const volumeLegendTicks = document.getElementById("volume-legend-ticks")!;
const volumeLegendScale = document.getElementById("volume-legend-scale")!;
const client = createPublicClient();
const cards = new Map<
  string,
  {
    card: HTMLElement;
    chart: PolymarketCPV;
    pinButton: HTMLButtonElement;
    eventSlug: string | null;
  }
>();
const PINNED_EVENT_SLUGS_STORAGE_KEY =
  "polymarket-book-vis:pinned-event-slugs:v1";
const DEFAULT_EVENT_SLUGS = ["israel-closes-its-airspace-by"] as const;
const pinnedEventSlugs = loadStringSet(PINNED_EVENT_SLUGS_STORAGE_KEY);

let eventSearchTimeout: number | undefined;
let eventSearchGeneration = 0;
let eventSearchMatches: Event[] = [];
let highlightedSearchIndex = 0;

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistStringSet(key: string, values: ReadonlySet<string>): void {
  localStorage.setItem(key, JSON.stringify([...values]));
}

type PinPlacement = "start" | "end";

function setPinnedEventSlug(
  slug: string,
  pinned: boolean,
  placement: PinPlacement = "end",
): void {
  const ordered = [...pinnedEventSlugs].filter((candidate) => candidate !== slug);
  if (pinned) {
    if (placement === "start") ordered.unshift(slug);
    else ordered.push(slug);
  }

  pinnedEventSlugs.clear();
  for (const candidate of ordered) pinnedEventSlugs.add(candidate);
  persistStringSet(PINNED_EVENT_SLUGS_STORAGE_KEY, pinnedEventSlugs);
}

function renderPinButton(
  button: HTMLButtonElement,
  card: HTMLElement,
  eventSlug: string | null,
): void {
  const pinned = eventSlug !== null && pinnedEventSlugs.has(eventSlug);
  button.setAttribute("aria-pressed", String(pinned));
  button.setAttribute(
    "aria-label",
    pinned ? "Unpin event" : "Pin event across reloads",
  );
  button.title = pinned
    ? "Pinned — click to stop restoring this event on reload"
    : "Pin this event so it returns after reload";
  button.textContent = pinned ? "★" : "☆";
  card.classList.toggle("card--pinned", pinned);
}

function placeCard(card: HTMLElement, pinned: boolean): void {
  // Remove before classifying so the card itself cannot be mistaken for the
  // first member of its destination partition.
  card.remove();
  card.classList.toggle("card--pinned", pinned);

  if (pinned) {
    const slug = card.dataset.eventSlug ?? "";
    const order = [...pinnedEventSlugs];
    const rank = order.indexOf(slug);

    // Preserve the user's pin order regardless of which async event load
    // finishes first.
    const nextPinned = Array.from(grid.children).find((child) => {
      if (!child.classList.contains("card--pinned")) return false;
      const childSlug = (child as HTMLElement).dataset.eventSlug ?? "";
      const childRank = order.indexOf(childSlug);
      return childRank >= 0 && (rank < 0 || childRank > rank);
    });
    if (nextPinned) {
      grid.insertBefore(card, nextPinned);
      return;
    }

    // No later pinned card exists: append to the pinned prefix.
    const firstUnpinned = Array.from(grid.children).find(
      (child) => !child.classList.contains("card--pinned"),
    );
    if (firstUnpinned) grid.insertBefore(card, firstUnpinned);
    else grid.appendChild(card);
    return;
  }

  // Unpinned cards start immediately after the pinned prefix.
  const firstUnpinned = Array.from(grid.children).find(
    (child) => !child.classList.contains("card--pinned"),
  );
  if (firstUnpinned) grid.insertBefore(card, firstUnpinned);
  else grid.appendChild(card);
}


async function createCard(event: Event) {
  const existing = cards.get(event.id);
  if (existing) {
    renderPinButton(existing.pinButton, existing.card, existing.eventSlug);
    placeCard(
      existing.card,
      existing.eventSlug !== null && pinnedEventSlugs.has(existing.eventSlug),
    );
    existing.card.scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  }

  const card = document.createElement("article");
  card.classList.add("card");
  const eventSlug = event.slug?.trim() || null;
  card.dataset.eventSlug = eventSlug ?? "";
  const chartHost = document.createElement("div");

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const viewSelect = document.createElement("select");
  viewSelect.className = "card-view";
  viewSelect.setAttribute("aria-label", "Visualization mode");
  for (const mode of ["age", "volume"] as const) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    viewSelect.appendChild(option);
  }

  const pinButton = document.createElement("button");
  pinButton.type = "button";
  pinButton.className = "card-pin";
  pinButton.disabled = eventSlug === null;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "card-close";
  closeButton.setAttribute("aria-label", `Remove ${event.title ?? "event"}`);
  closeButton.title = "Remove event from dashboard";
  closeButton.textContent = "×";
  closeButton.disabled = true;

  renderPinButton(pinButton, card, eventSlug);

  pinButton.addEventListener("click", () => {
    if (eventSlug === null) return;
    const willPin = !pinnedEventSlugs.has(eventSlug);
    setPinnedEventSlug(eventSlug, willPin, "end");
    renderPinButton(pinButton, card, eventSlug);
    placeCard(card, willPin);
  });

  actions.append(viewSelect, pinButton, closeButton);
  card.append(actions, chartHost);
  placeCard(card, eventSlug !== null && pinnedEventSlugs.has(eventSlug));

  const chart = new PolymarketCPV(chartHost, client);
  viewSelect.addEventListener("change", () =>
    chart.setViewMode(viewSelect.value as "age" | "volume"),
  );
  cards.set(event.id, { card, chart, pinButton, eventSlug });

  closeButton.addEventListener("click", () => {
    if (eventSlug !== null && pinnedEventSlugs.has(eventSlug))
      setPinnedEventSlug(eventSlug, false);

    chart.destroy();
    cards.delete(event.id);
    card.remove();
    addEventStatus.textContent = `Removed ${event.title ?? event.slug ?? "event"}.`;
  });

  try {
    await chart.load(event);
    closeButton.disabled = false;
    return true;
  } catch (error) {
    chart.destroy();
    cards.delete(event.id);
    card.remove();
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function addEvent(event: Event, announce = true): Promise<boolean> {
  if (announce)
    addEventStatus.textContent = `Loading ${event.title ?? event.slug ?? "event"}…`;

  // Events explicitly added through the search box are intentional dashboard
  // choices: pin them and put them first. Clicking ★ on an existing card uses
  // the opposite policy and appends it to the end of the pinned group.
  const eventSlug = event.slug?.trim() || null;
  if (announce && eventSlug) setPinnedEventSlug(eventSlug, true, "start");

  const added = await createCard(event);
  if (announce) {
    addEventStatus.textContent = added
      ? `Added ${event.title ?? event.slug ?? "event"}.`
      : `${event.title ?? event.slug ?? "event"} is already on the dashboard.`;
    if (added) {
      eventSearchInput.value = "";
      hideEventSearchResults();
    }
  }
  return added;
}

async function addEventBySlug(slug: string, announce = true): Promise<boolean> {
  const normalized = slug.trim();
  if (!normalized) return false;
  if (announce) addEventStatus.textContent = `Loading ${normalized}…`;

  const event = await client.fetchEvent({ slug: normalized });
  return addEvent(event, announce);
}

function hideEventSearchResults(): void {
  eventSearchResults.style.display = "none";
  eventSearchInput.setAttribute("aria-expanded", "false");
}

function showEventSearchResults(): void {
  eventSearchResults.style.display = "block";
  eventSearchInput.setAttribute("aria-expanded", "true");
}

function eventVolume(event: Event): number {
  const raw = event.metrics.volume;
  const value = raw ? Number.parseFloat(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

function renderEventSearchResults(): void {
  eventSearchResults.replaceChildren();

  for (const [index, event] of eventSearchMatches.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "dashboard-search-result";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === highlightedSearchIndex));

    const title = document.createElement("span");
    title.className = "dashboard-search-result-title";
    title.textContent = event.title ?? "(untitled)";

    const meta = document.createElement("span");
    meta.className = "dashboard-search-result-meta";

    const slug = document.createElement("span");
    slug.className = "dashboard-search-result-slug";
    slug.textContent = event.slug ?? event.id;

    const volume = document.createElement("span");
    volume.className = "dashboard-search-result-volume";
    volume.textContent = `$${fmtVol(eventVolume(event))}`;

    meta.append(slug, volume);
    option.append(title, meta);

    option.addEventListener("pointerenter", () => {
      if (highlightedSearchIndex === index) return;
      highlightedSearchIndex = index;
      renderEventSearchResults();
    });
    option.addEventListener("click", () => {
      void chooseEventSearchResult(index);
    });

    eventSearchResults.appendChild(option);
  }

  if (eventSearchMatches.length) showEventSearchResults();
  else hideEventSearchResults();
}

async function chooseEventSearchResult(index: number): Promise<void> {
  const event = eventSearchMatches[index];
  if (!event) return;

  eventSearchGeneration++;
  clearTimeout(eventSearchTimeout);
  hideEventSearchResults();

  try {
    await addEvent(event);
  } catch (error) {
    addEventStatus.textContent = `Could not add event: ${errorMessage(error)}`;
  }
}

async function runEventSearch(query: string, generation: number): Promise<void> {
  try {
    const search = client.search({ q: query, pageSize: 12 });
    const page = await search.firstPage();
    if (generation !== eventSearchGeneration) return;

    eventSearchMatches = page.items.events;
    highlightedSearchIndex = 0;
    renderEventSearchResults();
  } catch (error) {
    if (generation !== eventSearchGeneration) return;
    eventSearchMatches = [];
    hideEventSearchResults();
    addEventStatus.textContent = `Search failed: ${errorMessage(error)}`;
  }
}

function scheduleEventSearch(): void {
  clearTimeout(eventSearchTimeout);
  const query = eventSearchInput.value.trim();
  const generation = ++eventSearchGeneration;

  if (!query) {
    eventSearchMatches = [];
    hideEventSearchResults();
    return;
  }

  eventSearchTimeout = window.setTimeout(() => {
    void runEventSearch(query, generation);
  }, 200);
}

function looksLikeExactSlug(query: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(query);
}

async function submitEventSearch(): Promise<void> {
  const query = eventSearchInput.value.trim();
  if (!query) return;

  const exactMatch = eventSearchMatches.find((event) => event.slug === query);
  if (exactMatch) {
    await addEvent(exactMatch);
    return;
  }

  if (looksLikeExactSlug(query)) {
    try {
      await addEventBySlug(query);
      return;
    } catch {
      // A slug-looking free-text query may still be a useful search query.
      // Fall through to the highlighted search result when available.
    }
  }

  const highlighted = eventSearchMatches[highlightedSearchIndex];
  if (highlighted) {
    await addEvent(highlighted);
    return;
  }

  await addEventBySlug(query);
}

eventSearchInput.addEventListener("input", scheduleEventSearch);
eventSearchInput.addEventListener("focus", () => {
  if (eventSearchMatches.length) showEventSearchResults();
});
eventSearchInput.addEventListener("keydown", (event) => {
  if (!eventSearchMatches.length) {
    if (event.key === "Escape") hideEventSearchResults();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightedSearchIndex =
      (highlightedSearchIndex + 1) % eventSearchMatches.length;
    renderEventSearchResults();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightedSearchIndex =
      (highlightedSearchIndex - 1 + eventSearchMatches.length) %
      eventSearchMatches.length;
    renderEventSearchResults();
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideEventSearchResults();
  }
});

addEventForm.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  void submitEventSearch().catch((error) => {
    addEventStatus.textContent = `Could not add event: ${errorMessage(error)}`;
  });
});

document.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest(".dashboard-search"))
    hideEventSearchResults();
});

/**
 * Share pressure uses the local soft ratio
 *
 *   h(Q) = |Q| / (|Q| + C)
 *
 * where C is the share reserve. Literal share ticks are placed through the
 * same transform, so Ctrl-scroll zooms both the rendered bars and legend.
 */
function renderVolumeLegend(tuning: Readonly<AgeStripTuning>): void {
  const reserveShares = tuning.volumePerCssPixel * AGE_ROW_BAND_PX;
  const scale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE;

  volumeLegendBar.style.setProperty(
    "--negative-pressure-color",
    signedVolumeColor(-1, scale),
  );
  volumeLegendBar.style.setProperty(
    "--positive-pressure-color",
    signedVolumeColor(1, scale),
  );
  volumeLegendScale.textContent =
    `reserve ${fmtVol(reserveShares)} shares · Q=C → 50% row`;

  const values = shareLegendTickValues(
    reserveShares,
    volumeLegendBar.clientWidth,
  );
  volumeLegendTicks.replaceChildren();
  for (const value of values) {
    const tick = document.createElement("span");
    tick.style.left = `${shareLegendPosition(value, reserveShares) * 100}%`;
    tick.textContent = formatShareTick(value);
    volumeLegendTicks.appendChild(tick);
  }
}

function shareLegendPosition(value: number, reserveShares: number): number {
  if (!(reserveShares > 0) || !Number.isFinite(reserveShares)) return 0.5;
  if (Number.isNaN(value) || value === 0) return 0.5;
  const signed = Number.isFinite(value)
    ? value / (Math.abs(value) + reserveShares)
    : Math.sign(value);
  return 0.5 + 0.5 * signed;
}

/** Select symmetric literal-share ticks on the soft share scale. */
function shareLegendTickValues(
  reserveShares: number,
  widthPx: number,
): number[] {
  if (!(reserveShares > 0) || !Number.isFinite(reserveShares)) return [0];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [0];

  const minDistance = MIN_SHARE_LEGEND_TICK_DISTANCE_PX;
  const edgePadding = minDistance / 2;
  const selected: { value: number; x: number }[] = [
    { value: 0, x: widthPx / 2 },
  ];

  const maxSigned = Math.max(
    0,
    Math.min(1 - Number.EPSILON, 1 - (2 * edgePadding) / widthPx),
  );
  if (!(maxSigned > 0)) return [0];
  const maxMagnitude = reserveShares * maxSigned / (1 - maxSigned);
  const baseExponent = Math.floor(Math.log10(maxMagnitude));

  for (const multiplier of NICE_TICK_FAMILIES) {
    const magnitudes = Array.from(
      { length: TICK_EXPONENT_RADIUS * 2 + 1 },
      (_, index) =>
        multiplier * 10 ** (baseExponent - TICK_EXPONENT_RADIUS + index),
    )
      .filter((value) => value > 0 && value <= maxMagnitude)
      .sort((a, b) => b - a);

    for (const magnitude of magnitudes) {
      const pair = [-magnitude, magnitude].map((value) => ({
        value,
        x: shareLegendPosition(value, reserveShares) * widthPx,
      }));

      if (
        pair.some(
          ({ x }) => x < edgePadding || x > widthPx - edgePadding,
        ) ||
        Math.abs(pair[1]!.x - pair[0]!.x) < minDistance
      )
        continue;

      const fits = pair.every(({ x }) =>
        selected.every((tick) => Math.abs(x - tick.x) >= minDistance),
      );
      if (fits) selected.push(...pair);
    }
  }

  return selected
    .sort((a, b) => a.value - b.value)
    .map(({ value }) => value);
}

function formatShareTick(value: number): string {
  if (value === 0) return "0";
  const magnitude = fmtVol(Math.abs(value)).replace(/\.0([KMB]?)$/, "$1");
  return `${value > 0 ? "+" : "−"}${magnitude}`;
}

const renderGlobalLegend = () => renderVolumeLegend(getAgeStripTuning());
renderGlobalLegend();
subscribeAgeStripTuning(renderGlobalLegend);
new ResizeObserver(renderGlobalLegend).observe(volumeLegendBar);

const startupSlugs = [
  ...new Set([...DEFAULT_EVENT_SLUGS, ...pinnedEventSlugs]),
];

for (const slug of startupSlugs)
  void addEventBySlug(slug, false).catch((error) =>
    console.error(`Could not load ${slug}:`, error),
  );

const extraEvents = client.listEvents({
  // featured: true,
  volumeMin: 10000,
  titleSearch: "iran",
});

// TODO: Sort by amount of update in terms of entropy computed from transaction history of consecutive transaction prices.
// TODO: For each two transactions with (p0, t0) -> (p1, t1), compute the kl divergence between p0 and p1 and divide by the delta t:
// TODO: kl(p0, p1) / (t1 - t0)
// And we need to do this for all consecutive transactions given the market's transaction history since a given timestamp till now.
for await (const eventPage of extraEvents) {
  for (const event of eventPage.items) {
    if (startupSlugs.includes(event.slug ?? "")) continue;
    // Event cards are independent. Do not make a slow Gamma/subscription load
    // gate unrelated cards; startup discovery should fan out immediately.
    void createCard(event).catch((error) =>
      console.error(`Could not load ${event.slug ?? event.id}:`, error),
    );
  }
}
