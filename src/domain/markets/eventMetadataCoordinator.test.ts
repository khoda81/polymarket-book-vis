import { expect, spyOn, test } from "bun:test";
import {
  RateLimitError,
  type Event,
  type EventId,
  type PublicClient,
} from "@polymarket/client";
import { buildEventDetails, type EventDetails } from "./eventDetails";
import {
  EventMetadataCoordinator,
  EVENT_METADATA_MIN_REFRESH_MS,
  EVENT_METADATA_REFRESH_MS,
} from "./eventMetadataCoordinator";
import {
  withFakeTimers,
  flushMicrotasks,
} from "../../shared/testing/fakeTimers";

function details(id = "1", resolved = false): EventDetails {
  return buildEventDetails(sdkEvent(id, resolved), {});
}

function sdkEvent(id: string, resolved: boolean): Event {
  return {
    id,
    title: `Event ${id}`,
    display: { sortBy: "ascending" },
    trading: { negRisk: false },
    markets: [
      {
        id: `market-${id}`,
        state: {
          active: !resolved,
          closed: resolved,
          acceptingOrders: !resolved,
        },
        trading: { feesEnabled: false },
        sports: {},
        resolution: { umaResolutionStatus: resolved ? "resolved" : null },
        outcomes: {
          yes: {
            tokenId: `yes-${id}`,
            label: "Yes",
            price: resolved ? "1" : "0.6",
          },
          no: {
            tokenId: `no-${id}`,
            label: "No",
            price: resolved ? "0" : "0.4",
          },
        },
      },
    ],
  } as unknown as Event;
}

function fixture() {
  const requests: {
    id: EventId;
    resolve: (details: EventDetails) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const coordinator = new EventMetadataCoordinator(
    {} as PublicClient,
    (id) =>
      new Promise((resolve, reject) => requests.push({ id, resolve, reject })),
  );
  return { coordinator, requests };
}

test("event cards and series share one refresh, and token-triggered checks are paced", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    const first: EventDetails[] = [];
    const second: EventDetails[] = [];
    coordinator.watch(details(), (value) => first.push(value));
    coordinator.watch(details(), (value) => second.push(value));
    expect(clock.nextDelayMs).toBe(EVENT_METADATA_REFRESH_MS);
    coordinator.refreshTokens(["yes-1" as never, "no-1" as never]);
    coordinator.refreshAll();
    clock.runNext();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(details());
    await flushMicrotasks();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    coordinator.refreshTokens(["yes-1" as never]);
    coordinator.refreshAll();
    expect(clock.nextDelayMs).toBe(EVENT_METADATA_MIN_REFRESH_MS);
    coordinator.destroy();
  }));

test("wake refresh recovers missed resolution and stops polling a terminal event", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    const received: EventDetails[] = [];
    coordinator.watch(details(), (value) => received.push(value));
    clock.nowMs += 12 * 3_600_000; // No old timer fires during sleep.
    coordinator.refreshAll();
    expect(clock.nextDelayMs).toBe(0);
    clock.runNext();
    requests[0]!.resolve(details("1", true));
    await flushMicrotasks();
    expect(received[0]!.markets[0]!.yes.price).toBe(1);
    expect(clock.nextDelayMs).toBe(Infinity);
    coordinator.refreshAll();
    expect(clock.nextDelayMs).toBe(Infinity);
    coordinator.destroy();
  }));

test("metadata is periodically reconciled even if no websocket recovery signal arrives", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    coordinator.watch(details(), () => {});
    clock.runNext();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(details());
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(EVENT_METADATA_REFRESH_MS);
    clock.runNext();
    expect(requests).toHaveLength(2);
    coordinator.destroy();
    requests[1]!.resolve(details());
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(Infinity);
  }));

test("waking while an old request is in flight queues a fresh follow-up", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    coordinator.watch(details(), () => {});
    coordinator.refreshAll();
    clock.runNext();
    clock.nowMs += 12 * 3_600_000;
    coordinator.refreshAll();
    requests[0]!.resolve(details());
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(0);
    clock.runNext();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(details("1", true));
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(Infinity);
    coordinator.destroy();
  }));

test("failed checks keep cached state and recovery signals cannot bypass Retry-After", () =>
  withFakeTimers(async (clock) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { coordinator, requests } = fixture();
    const received: EventDetails[] = [];
    try {
      coordinator.watch(details(), (value) => received.push(value));
      coordinator.refreshAll();
      clock.runNext();
      requests[0]!.reject(
        new RateLimitError("Too many requests", { retryAfter: 30 }),
      );
      await flushMicrotasks();
      expect(received).toEqual([]);
      expect(clock.nextDelayMs).toBe(30_000);
      coordinator.refreshAll();
      coordinator.refreshTokens(["yes-1" as never]);
      expect(clock.nextDelayMs).toBe(30_000);
      clock.runNext();
      requests[1]!.reject(new Error("offline"));
      await flushMicrotasks();
      expect(clock.nextDelayMs).toBe(10_000);
      expect(received).toEqual([]);
    } finally {
      coordinator.destroy();
      warn.mockRestore();
    }
  }));

test("late results from a removed event cannot update its replacement", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    const received: EventDetails[] = [];
    const unwatch = coordinator.watch(details(), (value) =>
      received.push(value),
    );
    coordinator.refreshAll();
    clock.runNext();
    unwatch();
    coordinator.watch(details(), (value) => received.push(value));
    requests[0]!.resolve(details("1", true));
    await flushMicrotasks();
    expect(received).toEqual([]);
    expect(clock.nextDelayMs).toBe(EVENT_METADATA_REFRESH_MS);
    coordinator.destroy();
  }));

test("refresh concurrency is bounded while all due events eventually receive a slot", () =>
  withFakeTimers(async (clock) => {
    const { coordinator, requests } = fixture();
    for (const id of ["1", "2", "3"]) coordinator.watch(details(id), () => {});
    coordinator.refreshAll();
    clock.runNext();
    expect(requests.map((request) => String(request.id))).toEqual(["1", "2"]);
    requests[0]!.resolve(details());
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(0);
    clock.runNext();
    expect(requests.map((request) => String(request.id))).toEqual([
      "1",
      "2",
      "3",
    ]);
    coordinator.destroy();
    requests[1]!.resolve(details("2"));
    requests[2]!.resolve(details("3"));
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(Infinity);
  }));

test("the production loader fetches a fresh normalized event before adding raw annotations", () =>
  withFakeTimers(async (clock) => {
    const fetched: string[] = [];
    const fresh = sdkEvent("1", true);
    const coordinator = new EventMetadataCoordinator({
      fetchEvent: async ({ id }: { id: EventId }) => {
        fetched.push(id);
        return fresh;
      },
      gamma: {
        get: async (path: string) => {
          fetched.push(path);
          return { value: new Response(JSON.stringify({ markets: [] })) };
        },
      },
    } as unknown as PublicClient);
    let received: EventDetails | undefined;
    coordinator.watch(details(), (value) => {
      received = value;
    });
    coordinator.refreshAll();
    clock.runNext();
    await flushMicrotasks();
    expect(fetched).toEqual(["1", "/events/1"]);
    expect(received?.markets[0]!.closed).toBe(true);
    coordinator.destroy();
  }));
