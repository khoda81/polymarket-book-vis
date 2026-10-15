import { relativeTimeOffsetDisplay } from "@/shared/math";
import type { WallClock, WallClockWatch } from "@/shared/wallClock";
import type { ViewMode } from "@/domain/markets/chartState";
import {
  ageRowYDirection,
  type AgeRowOrientation,
} from "./ageStripOrientation";
import {
  AGE_LABEL_HORIZONTAL_INSET_PX,
  ageStripRowCenterY,
  type AgeStripGeometry,
} from "./ageStripLayout";

export interface AgeStripTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
}

export interface AgeStripClockHost {
  readonly canvasWrap: HTMLElement;
  readonly wallClock: WallClock;
  readonly getGeometry: () => AgeStripGeometry | null;
  readonly getViewMode: () => ViewMode;
  readonly getTiming: (tokenId: string) => AgeStripTiming | undefined;
  readonly getRowOrientation: () => AgeRowOrientation;
  readonly getTokenName: (tokenId: string) => string;
  readonly getTokenColor: (primaryTokenId: string, opposite: boolean) => string;
}

interface ClockLabel {
  readonly element: HTMLSpanElement;
  readonly text: Text;
}

/** Token-local clocks update independently of the pressure renderer. */
export class AgeStripClock {
  private readonly layer: HTMLDivElement;
  private readonly labels = new Map<string, ClockLabel>();
  private readonly watch: WallClockWatch;
  private paused = false;

  constructor(private readonly host: AgeStripClockHost) {
    this.layer = document.createElement("div");
    this.layer.className = "cpv-clock-annotations";
    // This overlay is absolutely positioned and cannot affect card geometry.
    // Masonry can therefore ignore its internal mutations entirely.
    this.layer.setAttribute("data-masonry-layout-neutral", "");
    host.canvasWrap.appendChild(this.layer);
    this.watch = host.wallClock.watch((nowMs) => this.render(nowMs));
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.refresh();
  }

  refresh(): void {
    this.watch.refresh();
  }

  private render(nowMs: number): number | null {
    if (this.paused) return null;
    const geometry = this.host.getGeometry();
    if (!geometry || this.host.getViewMode() !== "age") {
      this.clear();
      return null;
    }
    const retained = new Set<string>();
    const { viewport: vp } = geometry;
    const timeX = Math.max(4, vp.l - AGE_LABEL_HORIZONTAL_INSET_PX);
    let nextChangeMs = Infinity;

    for (const row of geometry.rows) {
      const center = ageStripRowCenterY(geometry, row);
      if (center < vp.t - 24 || center > vp.t + vp.height + 24) continue;
      for (const [opposite, tokenId] of [
        [false, row.tokenId],
        [true, row.oppositeTokenId],
      ] as const) {
        if (!tokenId) continue;
        const timing = this.host.getTiming(tokenId);
        const color = this.host.getTokenColor(row.tokenId, opposite);
        const name = this.host.getTokenName(tokenId);
        const since = timing?.recordingSinceMs;
        const age =
          since != null && Number.isFinite(since)
            ? relativeTimeOffsetDisplay((nowMs - since) / 1_000)
            : null;
        if (age?.nextChangeMs != null)
          nextChangeMs = Math.min(nextChangeMs, age.nextChangeMs);

        const label = this.label(tokenId, retained);
        const element = label.element;
        if (element.className !== "cpv-token-age")
          element.className = "cpv-token-age";
        if (element.style.color !== color) element.style.color = color;
        const left = `${timeX}px`;
        if (element.style.left !== left) element.style.left = left;
        const top = `${
          center +
          ageRowYDirection(opposite ? 1 : -1, this.host.getRowOrientation()) * 7
        }px`;
        if (element.style.top !== top) element.style.top = top;

        const text = age?.text ?? "—";
        this.setLabelText(label, text);
        const title = `${name} · ${
          age ? `Recorder age ${age.text}` : "Recorder age unavailable"
        }`;
        if (element.title !== title) {
          element.title = title;
          element.setAttribute("aria-label", title);
        }
      }
    }

    for (const [key, label] of this.labels) {
      if (retained.has(key)) continue;
      label.element.remove();
      this.labels.delete(key);
    }

    return Number.isFinite(nextChangeMs)
      ? nowMs + Math.ceil(nextChangeMs) + 1
      : null;
  }

  private label(key: string, retained: Set<string>): ClockLabel {
    retained.add(key);
    let label = this.labels.get(key);
    if (!label) {
      const element = document.createElement("span");
      const text = document.createTextNode("");
      element.appendChild(text);
      label = { element, text };
      this.labels.set(key, label);
      this.layer.appendChild(element);
    }
    return label;
  }

  private setLabelText(label: ClockLabel, text: string): void {
    // Mutate the existing Text node. Replacing textContent creates childList
    // mutations, which used to wake the masonry layout on every clock tick.
    if (label.text.data !== text) label.text.data = text;
  }

  private clear(): void {
    this.layer.replaceChildren();
    this.labels.clear();
  }

  destroy(): void {
    this.watch.destroy();
    this.clear();
    this.layer.remove();
  }
}
