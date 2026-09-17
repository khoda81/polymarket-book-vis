import { expect, test } from "bun:test";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "./signedVolume";
import { sharedWebGLPressureRenderer } from "./webglPressure";

test("import, unused release, and empty render do not require a DOM", () => {
  expect(typeof document).toBe("undefined");
  const key = {};
  expect(() => sharedWebGLPressureRenderer.release(key)).not.toThrow();
  expect(sharedWebGLPressureRenderer.render({
    key,
    rows: [],
    dirtyTokens: new Set(),
    widthCss: 100,
    heightCss: 36,
    dpr: 1,
    nowMs: 0,
    ageScaleSeconds: 5,
    colorScale: DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    requestRedraw() {},
  })).toBeNull();
});
