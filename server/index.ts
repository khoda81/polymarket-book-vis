import { AgeCollector } from "./collector";
import { AgeStore, type TrackedToken } from "./store";

const port = Number(process.env.AGE_PORT ?? 8787);
const store = new AgeStore();
const collector = new AgeCollector(store);
collector.start();

const server = Bun.serve({
  port,
  async fetch(request) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, trackedTokens: collector.trackedCount() });
    }

    if (request.method === "GET" && url.pathname === "/api/age") {
      const tokenIds = url.searchParams.getAll("tokenId").filter(Boolean);
      return json(ageResponse(tokenIds));
    }

    if (request.method === "POST" && url.pathname === "/api/bootstrap") {
      try {
        const body = (await request.json()) as { tokens?: unknown };
        const tokens = parseTrackedTokens(body.tokens);
        collector.track(tokens);
        return json(ageResponse(tokens.map((token) => token.tokenId)));
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`age collector listening on http://localhost:${server.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.stop();
  await collector.stop();
  store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function ageResponse(tokenIds: readonly string[]) {
  const states = collector.states(tokenIds).map((state) => ({
    tokenId: state.tokenId,
    bid: state.bid,
    ask: state.ask,
    observedAtMs: state.observedAtMs,
    segments: state.snapshot.segments,
  }));
  return { serverNowMs: Date.now(), states };
}

function parseTrackedTokens(value: unknown): TrackedToken[] {
  if (!Array.isArray(value)) throw new TypeError("tokens must be an array");

  const result: TrackedToken[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object")
      throw new TypeError("each token must be an object");
    const record = item as Record<string, unknown>;
    if (typeof record.tokenId !== "string" || record.tokenId.length === 0)
      throw new TypeError("tokenId must be a non-empty string");

    result.push({
      tokenId: record.tokenId,
      eventId: optionalString(record.eventId),
      marketId: optionalString(record.marketId),
      question: optionalString(record.question),
      resolutionAtMs: optionalFiniteNumber(record.resolutionAtMs),
    });
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function json(value: unknown, status = 200): Response {
  return withCors(
    Response.json(value, {
      status,
      headers: { "Cache-Control": "no-store" },
    }),
  );
}

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return response;
}
