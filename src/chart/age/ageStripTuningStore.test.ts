import { expect, test } from "bun:test";
import {
  AgeStripTuningStore,
  DEFAULT_GHOST_HALF_LIFE_MS,
} from "./ageStripTuningStore";
import { DEFAULT_VOLUME_PER_CSS_PIXEL } from "../../rendering/colors/pressureInk";

test("headless tuning starts from browser-independent defaults", () => {
  expect(new AgeStripTuningStore(null).get()).toEqual({
    volumePerCssPixel: DEFAULT_VOLUME_PER_CSS_PIXEL,
    ghostHalfLifeMs: DEFAULT_GHOST_HALF_LIFE_MS,
  });
});

test("stored legacy volume and current half-life are validated at construction", () => {
  const store = new AgeStripTuningStore({
    getItem: () =>
      JSON.stringify({ volumeSoftLimit: 12, ghostHalfLifeMs: 900 }),
    setItem: () => undefined,
  });

  expect(store.get()).toEqual({
    volumePerCssPixel: 12,
    ghostHalfLifeMs: 900,
  });
});

test("scaling updates one coherent tuning value", () => {
  const store = new AgeStripTuningStore(null);

  store.scale(2, 0.5);

  expect(store.get()).toEqual({
    volumePerCssPixel: DEFAULT_VOLUME_PER_CSS_PIXEL * 2,
    ghostHalfLifeMs: DEFAULT_GHOST_HALF_LIFE_MS * 0.5,
  });
});
