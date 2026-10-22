import { expect, test } from "bun:test";
import { startTouchScaleGesture, type PinchScale } from "./touchScaleGesture";

type Point = readonly [number, number];

function touch(
  target: EventTarget,
  type: string,
  points: readonly Point[],
  cancelable = true,
) {
  const event = new Event(type, { cancelable });
  Object.defineProperty(event, "touches", {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  target.dispatchEvent(event);
  return event;
}

function gesture() {
  const target = new EventTarget();
  const scales: PinchScale[] = [];
  const stop = startTouchScaleGesture(target, (scale) => scales.push(scale));
  return { target, scales, stop };
}

test("a single finger leaves browser scrolling and tap defaults alone", () => {
  const { target, scales, stop } = gesture();
  expect(touch(target, "touchstart", [[20, 20]]).defaultPrevented).toBe(false);
  expect(touch(target, "touchmove", [[20, 100]]).defaultPrevented).toBe(false);
  expect(touch(target, "touchend", []).defaultPrevented).toBe(false);
  expect(scales).toEqual([]);
  stop();
});

test("horizontal and vertical pinches independently zoom time and pressure", () => {
  const { target, scales, stop } = gesture();
  expect(
    touch(target, "touchstart", [
      [100, 100],
      [200, 200],
    ]).defaultPrevented,
  ).toBe(true);
  expect(
    touch(target, "touchmove", [
      [50, 100],
      [250, 200],
    ]).defaultPrevented,
  ).toBe(true);
  expect(Math.exp(scales[0]!.ghostLogScale)).toBeCloseTo(0.5, 1);
  expect(scales[0]!.volumeLogScale).toBe(0);
  touch(target, "touchmove", [
    [50, 50],
    [250, 250],
  ]);
  expect(Math.exp(scales[1]!.volumeLogScale)).toBeCloseTo(0.5, 1);
  expect(scales[1]!.ghostLogScale).toBe(0);
  expect(touch(target, "touchend", []).defaultPrevented).toBe(true);
  stop();
});

test("translation and touch ordering do not change either scale", () => {
  const { target, scales, stop } = gesture();
  touch(target, "touchstart", [
    [0, 0],
    [100, 100],
  ]);
  touch(target, "touchmove", [
    [150, 180],
    [50, 80],
  ]);
  expect(scales).toEqual([{ volumeLogScale: 0, ghostLogScale: 0 }]);
  stop();
});

test("axis-aligned pinches remain finite and a round trip restores both scales", () => {
  const { target, scales, stop } = gesture();
  touch(target, "touchstart", [
    [100, 100],
    [100, 200],
  ]);
  touch(target, "touchmove", [
    [100, 50],
    [100, 250],
  ]);
  touch(target, "touchmove", [
    [100, 100],
    [100, 200],
  ]);
  expect(
    scales.every((scale) => Object.values(scale).every(Number.isFinite)),
  ).toBe(true);
  expect(
    scales.reduce((sum, scale) => sum + scale.volumeLogScale, 0),
  ).toBeCloseTo(0, 12);
  expect(scales.every((scale) => scale.ghostLogScale === 0)).toBe(true);
  stop();
});

test("adding or lifting a finger rebases the pinch without scale jumps", () => {
  const { target, scales, stop } = gesture();
  touch(target, "touchstart", [
    [0, 0],
    [100, 100],
  ]);
  touch(target, "touchstart", [
    [0, 0],
    [100, 100],
    [200, 200],
  ]);
  touch(target, "touchmove", [
    [0, 0],
    [150, 150],
    [200, 200],
  ]);
  expect(scales).toEqual([]);
  touch(target, "touchend", [
    [0, 0],
    [150, 150],
  ]);
  touch(target, "touchmove", [
    [0, 0],
    [150, 150],
  ]);
  expect(scales).toEqual([{ volumeLogScale: 0, ghostLogScale: 0 }]);
  expect(touch(target, "touchend", [[150, 150]]).defaultPrevented).toBe(true);
  expect(touch(target, "touchmove", [[150, 300]]).defaultPrevented).toBe(true);
  touch(target, "touchend", []);
  expect(touch(target, "touchstart", [[0, 0]]).defaultPrevented).toBe(false);
  expect(touch(target, "touchmove", [[0, 100]]).defaultPrevented).toBe(false);
  stop();
});

test("cancellation and teardown restore normal browser behavior", () => {
  const { target, scales, stop } = gesture();
  touch(target, "touchstart", [
    [0, 0],
    [100, 100],
  ]);
  touch(
    target,
    "touchmove",
    [
      [0, 0],
      [200, 200],
    ],
    false,
  );
  expect(scales).toEqual([]);
  touch(target, "touchcancel", []);
  expect(touch(target, "touchmove", [[0, 100]]).defaultPrevented).toBe(false);
  stop();
  expect(
    touch(target, "touchstart", [
      [0, 0],
      [100, 100],
    ]).defaultPrevented,
  ).toBe(false);
  touch(target, "touchmove", [
    [0, 0],
    [200, 200],
  ]);
  expect(scales).toEqual([]);
});
