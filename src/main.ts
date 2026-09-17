import "@/styles/global.css";
import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  subscribeAgeStripTuning,
  type AgeStripTuning,
} from "./ageStrips";
import { PolymarketCPV } from "./component";
import { fmtRelativeTime, fmtVol } from "./lib/math";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "./lib/signedVolume";
import {
  getGlobalShareReferenceShares,
  subscribeGlobalShareReferenceShares,
} from "./lib/webglPressure";
import { createPublicClient, Event } from "@polymarket/client";

const MIN_SHARE_LEGEND_TICK_DISTANCE_PX = 48;
const NICE_TICK_FAMILIES = [1, 5, 2] as const;
const TICK_EXPONENT_RADIUS = 12;

const grid = document.getElementById("grid")!;
const addEventForm = document.getElementById("add-event-form") as HTMLFormElement;
const eventSlugInput = document.getElementById("event-slug") as HTMLInputElement;
const addEventStatus = document.getElementById("add-event-status")!;
const addEventButton = addEventForm.querySelector("button")!;
const recorderStatus = document.getElementById("recorder-status")!;
const recorderStatusText = document.getElementById("recorder-status-text")!;
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
    void refreshRecorderStatus();
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
 * Share pressure is linear in cumulative shares:
 *
 *   h(p) = |Q(p)| / D,   D = V + C
 *
 * where V is the largest cumulative share depth currently represented by the
 * shared renderer and C is the user-controlled share reserve. Because D is one
 * constant across price and across charts, signed legend ticks can be literal
 * shares and normalized shape area retains its share×price interpretation.
 */
function renderVolumeLegend(tuning: Readonly<AgeStripTuning>): void {
  const reserveShares = tuning.volumePerCssPixel * AGE_ROW_BAND_PX;
  const referenceShares = getGlobalShareReferenceShares();
  const scaleShares = referenceShares + reserveShares;
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
    `reserve ${fmtVol(reserveShares)} shares · scale ${fmtVol(scaleShares)} shares`;

  const values = shareLegendTickValues(
    referenceShares,
    scaleShares,
    volumeLegendBar.clientWidth,
  );
  volumeLegendTicks.replaceChildren();
  for (const value of values) {
    const tick = document.createElement("span");
    tick.style.left = `${shareLegendPosition(value, scaleShares) * 100}%`;
    tick.textContent = formatShareTick(value);
    volumeLegendTicks.appendChild(tick);
  }
}

function shareLegendPosition(value: number, scaleShares: number): number {
  if (!(scaleShares > 0) || !Number.isFinite(scaleShares)) return 0.5;
  const signed = Math.max(-1, Math.min(1, value / scaleShares));
  return 0.5 + 0.5 * signed;
}

/** Select symmetric, literal-share ticks using the old QBar-style priorities. */
function shareLegendTickValues(
  referenceShares: number,
  scaleShares: number,
  widthPx: number,
): number[] {
  if (
    !(referenceShares > 0) ||
    !Number.isFinite(referenceShares) ||
    !(scaleShares > 0) ||
    !Number.isFinite(scaleShares) ||
    !(widthPx > 0)
  )
    return [0];

  const selected: { value: number; x: number }[] = [
    { value: 0, x: widthPx / 2 },
  ];
  const baseExponent = Math.floor(Math.log10(referenceShares));

  for (const multiplier of NICE_TICK_FAMILIES) {
    const magnitudes = Array.from(
      { length: TICK_EXPONENT_RADIUS * 2 + 1 },
      (_, index) =>
        multiplier * 10 ** (baseExponent - TICK_EXPONENT_RADIUS + index),
    )
      .filter((value) => value > 0 && value <= referenceShares)
      .sort((a, b) => b - a);

    for (const magnitude of magnitudes) {
      const pair = [-magnitude, magnitude].map((value) => ({
        value,
        x: shareLegendPosition(value, scaleShares) * widthPx,
      }));
      if (
        Math.abs(pair[1]!.x - pair[0]!.x) <
        MIN_SHARE_LEGEND_TICK_DISTANCE_PX
      )
        continue;

      const fits = pair.every(({ x }) =>
        selected.every(
          (tick) =>
            Math.abs(x - tick.x) >= MIN_SHARE_LEGEND_TICK_DISTANCE_PX,
        ),
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

interface RecorderHealth {
  watchedTokens: number;
  connected: boolean;
  // Optional so a frontend update remains readable while an older recorder
  // process is still running and has not been restarted yet.
  oldestRecordingSinceMs?: number | null;
}

async function refreshRecorderStatus(): Promise<void> {
  try {
    const response = await fetch("/api/recorder/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`recorder returned ${response.status}`);
    const health = (await response.json()) as RecorderHealth;

    if (health.watchedTokens === 0) {
      recorderStatus.dataset.state = "idle";
      recorderStatusText.textContent = "recorder ready · no markets watched";
      return;
    }

    const oldestRecording =
      typeof health.oldestRecordingSinceMs === "number" &&
      Number.isFinite(health.oldestRecordingSinceMs)
        ? `${fmtRelativeTime((Date.now() - health.oldestRecordingSinceMs) / 1000)} oldest recording`
        : "history age unavailable";

    recorderStatus.dataset.state = health.connected ? "live" : "connecting";
    recorderStatusText.textContent = health.connected
      ? `recorder live · ${oldestRecording} · ${health.watchedTokens} markets`
      : `recorder reconnecting · ${oldestRecording}`;
  } catch {
    recorderStatus.dataset.state = "offline";
    recorderStatusText.textContent = "recorder offline";
  }
}

const renderGlobalLegend = () => renderVolumeLegend(getAgeStripTuning());
renderGlobalLegend();
subscribeAgeStripTuning(renderGlobalLegend);
subscribeGlobalShareReferenceShares(renderGlobalLegend);
new ResizeObserver(renderGlobalLegend).observe(volumeLegendBar);
void refreshRecorderStatus();
window.setInterval(() => void refreshRecorderStatus(), 5_000);

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
