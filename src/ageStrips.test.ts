import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import {
  AgeStripView,
  type AgeStripHost,
} from "./chart/ageStripView";
import { getAgeStripTuning } from "./lib/ageStripTuning";

test("only Ctrl+wheel changes share scale in age mode", () => {
  const globals = [
    "document",
    "window",
    "WheelEvent",
    "requestAnimationFrame",
    "IntersectionObserver",
  ];
  const originals = globals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  let wheel!: (event: WheelEvent) => void;
  const replacements = [
    {
      body: { appendChild() {} },
      createElement: () => ({
        remove() {},
        setAttribute() {},
        style: {},
        className: "",
      }),
    },
    { setTimeout: () => undefined },
    { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    (_callback: FrameRequestCallback) => 1,
    class {
      observe() {}
      disconnect() {}
    },
  ];
  globals.forEach((key, index) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: replacements[index],
    }),
  );

  let view: AgeStripView | undefined;
  try {
    view = new AgeStripView({
      canvas: {
        addEventListener(type: string, listener: typeof wheel) {
          if (type === "wheel") wheel = listener;
        },
        removeEventListener() {},
      },
      canvasWrap: {
        appendChild() {},
      },
      toggles: { parentElement: null, nextSibling: null },
      hiddenTray: {},
      getViewMode: () => "age",
      hideToken() {},
      requestDraw() {},
    } as unknown as AgeStripHost);

    const initial = getAgeStripTuning().volumePerCssPixel;

    let prevented = false;
    wheel({
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: false,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {},
    } as WheelEvent);
    expect(getAgeStripTuning().volumePerCssPixel).toBe(initial);
    expect(prevented).toBe(false);

    wheel({
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {},
    } as WheelEvent);
    expect(getAgeStripTuning().volumePerCssPixel).toBeLessThan(initial);
    expect(prevented).toBe(true);

    wheel({
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: true,
      preventDefault() {},
      stopImmediatePropagation() {},
    } as WheelEvent);
    expect(getAgeStripTuning().volumePerCssPixel).toBeCloseTo(initial);
  } finally {
    view?.destroy();
    globals.forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

test("market configuration annotates Svelte-owned controls without owning visibility", () => {
  const markets = [0, 1].map((index) => ({
    id: String(index),
    question: `Market ${index}`,
    state: { acceptingOrders: index === 0 },
    outcomes: { yes: { tokenId: String(index) } },
  }));
  const activeTokens = new Set(["0"]);
  const controls = markets.map((market) => {
    const textSpan = { textContent: market.question };
    return {
      dataset: {
        tokenId: market.outcomes.yes.tokenId,
        marketId: market.id,
      } as Record<string, string>,
      title: "",
      querySelector(selector: string) {
        return selector === ".cpv-market-label-text"
          ? textSpan
          : null;
      },
    };
  });

  const view = Object.assign(Object.create(AgeStripView.prototype), {
    markets: new Map(),
    hiddenTray: { querySelectorAll: () => [] },
    host: {
      activeTokens,
      toggles: { querySelectorAll: () => controls },
      getTitle: () => undefined,
    },
  }) as AgeStripView;

  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({}),
    },
  });
  try {
    view.configureMarkets({ markets } as unknown as Event, []);
    expect([...activeTokens]).toEqual(["0"]);
    expect(controls.map((label) => label.dataset.marketLabel)).toEqual([
      "Market 0",
      "Market 1",
    ]);
    expect(controls.map((label) => label.title)).toEqual([
      "Market 0",
      "Market 1",
    ]);
  } finally {
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("single-market wrapper suppresses duplicate age-axis title", () => {
  const market = {
    id: "m1",
    question: "Putin meets with Iranian officials by December 31?",
    state: { acceptingOrders: true },
    outcomes: { yes: { tokenId: "yes-1" } },
  };
  const control = {
    dataset: {
      tokenId: "yes-1",
      marketId: "m1",
    } as Record<string, string>,
    title: "",
    querySelector(selector: string) {
      return selector === ".cpv-market-label-text"
        ? { textContent: market.question }
        : null;
    },
  };

  const view = Object.assign(Object.create(AgeStripView.prototype), {
    markets: new Map(),
    hiddenTray: { querySelectorAll: () => [] },
    host: {
      activeTokens: new Set(["yes-1"]),
      toggles: { querySelectorAll: () => [control] },
      getTitle: () => undefined,
    },
  }) as AgeStripView;

  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({}),
    },
  });

  try {
    view.configureMarkets(
      {
        title: "Putin meets with Iranian officials by December 31?",
        markets: [market],
      } as unknown as Event,
      [],
    );
    expect(control.dataset.marketLabel).toBe("");
    expect(control.dataset.ageLabelWidth).toBe("0");
    expect(control.dataset.ageSuppressMarketIdentity).toBe("true");
  } finally {
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
