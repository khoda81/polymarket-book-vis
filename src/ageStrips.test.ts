import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { AgeStripView, getAgeStripTuning, type AgeStripHost } from "./ageStrips";

test("only Ctrl+wheel changes share scale in age mode", () => {
  const { view, listeners } = createAgeViewHarness();
  const before = getAgeStripTuning().volumePerCssPixel;

  const ordinary = wheelEvent(-100, false);
  listeners.wheel?.(ordinary);
  expect(getAgeStripTuning().volumePerCssPixel).toBe(before);
  expect(ordinary.defaultPrevented).toBe(false);

  const ctrlUp = wheelEvent(-100, true);
  listeners.wheel?.(ctrlUp);
  const afterUp = getAgeStripTuning().volumePerCssPixel;
  expect(afterUp).toBeLessThan(before);
  expect(ctrlUp.defaultPrevented).toBe(true);

  const ctrlDown = wheelEvent(100, true);
  listeners.wheel?.(ctrlDown);
  expect(getAgeStripTuning().volumePerCssPixel).toBeCloseTo(before);
  expect(ctrlDown.defaultPrevented).toBe(true);

  view.destroy();
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
    host: {
      activeTokens,
      toggles: { querySelectorAll: () => controls },
      getTitle: () => undefined,
    },
  }) as AgeStripView;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({}) },
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