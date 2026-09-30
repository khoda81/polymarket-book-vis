import {
  getAgeStripTuning,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import { ghostLegendTicks } from "@/lib/ghostLegendTicks";
import {
  ghostObservationColumns,
  type GhostObservationColumn,
} from "@/lib/ghostObservationMarkers";
import { relativeTimeDisplay } from "@/lib/math";
import {
  hideSharedTooltip,
  releaseSharedTooltip,
  showSharedTooltip,
} from "@/lib/sharedTooltip";
import {
  observationClock,
  type ObservationFrame,
} from "@/lib/observationClock";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import type { PublicClient } from "@polymarket/client";

const HEIGHT = 28;
const INSET = 4;
const MARKER_TOP = 0;
const MARKER_HEIGHT = 3;
const BAR_TOP = 4;
const BAR_HEIGHT = 7;

interface GhostHoverPointer {
  readonly x: number;
  readonly clientX: number;
  readonly anchorY: number;
}

/** Only this small canvas animates while the observation clock is stationary. */
export class GhostMemoryScale {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltipOwner = Symbol("ghost-memory-tooltip");
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribeTuning: () => void;
  private readonly unsubscribeObservation: () => void;
  private readonly themeQuery = window.matchMedia(
    "(prefers-color-scheme: dark)",
  );
  private raf: number | null = null;
  private textColor = "";
  private styleDirty = true;
  private observationFrame: ObservationFrame = { kind: "unobserved" };
  private hoverPointer: GhostHoverPointer | null = null;
  private tooltipList: HTMLDivElement | null = null;
  private markerCache: {
    readonly frame: Extract<ObservationFrame, { kind: "observed" }>;
    readonly width: number;
    readonly halfLife: number;
    readonly dpr: number;
    readonly values: readonly GhostObservationColumn[];
  } | null = null;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly latencyLabel: HTMLSpanElement,
    client: PublicClient,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("Canvas2D is required for the ghost-memory scale");
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.requestPaint());
    this.resizeObserver.observe(canvas);
    this.unsubscribeTuning = subscribeAgeStripTuning(() => this.requestPaint());

    const clock = observationClock(client);
    this.observationFrame = clock.read();
    this.unsubscribeObservation = clock.subscribe(() => {
      this.observationFrame = clock.read();
      this.markerCache = null;
      this.requestPaint();
    });
    this.themeQuery.addEventListener("change", this.handleThemeChange);
    canvas.addEventListener("pointermove", this.handlePointer);
    canvas.addEventListener("pointerleave", this.clearPointer);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.requestPaint();
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unsubscribeTuning();
    this.unsubscribeObservation();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
    this.canvas.removeEventListener("pointermove", this.handlePointer);
    this.canvas.removeEventListener("pointerleave", this.clearPointer);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.latencyLabel.textContent = "";
    this.tooltipList = null;
    releaseSharedTooltip(this.tooltipOwner);
  }

  private readonly handleThemeChange = (): void => {
    this.styleDirty = true;
    this.requestPaint();
  };

  private readonly requestPaint = (): void => {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (this.paint()) this.requestPaint();
    });
  };

  private paint(): boolean {
    const frame = this.observationFrame;
    const { ghostHalfLifeMs } = getAgeStripTuning();
    const width = this.canvas.clientWidth;
    if (width <= INSET * 2) return false;
    const dpr = window.devicePixelRatio || 1;
    const deviceWidth = Math.round(width * dpr);
    const deviceHeight = Math.round(HEIGHT * dpr);
    if (this.canvas.width !== deviceWidth) this.canvas.width = deviceWidth;
    if (this.canvas.height !== deviceHeight) this.canvas.height = deviceHeight;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    if (this.styleDirty || this.textColor === "") {
      this.textColor = getComputedStyle(this.canvas).color;
      this.styleDirty = false;
    }
    const textColor = this.textColor;
    const gradient = ctx.createLinearGradient(INSET, 0, width - INSET, 0);
    gradient.addColorStop(0, textColor);
    gradient.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.68;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(
      INSET,
      BAR_TOP,
      width - INSET * 2,
      BAR_HEIGHT,
      BAR_HEIGHT / 2,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = textColor;
    if (frame.kind === "unobserved") {
      this.latencyLabel.textContent = "";
      ctx.textAlign = "left";
      ctx.fillText("awaiting observation", INSET, HEIGHT);
      this.canvas.setAttribute(
        "aria-label",
        "Ghost memory: awaiting observation",
      );
      return false;
    }
    const stalenessMs = Math.max(0, Date.now() - frame.newestMs);
    const span = width - INSET * 2;
    const ticks = ghostLegendTicks(ghostHalfLifeMs, span, {
      minDistancePx: 32,
      originAgeMs: stalenessMs,
    });
    const originLabel = relativeTimeDisplay(
      stalenessMs / 1_000,
      "elapsed",
    ).text;
    if (this.latencyLabel.textContent !== originLabel)
      this.latencyLabel.textContent = originLabel;
    const originLabelWidth = ctx.measureText(originLabel).width;
    // Center the DOM label on the rounded left cap without moving the actual
    // age-transform origin at INSET.
    const originLabelCenterX = INSET + BAR_HEIGHT / 2;
    let rightEdge = originLabelCenterX + originLabelWidth / 2 + 8;

    // Cut tick marks out of the gradient instead of painting them with the
    // same foreground color. This preserves the old high-contrast appearance
    // in both light and dark themes.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    for (const tick of ticks) {
      const x = INSET + tick.position * span;
      ctx.globalAlpha = tick.opacity;
      ctx.fillRect(x, BAR_TOP - 1, 1, BAR_HEIGHT + 2);
    }
    ctx.restore();

    for (const tick of ticks) {
      const x = INSET + tick.position * span;
      const labelWidth = ctx.measureText(tick.label).width;
      if (x - labelWidth / 2 < rightEdge || x + labelWidth / 2 > width)
        continue;
      ctx.globalAlpha = tick.opacity;
      ctx.fillText(tick.label, x, HEIGHT);
      rightEdge = x + labelWidth / 2 + 8;
    }
    ctx.globalAlpha = 1;
    const markerWidth = 1 / dpr;
    for (const column of this.observationColumns(
      frame,
      width,
      ghostHalfLifeMs,
      dpr,
    )) {
      const segmentHeight = MARKER_HEIGHT / column.tokens.length;
      for (const [index, token] of column.tokens.entries()) {
        ctx.fillStyle = token.color;
        ctx.fillRect(
          column.xCss - markerWidth / 2,
          MARKER_TOP + index * segmentHeight,
          markerWidth,
          segmentHeight,
        );
      }
    }
    const description = `Ghost memory: newest token observation ${originLabel} ago. Markers show token ages relative to that observation. Shift+wheel adjusts memory.`;
    if (this.canvas.getAttribute("aria-label") !== description)
      this.canvas.setAttribute("aria-label", description);
    if (this.hoverPointer)
      this.renderTooltip(this.hoverPointer, frame, width, ghostHalfLifeMs, dpr);
    return true;
  }

  private observationColumns(
    frame: Extract<ObservationFrame, { kind: "observed" }>,
    width: number,
    halfLife: number,
    dpr: number,
  ): readonly GhostObservationColumn[] {
    const cached = this.markerCache;
    if (
      cached &&
      cached.frame === frame &&
      cached.width === width &&
      cached.halfLife === halfLife &&
      cached.dpr === dpr
    )
      return cached.values;

    const values = ghostObservationColumns(frame, halfLife, width, dpr, INSET);
    this.markerCache = { frame, width, halfLife, dpr, values };
    return values;
  }

  private readonly handlePointer = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.hoverPointer = {
      x: event.clientX - rect.left,
      clientX: event.clientX,
      anchorY: rect.bottom,
    };

    const frame = this.observationFrame;
    if (frame.kind === "unobserved") {
      hideSharedTooltip(this.tooltipOwner);
      return;
    }

    const width = this.canvas.clientWidth;
    const halfLife = getAgeStripTuning().ghostHalfLifeMs;
    const dpr = window.devicePixelRatio || 1;
    this.renderTooltip(this.hoverPointer, frame, width, halfLife, dpr);
  };

  private readonly clearPointer = (): void => {
    this.hoverPointer = null;
    this.tooltipList = null;
    hideSharedTooltip(this.tooltipOwner);
  };
  private renderTooltip(
    pointer: GhostHoverPointer,
    frame: Extract<ObservationFrame, { kind: "observed" }>,
    width: number,
    halfLifeMs: number,
    dpr: number,
  ): void {
    if (!(width > INSET * 2)) {
      hideSharedTooltip(this.tooltipOwner);
      return;
    }

    // The cursor is a cutoff on the age axis. Show every observation at or
    // to its older/right side so a one-physical-pixel marker never has to be
    // hit precisely just to identify a stale token.
    const afterCursor = this.observationColumns(frame, width, halfLifeMs, dpr)
      .filter((column) => column.xCss >= pointer.x)
      .flatMap((column) =>
        [...column.tokens].sort(
          (left, right) => right.observedAtMs - left.observedAtMs,
        ),
      );

    if (afterCursor.length === 0) {
      this.tooltipList = null;
      hideSharedTooltip(this.tooltipOwner);
      return;
    }

    const afterCursorSignature = afterCursor
      .map((token) => {
        const age = relativeTimeDisplay(
          Math.max(0, Date.now() - token.observedAtMs) / 1_000,
          "elapsed",
        ).text;
        return `${token.tokenId}:${age}`;
      })
      .join(",");
    const previousScrollTop = this.tooltipList?.scrollTop ?? 0;
    showSharedTooltip(
      this.tooltipOwner,
      afterCursorSignature,
      (overlay) => {
        this.tooltipList = renderGhostTooltip(
          overlay,
          afterCursor.map((token) => ({
            name: token.name,
            color: token.color,
            age: relativeTimeDisplay(
              Math.max(0, Date.now() - token.observedAtMs) / 1_000,
              "elapsed",
            ).text,
          })),
        );
        this.tooltipList.scrollTop = previousScrollTop;
      },
      pointer.clientX,
      pointer.anchorY,
      "below",
    );
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (handleAgeStripTuningWheel(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const list = this.tooltipList;
    if (!list || list.scrollHeight <= list.clientHeight) return;

    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? list.clientHeight
          : 1;
    const before = list.scrollTop;
    list.scrollTop += event.deltaY * unit;
    if (list.scrollTop !== before) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

function renderGhostTooltip(
  overlay: HTMLDivElement,
  afterCursor: readonly {
    readonly name: string;
    readonly color: string;
    readonly age: string;
  }[],
): HTMLDivElement {
  overlay.replaceChildren();

  const list = document.createElement("div");
  list.className = "cpv-ghost-observation-list";
  for (const token of afterCursor) {
    const row = tooltipRow(token.name, token.age);
    row.firstElementChild?.setAttribute("style", `color: ${token.color}`);
    list.appendChild(row);
  }
  overlay.appendChild(list);
  return list;
}

function tooltipRow(name: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cpv-ov-row";

  const key = document.createElement("span");
  key.textContent = name;

  const amount = document.createElement("b");
  amount.textContent = value;

  row.append(key, amount);
  return row;
}
