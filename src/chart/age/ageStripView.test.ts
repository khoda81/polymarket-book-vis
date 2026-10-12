import { expect, test } from "bun:test";
import { AgeStripView, type AgeStripHost } from "./ageStripView";
import { AgeStripTuningStore } from "./ageStripTuningStore";
import { AgeStripPressureState } from "./ageStripPressureState";
import type { AgeStripRenderState } from "./ageStripView";
import type { GpuPressureFrame } from "./gpuPressureLayer";
import { observationTime } from "../../domain/pressure/observationClock";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "../../rendering/colors/signedVolume";
import { parsePrice } from "../../domain/books/price";

type TestNode = TestElement | { data: string };
class TestElement {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: any) => void>();
  children: TestNode[] = [];
  className = "";
  title = "";
  private parent: TestElement | null = null;
  private text = "";
  constructor(readonly tag = "div") {}
  get textContent(): string {
    return (
      this.text +
      this.children
        .map((node) =>
          node instanceof TestElement ? node.textContent : node.data,
        )
        .join("")
    );
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  append(...nodes: TestNode[]) {
    for (const node of nodes)
      if (node instanceof TestElement) node.parent = this;
    this.children.push(...nodes);
  }
  appendChild(node: TestNode) {
    this.append(node);
    return node;
  }
  replaceChildren() {
    for (const node of this.children)
      if (node instanceof TestElement) node.parent = null;
    this.text = "";
    this.children = [];
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
    this.parent = null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return this.children;
  }
  getContext() {
    return { measureText: (text: string) => ({ width: text.length * 6 }) };
  }
  addEventListener(name: string, callback: (event: any) => void) {
    this.listeners.set(name, callback);
  }
  removeEventListener(name: string) {
    this.listeners.delete(name);
  }
}

