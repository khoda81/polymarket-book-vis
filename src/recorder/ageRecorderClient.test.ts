import { expect, spyOn, test } from "bun:test";
import {
  fetchRecorderHydration,
  subscribeRecorderNetworkState,
  type RecorderNetworkState,
} from "./ageRecorderClient";

test("retiring viewport hydration cancels queued and in-flight requests and releases all slots", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout },
  });
  const requests: string[] = [];
  let state!: RecorderNetworkState;
  const unsubscribe = subscribeRecorderNetworkState((next) => (state = next));
  const fetch = spyOn(globalThis, "fetch").mockImplementation(((
    input,
    init,
  ) => {
    requests.push(String(input));
    return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
        { once: true },
      );
    });
  }) as typeof globalThis.fetch);
  const controllers = Array.from({ length: 6 }, () => new AbortController());
  const runs = controllers.map((controller, index) =>
    fetchRecorderHydration([`token-${index}`], undefined, controller.signal),
  );
  try {
    await Promise.resolve();
    expect(state.activeRequests).toBe(4);
    expect(state.queuedRequests).toBe(2);
    controllers[4]!.abort();
    await runs[4];
    expect(state.queuedRequests).toBe(1);
    controllers[0]!.abort();
    await runs[0];
    expect(requests.some((request) => request.includes("token-5"))).toBe(true);
    expect(requests.some((request) => request.includes("token-4"))).toBe(false);
    expect(state.activeRequests).toBeLessThanOrEqual(4);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(runs);
    fetch.mockRestore();
    unsubscribe();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  expect(state).toMatchObject({
    activeRequests: 0,
    queuedRequests: 0,
    pendingTokens: 0,
    activeHydrations: 0,
  });
});
