import { expect, test } from "bun:test";
import { AgeStripView, type AgeStripHost } from "./ageStripView";
import { AgeStripTuningStore } from "./ageStripTuningStore";

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
  let frame!: FrameRequestCallback;
  const replacements = [
    {
      body: { appendChild() {} },
      createElement: () => ({
        remove() {},
        replaceChildren() {},
        setAttribute() {},
        style: {},
        className: "",
      }),
    },
    { setTimeout: () => undefined },
    { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    },
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

  const tuning = new AgeStripTuningStore(null);
  let view: AgeStripView | undefined;
  try {
    view = new AgeStripView({
      model: {},
      tuning,
      getRenderState: () => ({
        viewMode: "age",
        rowOrientation: "negative-above",
        opacityTimeMs: 0,
        volumePerCssPixel: tuning.get().volumePerCssPixel,
        ghostHalfLifeMs: tuning.get().ghostHalfLifeMs,
      }),
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
    } as unknown as AgeStripHost);

    const initial = tuning.get().volumePerCssPixel;
    const initialHalfLife = tuning.get().ghostHalfLifeMs;

    let prevented = false;
    wheel({
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {},
    } as WheelEvent);
    expect(tuning.get().volumePerCssPixel).toBe(initial);
    expect(tuning.get().ghostHalfLifeMs).toBe(initialHalfLife);
    expect(prevented).toBe(false);

    wheel({
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
      stopImmediatePropagation() {},
    } as WheelEvent);
    frame(0);
    expect(tuning.get().volumePerCssPixel).not.toBe(initial);
    expect(prevented).toBe(true);

    wheel({
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
      preventDefault() {},
      stopImmediatePropagation() {},
    } as WheelEvent);
    frame(0);
    expect(tuning.get().volumePerCssPixel).toBeCloseTo(initial);
  } finally {
    view?.destroy();
    globals.forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
