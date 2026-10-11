import { AGE_ROW_BAND_PX } from "../../chart/age/ageStripTuning";
import type { ViewMode } from "../../domain/markets/chartState";
import { CHART_VERTICAL_PADDING_PX } from "../../rendering/renderer";

const BUFFER_ROWS = 2;

export interface ChartWindow {
  readonly start: number;
  readonly end: number;
}

export interface ChartViewport {
  readonly rows: ChartWindow;
  readonly visible: boolean;
}

export function chartWindow(
  rowCount: number,
  top: number,
  bottom: number,
  viewportTop: number,
  viewportBottom: number,
): ChartWindow {
  if (
    viewportBottom <= viewportTop ||
    bottom <= viewportTop ||
    top >= viewportBottom ||
    rowCount === 0
  )
    return { start: 0, end: 0 };
  const rowTop = top + CHART_VERTICAL_PADDING_PX / 2;
  return {
    start: Math.max(
      0,
      Math.floor((viewportTop - rowTop) / AGE_ROW_BAND_PX) - BUFFER_ROWS,
    ),
    end: Math.min(
      rowCount,
      Math.ceil((viewportBottom - rowTop) / AGE_ROW_BAND_PX) + BUFFER_ROWS,
    ),
  };
}

interface ViewportOptions {
  readonly rowCount: number;
  readonly viewMode: ViewMode;
  readonly onchange: (viewport: ChartViewport) => void;
}

/** Shared clipping boundary for both dashboard cards and nested series views. */
export function chartViewport(node: HTMLElement, options: ViewportOptions) {
  const root = node.closest<HTMLElement>(".series-market-scroll");
  let frame = 0;
  let previous: ChartViewport | undefined;
  const measure = () => {
    const bounds = node.getBoundingClientRect();
    const clip = root?.getBoundingClientRect();
    const top = Math.max(0, clip?.top ?? 0);
    const bottom = Math.min(
      window.innerHeight,
      clip?.bottom ?? window.innerHeight,
    );
    const visible = bounds.bottom > top && bounds.top < bottom && bottom > top;
    const rows = root
      ? options.viewMode === "age"
        ? chartWindow(options.rowCount, bounds.top, bounds.bottom, top, bottom)
        : { start: 0, end: visible ? options.rowCount : 0 }
      : { start: 0, end: options.rowCount };
    const next = { rows, visible };
    if (
      previous?.rows.start === rows.start &&
      previous.rows.end === rows.end &&
      previous.visible === visible
    )
      return;
    previous = next;
    options.onchange(next);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(node);
  if (root) resize.observe(root);
  const intersection = new IntersectionObserver(schedule, { root });
  intersection.observe(node);
  document.addEventListener("scroll", schedule, true);
  document.addEventListener("toggle", schedule, true);
  window.addEventListener("resize", schedule);
  schedule();
  return {
    update(next: ViewportOptions) {
      options = next;
      schedule();
    },
    destroy() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("toggle", schedule, true);
      window.removeEventListener("resize", schedule);
    },
  };
}
