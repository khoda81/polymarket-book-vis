import "@/styles/global.css";
import { PolymarketCPV } from "./component";
import { createPublicClient, Event } from "@polymarket/client";

const grid = document.getElementById("grid")!;
const addEventForm = document.getElementById("add-event-form") as HTMLFormElement;
const eventSlugInput = document.getElementById("event-slug") as HTMLInputElement;
const addEventStatus = document.getElementById("add-event-status")!;
const addEventButton = addEventForm.querySelector("button")!;
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
