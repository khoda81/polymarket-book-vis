import "@/styles/global.css";
import { PolymarketCPV } from "./component";
import { createPublicClient } from "@polymarket/client";

const client = createPublicClient();

const events = [
  client.fetchEvent({
    slug: "claude-fable-5-restored-for-us-customers-by-20260613193753196",
  }),
  client.fetchEvent({
    slug: "israel-closes-its-airspace-by",
  }),
];

const grid = document.getElementById("grid")!;
for await (const event of events) {
  const card = document.createElement("div")!;
  card.classList.add("card");
  const chart = new PolymarketCPV(card);
  await chart.load(event);

  grid.appendChild(card);
}

const extraEvents = client.listEvents({
  featured: true,
  volumeMin: 10000,
  titleSearch: "iran",
});
for await (const eventPage of extraEvents) {
  for (const event of eventPage.items) {
    const card = document.createElement("div")!;
    card.classList.add("card");
    const chart = new PolymarketCPV(card);
    await chart.load(event);
    grid.appendChild(card);
  }
}
