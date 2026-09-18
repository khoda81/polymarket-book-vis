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
const eventSlugInput = document.getElementById("event-slug") as HTMLInputElement;
const addEventStatus = document.getElementById("add-event-status")!;
const addEventButton = addEventForm.querySelector("button")!;
const volumeLegendBar = document.getElementById("volume-legend-bar")!;
const volumeLegendTicks = document.getElementById("volume-legend-ticks")!;
const volumeLegendScale = document.getElementById("volume-legend-scale")!;
const client = createPublicClient();
const cards = new Map<string, { card: HTMLElement; chart: PolymarketCPV }>();

async function createCard(event: Event) {
  const existing = cards.get(event.id);
  if (existing) {
    existing.card.scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  }

  const card = document.createElement("article");
  card.classList.add("card");
  const chartHost = document.createElement("div");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "card-close";
  closeButton.setAttribute("aria-label", `Remove ${event.title ?? "event"}`);
  closeButton.title = "Remove event from dashboard";
  closeButton.textContent = "×";
  closeButton.disabled = true;

  card.append(closeButton, chartHost);
  grid.prepend(card);
  const chart = new PolymarketCPV(chartHost, client);
  cards.set(event.id, { card, chart });

  closeButton.addEventListener("click", () => {
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

async function addEventBySlug(slug: string, announce = true) {
  const normalized = slug.trim();
  if (!normalized) return;

  if (announce) addEventStatus.textContent = `Loading ${normalized}…`;
  const event = await client.fetchEvent({ slug: normalized });
  const added = await createCard(event);

  if (announce) {
    addEventStatus.textContent = added
      ? `Added ${event.title ?? normalized}.`
      : `${event.title ?? normalized} is already on the dashboard.`;
    if (added) eventSlugInput.value = "";
  }
}

addEventForm.addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  addEventButton.disabled = true;
  try {
    await addEventBySlug(eventSlugInput.value);
  } catch (error) {
    addEventStatus.textContent = `Could not add event: ${errorMessage(error)}`;
  } finally {
    addEventButton.disabled = false;
  }
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

const eventSlugs = ["israel-closes-its-airspace-by"];

for (const slug of eventSlugs)
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
  eventPage.items.forEach((e) => {
    if (!eventSlugs.includes(e.slug ?? ""))
      void createCard(e).catch((error) =>
        console.error(`Could not load ${e.slug ?? e.id}:`, error),
      );
  });
}
