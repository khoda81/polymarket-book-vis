import "@/styles/global.css";
import { PolymarketCPV } from "./component";

const first = new PolymarketCPV(document.getElementById("chart-a")!);
const fisrt_event = await first.polyMarketClient.fetchEvent({
  slug: "claude-fable-5-restored-for-us-customers-by-20260613193753196",
});
first.load(fisrt_event);

const second = new PolymarketCPV(document.getElementById("chart-b")!);
const second_event = await second.polyMarketClient.fetchEvent({
  slug: "israel-closes-its-airspace-by",
});
second.load(second_event);
