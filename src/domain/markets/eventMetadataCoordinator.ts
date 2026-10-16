import {
  RateLimitError,
  type EventId,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import { MAX_TIMER_DELAY_MS } from "../../shared/timers";
import {
  loadEventDetails,
  marketTokenIds,
  type EventDetails,
} from "./eventDetails";

export const EVENT_METADATA_REFRESH_MS = 60_000;
export const EVENT_METADATA_MIN_REFRESH_MS = 5_000;
const MAX_CONCURRENT_REFRESHES = 2;

type MetadataListener = (details: EventDetails) => void;
type MetadataLoader = (id: EventId) => Promise<EventDetails>;

interface WatchedEvent {
  readonly id: EventId;
  readonly listeners: Set<MetadataListener>;
  tokenIds: ReadonlySet<TokenId>;
  nextAtMs: number;
  lastAttemptAtMs: number;
  pending: boolean;
  failures: number;
}

/** Reconcile missed lifecycle events from fresh Gamma metadata, once per event. */
export class EventMetadataCoordinator {
  private readonly events = new Map<EventId, WatchedEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;

  constructor(
    client: PublicClient,
    private readonly load: MetadataLoader = async (id) =>
      loadEventDetails(client, await client.fetchEvent({ id })),
  ) {}

  watch(details: EventDetails, listener: MetadataListener): () => void {
    const id = details.event.id;
    let entry = this.events.get(id);
    if (!entry) {
      entry = {
        id,
        listeners: new Set(),
        tokenIds: eventTokenIds(details),
        nextAtMs: allResolved(details)
          ? Infinity
          : Date.now() + EVENT_METADATA_REFRESH_MS,
        lastAttemptAtMs: -Infinity,
        pending: false,
        failures: 0,
      };
      this.events.set(id, entry);
    }
    const watched = entry;
    watched.listeners.add(listener);
    this.schedule();
    return () => {
      watched.listeners.delete(listener);
      if (watched.listeners.size === 0 && this.events.get(id) === watched)
        this.events.delete(id);
      this.schedule();
    };
  }

  refreshAll(): void {
    for (const entry of this.events.values()) this.request(entry);
    this.schedule();
  }

  refreshTokens(tokenIds: readonly TokenId[]): void {
    const requested = new Set(tokenIds);
    for (const entry of this.events.values())
      if ([...entry.tokenIds].some((tokenId) => requested.has(tokenId)))
        this.request(entry);
    this.schedule();
  }

  destroy(): void {
    this.events.clear();
    this.cancelTimer();
  }

  private request(entry: WatchedEvent): void {
    if (!entry.pending && entry.nextAtMs === Infinity) return;
    if (!entry.pending && entry.failures > 0) return;
    entry.nextAtMs = Math.min(
      entry.nextAtMs,
      Math.max(
        Date.now(),
        entry.lastAttemptAtMs + EVENT_METADATA_MIN_REFRESH_MS,
      ),
    );
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.inFlight >= MAX_CONCURRENT_REFRESHES) return;
    let nextAtMs = Infinity;
    for (const entry of this.events.values())
      if (!entry.pending) nextAtMs = Math.min(nextAtMs, entry.nextAtMs);
    if (nextAtMs === Infinity) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const nowMs = Date.now();
        const due = [...this.events.values()]
          .filter((entry) => !entry.pending && entry.nextAtMs <= nowMs)
          .sort((left, right) => left.nextAtMs - right.nextAtMs);
        for (const entry of due) {
          if (this.inFlight >= MAX_CONCURRENT_REFRESHES) break;
          void this.refresh(entry);
        }
        this.schedule();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAtMs - Date.now())),
    );
  }

  private async refresh(entry: WatchedEvent): Promise<void> {
    entry.pending = true;
    entry.nextAtMs = Infinity;
    entry.lastAttemptAtMs = Date.now();
    this.inFlight++;
    try {
      const details = await this.load(entry.id);
      if (this.events.get(entry.id) !== entry) return;
      if (details.event.id !== entry.id)
        throw new Error("Gamma returned metadata for a different event");
      entry.failures = 0;
      entry.tokenIds = eventTokenIds(details);
      entry.nextAtMs = allResolved(details)
        ? Infinity
        : Math.min(entry.nextAtMs, Date.now() + EVENT_METADATA_REFRESH_MS);
      for (const listener of [...entry.listeners]) {
        if (!entry.listeners.has(listener)) continue;
        try {
          listener(details);
        } catch (error) {
          console.error("Event metadata subscriber failed", error);
        }
      }
    } catch (error) {
      if (this.events.get(entry.id) !== entry) return;
      entry.failures++;
      const retryAfterMs =
        error instanceof RateLimitError && Number.isFinite(error.retryAfter)
          ? Math.max(0, error.retryAfter! * 1_000)
          : 0;
      // Failed metadata never replaces a card's last successful state. A wake
      // signal also cannot defeat API Retry-After or repeated failure backoff.
      entry.nextAtMs =
        Date.now() +
        Math.max(
          retryAfterMs,
          Math.min(
            EVENT_METADATA_REFRESH_MS,
            EVENT_METADATA_MIN_REFRESH_MS * 2 ** (entry.failures - 1),
          ),
        );
      console.warn(
        "Could not refresh event metadata; keeping cached state",
        error,
      );
    } finally {
      entry.pending = false;
      this.inFlight--;
      this.schedule();
    }
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function eventTokenIds(details: EventDetails): ReadonlySet<TokenId> {
  return new Set(details.markets.flatMap(marketTokenIds));
}

function allResolved(details: EventDetails): boolean {
  return (
    details.markets.length > 0 &&
    details.markets.every(
      (market) => market.reportedLifecycle.kind === "resolved",
    )
  );
}
