import { expect, test } from "bun:test";
import { setSharedTooltipSuppressed, showSharedTooltip } from "./sharedTooltip";

test("one suppressor ending does not re-enable tooltips another still holds", () => {
  const drag = Symbol("drag");
  const pinch = Symbol("pinch");
  let renders = 0;
  try {
    setSharedTooltipSuppressed(drag, true);
    setSharedTooltipSuppressed(pinch, true);
    setSharedTooltipSuppressed(drag, false);
    // Suppressed tooltips return before touching the DOM overlay.
    showSharedTooltip(Symbol("tooltip"), "a", () => renders++, 10, 10);
    expect(renders).toBe(0);
  } finally {
    setSharedTooltipSuppressed(drag, false);
    setSharedTooltipSuppressed(pinch, false);
  }
});
