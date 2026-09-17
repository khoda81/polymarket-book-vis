import { expect, test } from "bun:test";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "./signedVolume";
import { sharedWebGLPressureRenderer } from "./webglPressure";

test("WebGL pressure rendering degrades cleanly without a DOM", () => {
  expect(typeof document).toBe("undefined");

  const key = {};
  expect(() => sharedWebGLPressureRenderer.release(key)).not.toThrow();
  expect(
    sharedWebGLPressureRenderer.render({
      key,
      rows: [
        {
          tokenId: "test",
          segments: [{ lo: 0, hi: 1, volume: 100, ageMs: 0 }],
        },
      ],
      dirtyTokens: new Set(["test"]),
      widthCss: 100,
      heightCss: 36,
      dpr: 1,
      nowMs: 0,
      ageScaleSeconds: 5,
      colorScale: DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
      requestRedraw() {},
    }),
  ).toBeNull();
});
