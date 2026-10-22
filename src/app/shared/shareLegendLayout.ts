import {
  shareLegendTicks,
  type ShareLegendTick,
} from "@/rendering/legends/shareLegendTicks";

const MIN_TICK_SPACING_PX = 8;
const MAX_TICK_SPACING_PX = 24;
const TICK_SPACING_WIDTH_FRACTION = 16;
const LABEL_CHARACTER_WIDTH_PX = 6;
const LABEL_GAP_PX = 6;

/** Marks can stay dense while readable labels reserve their own space. */
export function shareLegendLayout(reserve: number, width: number, dpr: number) {
  const minSpacingPx = Math.min(
    MAX_TICK_SPACING_PX,
    Math.max(MIN_TICK_SPACING_PX, width / TICK_SPACING_WIDTH_FRACTION),
  );
  const ticks = shareLegendTicks(reserve, width, {
    minSpacingPx,
    fullOpacitySpacingPx: minSpacingPx * 1.5,
    dpr,
  });
  const labels: ShareLegendTick[] = [];
  const intervals: { left: number; right: number }[] = [];
  const candidates = [...ticks].sort(
    (a, b) =>
      Number(b.value === 0) - Number(a.value === 0) ||
      b.displayExponent - a.displayExponent ||
      b.opacity - a.opacity ||
      Math.abs(b.value) - Math.abs(a.value) ||
      a.value - b.value,
  );
  for (const tick of candidates) {
    if (tick.opacity < 0.5) continue;
    const halfWidth = (tick.label.length * LABEL_CHARACTER_WIDTH_PX) / 2;
    if (halfWidth * 2 > width) continue;
    const center = Math.max(
      halfWidth,
      Math.min(width - halfWidth, tick.position * width),
    );
    const left = center - halfWidth;
    const right = center + halfWidth;
    if (
      intervals.some(
        (placed) =>
          left < placed.right + LABEL_GAP_PX &&
          right > placed.left - LABEL_GAP_PX,
      )
    )
      continue;
    labels.push({ ...tick, position: center / width });
    intervals.push({ left, right });
  }
  labels.sort((a, b) => a.position - b.position);
  return { ticks, labels };
}
