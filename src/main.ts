import "@/styles/global.css";
import { PolymarketCPV } from "./component";
import { createPublicClient, Event } from "@polymarket/client";

const grid = document.getElementById("grid")!;
const client = createPublicClient();

function createCard(event: Event) {
  const card = document.createElement("div")!;
  card.classList.add("card");
  const chart = new PolymarketCPV(card, client);
  grid.appendChild(card);

  chart.load(event);
}

const events = [
  "claude-fable-5-restored-for-us-customers-by-20260613193753196",
  "israel-closes-its-airspace-by",
];

events.forEach(async (slug) => createCard(await client.fetchEvent({ slug })));

const extraEvents = client.listEvents({
  featured: true,
  volumeMin: 1000000,
  titleSearch: "iran",
});

for await (const eventPage of extraEvents) {
  const events = eventPage.items;
  events.forEach((e) => createCard(e));
}
