import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { AgeStripView, getAgeStripTuning, type AgeStripHost } from "./ageStrips";

test("only Ctrl+wheel changes share scale in age mode", () => {
  const globals = ["document", "window", "WheelEvent", "requestAnimationFrame"];
  const originals = globals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  let wheel!: (event: WheelEvent) => void;
  let redraw!: FrameRequestCallback;
  const replacements = [
    {
      createElement: () => ({
        remove() {},
        style: {},
        className: "",
      }),
    },
    { setTimeout: () => undefined },
    { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    (callback: FrameRequestCallback) => {
      redraw = callback;
      return 1;
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
        insertAdjacentElement() {},
        querySelector() {
          return null;
        },
        appendChild() {},
      },
      toggles: { parentElement: null, nextSibling: null },
      getViewMode: () => "age",
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
    redraw(0);
    expect(getAgeStripTuning().volumePerCssPixel).toBeLessThan(initial);
    expect(prevented).toBe(true);

    wheel({
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: true,
      preventDefault() {},
      stopImmediatePropagation() {},
    } as WheelEvent);
    redraw(0);
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

test("markets not accepting orders start unchecked but retain their controls", () => {
  const markets = [true, false, undefined, null].map((acceptingOrders, index) => ({
    id: String(index),
    question: `Market ${index}`,
    state: { acceptingOrders },
    outcomes: { yes: { tokenId: String(index) } },
  }));
  const activeTokens = new Set(markets.map((market) => market.outcomes.yes.tokenId));
  const controls = markets.map(() => {
    const checkbox = { checked: true, addEventListener() {} };
    return {
      checkbox,
      dataset: {} as Record<string, string>,
      childNodes: [],
      querySelector(selector: string) {
        return selector.startsWith("input") ? checkbox : null;
      },
      appendChild() {},
    };
  });

  // Exercise market configuration without constructing the browser renderer.
  const view = Object.assign(Object.create(AgeStripView.prototype), {
    markets: new Map(),
    host: {
      activeTokens,
      toggles: { querySelectorAll: () => controls },
      getTitle: () => undefined,
    },
  }) as AgeStripView;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        append() {},
      }),
    },
  });
  try {
    view.configureMarkets({ markets } as unknown as Event, []);
    expect([...activeTokens]).toEqual(["0"]);
    expect(controls.map((label) => label.checkbox.checked)).toEqual([
      true, false, false, false,
    ]);
    expect(controls.map((label) => label.dataset.tokenId)).toEqual([
      "0", "1", "2", "3",
    ]);
  } finally {
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});