// The shared tooltip overlay has one document lifetime, just as in the browser.
const body = new TestElement("body");
function harness(run: (fixture: ReturnType<typeof createView>) => void) {
  let callbacks: FrameRequestCallback[] = [];
  const globals = {
    document: {
      body,
      createElement: (tag: string) => new TestElement(tag),
      createTextNode: (data: string) => ({ data }),
    },
    window: { devicePixelRatio: 1.25, setTimeout: () => 1, clearTimeout() {} },
    clearTimeout() {},
    WheelEvent: { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelAnimationFrame() {},
  };
  const originals = Object.keys(globals).map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  Object.entries(globals).forEach(([key, value]) =>
    Object.defineProperty(globalThis, key, { configurable: true, value }),
  );
  let fixture: ReturnType<typeof createView> | undefined;
  try {
    fixture = createView(() => {
      const pending = callbacks;
      callbacks = [];
      for (const callback of pending) callback(0);
    });
    run(fixture);
  } finally {
    fixture?.view.destroy();
    Object.keys(globals).forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

function createView(flushFrame: () => void) {
  const canvas = new TestElement("canvas");
  const canvasWrap = new TestElement();
  const toggles = new TestElement();
  const tuning = new AgeStripTuningStore(null);
  const pressure = new AgeStripPressureState();
  const frames: GpuPressureFrame[] = [];
  const state: AgeStripRenderState = {
    viewMode: "age",
    rowOrientation: "negative-above",
    opacityTimeMs: observationTime(Date.now()),
    volumePerCssPixel: tuning.get().volumePerCssPixel,
    ghostHalfLifeMs: tuning.get().ghostHalfLifeMs,
  };
  const plotter = {
    width: 400,
    height: 420,
    padding: { l: 20, r: 20, t: 16, b: 16 },
    resize() {
      this.height = Number.parseFloat(canvasWrap.style.height || "420");
    },
    beginFrame() {
      return {
        canvas: { height: Math.floor(this.height * 1.25) },
        viewport: {
          l: this.padding.l,
          t: this.padding.t,
          width: this.width - this.padding.l - this.padding.r,
          height: this.height - this.padding.t - this.padding.b,
        },
        ctx: {
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          rect() {},
          clip() {},
        },
      };
    },
  };
  function rows(...ids: string[]) {
    toggles.children = ids.map((id, index) => {
      const label = new TestElement("label");
      Object.assign(label.dataset, {
        tokenId: `${id}-yes`,
        ageLabel: `Market ${id}`,
        marketOrder: String(index),
      });
      for (const side of ["yes", "no"]) {
        const tokenId = `${id}-${side}`;
        pressure
          .ensure(tokenId)
          .memory.observeLevels(
            [{ price: parsePrice("0.6"), shares: 100 }],
            state.opacityTimeMs,
          );
        pressure.setRecordingCoverage({
          [tokenId]: Date.now() - 4 * 86_400_000,
        });
      }
      return label;
    });
  }
  rows("a", "b");
  const view = new AgeStripView({
    model: {
      pressure,
      isTokenActive: () => true,
      oppositeTokenId: (id: string) => id.replace("-yes", "-no"),
      pressureColorScale: () => DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
      marketTokenName: (id: string) => id,
      marketName: (id: string) => `Market ${id.split("-")[0]}`,
      tokenName: (id: string) => (id.endsWith("-yes") ? "Yes" : "No"),
    },
    tuning,
    canvas,
    pressureCanvas: new TestElement("canvas"),
    canvasWrap,
    toggles,
    plotter,
    getTheme: () => ({ bg: "#fff" }),
    getRenderState: () => ({ ...state, ...tuning.get() }),
  } as unknown as AgeStripHost);
  // Substitute only the native GPU backend; use the real layout, clocks and hover.
  Reflect.set(view, "pressureLayer", {
    render: (frame: GpuPressureFrame) => frames.push(frame),
    refreshOpacity: () => true,
    setVisible() {},
    destroy() {},
  });
  const overlay = () =>
    body.children.find(
      (node): node is TestElement =>
        node instanceof TestElement &&
        node.attributes.get("role") === "tooltip",
    )!;
  const clocks = () =>
    (canvasWrap.children[0] as TestElement).children as TestElement[];
  function hover(row: number) {
    const frame = frames.at(-1)!;
    const geometry = frame.rows[row]!;
    const scaleY = Math.floor(frame.cssHeight * 1.25) / frame.cssHeight;
    const y = (geometry.topDevice + geometry.centerDevice) / (2 * scaleY);
    const x = frame.viewport.l + frame.viewport.width / 2;
    canvas.listeners.get("pointermove")!({
      offsetX: x,
      offsetY: y,
      clientX: x + 10,
      clientY: y + 80,
    });
    return overlay();
  }
  return {
    view,
    canvas,
    tuning,
    state,
    frames,
    rows,
    hover,
    overlay,
    clocks,
    flushFrame,
  };
}

test("only Ctrl+wheel changes share scale in age mode", () =>
  harness(({ canvas, tuning, flushFrame }) => {
    const initial = tuning.get();
    let prevented = false;
    const wheel = (ctrlKey: boolean, deltaY: number) =>
      canvas.listeners.get("wheel")!({
        deltaY,
        deltaMode: 0,
        ctrlKey,
        shiftKey: false,
        preventDefault() {
          prevented = true;
        },
        stopImmediatePropagation() {},
      });
    wheel(false, -100);
    expect(tuning.get()).toEqual(initial);
    expect(prevented).toBe(false);
    wheel(true, -100);
    flushFrame();
    expect(tuning.get().volumePerCssPixel).not.toBe(initial.volumePerCssPixel);
    expect(prevented).toBe(true);
    wheel(true, 100);
    flushFrame();
    expect(tuning.get().volumePerCssPixel).toBeCloseTo(
      initial.volumePerCssPixel,
    );
  }));

test("hover and recording ages survive pause and an opacity-only return", () =>
  harness(({ view, frames, hover, overlay, clocks }) => {
    view.draw();
    expect(hover(0).textContent).toContain("Market a");
    const positions = clocks().map((label) => label.style.top);
    view.setPaused(true);
    expect(overlay().style.display).toBe("none");
    view.setPaused(false);
    expect(view.refreshOpacity()).toBe(true);
    expect(frames).toHaveLength(1);
    expect(hover(0).style.display).toBe("block");
    expect(overlay().textContent).toContain("Market a");
    expect(clocks().map((label) => label.style.top)).toEqual(positions);
    expect(clocks().map((label) => label.textContent)).toEqual([
      "4d",
      "4d",
      "4d",
      "4d",
    ]);
  }));

test("replacing drawn rows updates hover and clocks together, including mode changes", () =>
  harness(({ view, state, frames, rows, hover, overlay, clocks }) => {
    view.draw();
    expect(hover(0).textContent).toContain("Market a");
    rows("c", "d");
    view.draw();
    expect(frames.at(-1)!.rows.map((row) => row.key)).toEqual([
      "c-yes",
      "d-yes",
    ]);
    expect(overlay().textContent).toContain("Market c");
    expect(clocks().map((label) => label.title.split(" · ")[0])).toEqual([
      "c-yes",
      "c-no",
      "d-yes",
      "d-no",
    ]);
    Object.assign(state, { viewMode: "volume" });
    view.prepareVolumeView();
    expect(clocks()).toHaveLength(0);
    expect(hover(0).style.display).toBe("none");
    Object.assign(state, { viewMode: "age" });
    view.draw();
    expect(hover(1).textContent).toContain("Market d");
    expect(clocks()).toHaveLength(4);
  }));
