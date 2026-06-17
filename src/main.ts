import "@/styles/global.css";
import { PolymarketCPV } from "./component";

const first = new PolymarketCPV(document.getElementById("chart-a")!);
const fisrt_event = await first.polyMarketClient.fetchEvent({
  slug: "iran-closes-its-airspace-byptptpt-20260609184135829",
});
first.load(fisrt_event);

const second = new PolymarketCPV(document.getElementById("chart-b")!);
const second_event = await second.polyMarketClient.fetchEvent({
  slug: "israel-closes-its-airspace-by",
});
second.load(second_event);
