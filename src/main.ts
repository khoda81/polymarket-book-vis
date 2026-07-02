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

const eventSlugs = [
  "claude-fable-5-restored-for-us-customers-by-20260613193753196",
  "israel-closes-its-airspace-by",
];

eventSlugs.forEach(async (slug) =>
  createCard(await client.fetchEvent({ slug })),
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
  const events = eventPage.items;
  events.forEach((e) => {
    if (!eventSlugs.includes(e.slug ?? "")) createCard(e);
  });
}
