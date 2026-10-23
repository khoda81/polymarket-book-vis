import { expect, spyOn, test } from "bun:test";
import { fetchRecorderHydration } from "./ageRecorderClient";

test("retiring viewport hydration cancels queued and in-flight requests and releases all slots", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout },
  });
  const requests: string[] = [];
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
  const released = Array.from({ length: 4 }, () => new AbortController());
  const after: Promise<void>[] = [];
  try {
    await Promise.resolve();
    expect(requests).toHaveLength(4);
    controllers[4]!.abort();
    await runs[4];
    controllers[0]!.abort();
    await runs[0];
    expect(requests.some((request) => request.includes("token-5"))).toBe(true);
    expect(requests.some((request) => request.includes("token-4"))).toBe(false);
    expect(requests).toHaveLength(5);

    for (const controller of controllers) controller.abort();
    await Promise.all(runs);
    // Every slot was released: four new hydrations start immediately.
    after.push(
      ...released.map((controller, index) =>
        fetchRecorderHydration(
          [`after-${index}`],
          undefined,
          controller.signal,
        ),
      ),
    );
    await Promise.resolve();
    expect(
      requests.filter((request) => request.includes("after-")),
    ).toHaveLength(4);
  } finally {
    for (const controller of [...controllers, ...released]) controller.abort();
    await Promise.all([...runs, ...after]);
    fetch.mockRestore();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
