import { expect, test } from "bun:test";
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
