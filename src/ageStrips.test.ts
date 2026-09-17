import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { AgeStripView } from "./ageStrips";

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
  // Exercise configuration without constructing the canvas renderer or observers.
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
