import type { Frame } from "@/rendering/renderer";
import type { DrawnAgeRow } from "./ageStripLayout";
import { barFarEdgeX } from "./pressureRows";

/** Draw a rail in each bar's color at the edge its track price runs toward. */
export function drawAgeAxes(frame: Frame, rows: readonly DrawnAgeRow[]): void {
  const { ctx, viewport: vp } = frame;

  ctx.lineWidth = 1;
  for (const drawn of rows)
    for (const bar of drawn.row.bars) {
      const x = vp.l + barFarEdgeX(bar) * vp.width;
      ctx.strokeStyle = bar.color;
      ctx.beginPath();
      ctx.moveTo(x, drawn.topCss);
      ctx.lineTo(x, drawn.bottomCss);
      ctx.stroke();
    }

  ctx.beginPath();
  ctx.rect(vp.l, vp.t, vp.width, vp.height);
  ctx.clip();
}
