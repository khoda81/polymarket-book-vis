import "@/styles/global.css";
import { PolymarketCPV } from "./component";
import { createPublicClient, Event } from "@polymarket/client";

const grid = document.getElementById("grid")!;

async function createCard(event: Event) {
  const card = document.createElement("div")!;
  card.classList.add("card");
  const chart = new PolymarketCPV(card);
  await chart.load(event);

  grid.appendChild(card);
}

const client = createPublicClient();
const events = [
  client.fetchEvent({
    slug: "claude-fable-5-restored-for-us-customers-by-20260613193753196",
  }),
  client.fetchEvent({
    slug: "israel-closes-its-airspace-by",
  }),
];

events.forEach(async (e) => createCard(await e));

const extraEvents = client.listEvents({
  featured: true,
  volumeMin: 1000000,
  titleSearch: "iran",
});

for await (const eventPage of extraEvents) {
  const events = eventPage.items;
  events.forEach(async (e) => createCard(e));
}
