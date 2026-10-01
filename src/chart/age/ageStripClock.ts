import { relativeTimeDisplay, relativeTimeOffsetDisplay } from "@/shared/math";
import type { ViewMode } from "@/domain/markets/chartState";
import type { PublicClient } from "@polymarket/client";
import {
  observationClock,
  type ObservationDescription,
  type ObservationPoint,
  type ObservationTime,
} from "@/domain/pressure/observationClock";
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
  readonly client: PublicClient;
  readonly getViewMode: () => ViewMode;
  readonly getObservationTime: (tokenId: string) => ObservationTime | undefined;
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
  private geometry: AgeStripGeometry | null = null;
  private orientation: AgeRowOrientation;
  private enabled = true;
  private pending:
    { kind: "frame"; id: number } | { kind: "timer"; id: number } | null = null;
  private readonly unregisterSource: () => void;

  constructor(private readonly host: AgeStripClockHost) {
    this.orientation = host.getRowOrientation();
    this.layer = document.createElement("div");
    this.layer.className = "cpv-clock-annotations";
    // This overlay is absolutely positioned and cannot affect card geometry.
    // Masonry can therefore ignore its internal mutations entirely.
    this.layer.setAttribute("data-masonry-layout-neutral", "");
    host.canvasWrap.appendChild(this.layer);
    this.unregisterSource = observationClock(host.client).register({
      points: () => this.observationPoints(),
      describe: (tokenId) => this.describeObservation(tokenId),
    });
  }

  setGeometry(geometry: AgeStripGeometry | null): void {
    const previous = this.geometry;
    const orientation = this.host.getRowOrientation();
    const sourceChanged = !sameObservationRows(previous, geometry);
    const presentationChanged =
      orientation !== this.orientation || !sameGeometry(previous, geometry);

    this.geometry = geometry;
    this.orientation = orientation;
    if (sourceChanged) observationClock(this.host.client).changed();
    if (presentationChanged) this.refresh();
  }

  private *observationPoints(): Iterable<ObservationPoint> {
    if (!this.enabled || this.host.getViewMode() !== "age") return;
    for (const row of this.geometry?.rows ?? []) {
      for (const tokenId of [row.tokenId, row.oppositeTokenId]) {
        if (!tokenId) continue;
        const observedAtMs = this.host.getObservationTime(tokenId);
        if (observedAtMs !== undefined) yield { tokenId, observedAtMs };
      }
    }
  }

  private describeObservation(tokenId: string): ObservationDescription {
    for (const row of this.geometry?.rows ?? []) {
      if (row.tokenId === tokenId)
        return {
          name: this.host.getTokenName(tokenId),
          color: this.host.getTokenColor(row.tokenId, false),
        };
      if (row.oppositeTokenId === tokenId)
        return {
          name: this.host.getTokenName(tokenId),
          color: this.host.getTokenColor(row.tokenId, true),
        };
    }
    throw new Error(`observation source lost token geometry for ${tokenId}`);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    observationClock(this.host.client).changed();
    this.layer.hidden = !enabled;
    if (enabled) this.refresh();
    else this.clear();
  }

  refresh(): void {
    this.cancelPending();
    const geometry = this.geometry;
    if (!this.enabled || !geometry || this.host.getViewMode() !== "age") {
      this.clear();
      return;
    }
    const nowMs = Date.now();
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

      const resolutionMs = this.host.getTiming(row.tokenId)?.resolutionMs;
      if (resolutionMs != null && Number.isFinite(resolutionMs)) {
        const display = relativeTimeDisplay(
          Math.max(0, resolutionMs - nowMs) / 1000,
          "remaining",
        );
        const label = this.label(`resolution:${row.tokenId}`, retained);
        const element = label.element;
        if (element.className !== "cpv-row-resolution")
          element.className = "cpv-row-resolution";
        const left = `${timeX}px`;
        const top = `${center + 19}px`;
        if (element.style.left !== left) element.style.left = left;
        if (element.style.top !== top) element.style.top = top;
        this.setLabelText(
          label,
          display.text === "due" ? "due" : `T−${display.text}`,
        );
        if (display.nextChangeMs != null)
          nextChangeMs = Math.min(nextChangeMs, display.nextChangeMs);
      }
    }

    for (const [key, label] of this.labels) {
      if (retained.has(key)) continue;
      label.element.remove();
      this.labels.delete(key);
    }

    if (Number.isFinite(nextChangeMs)) {
      if (nextChangeMs < 34)
        this.pending = {
          kind: "frame",
          id: requestAnimationFrame(() => this.refresh()),
        };
      else
        this.pending = {
          kind: "timer",
          id: window.setTimeout(
            () => this.refresh(),
            Math.min(2_147_483_647, Math.ceil(nextChangeMs) + 1),
          ),
        };
    }
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

  private cancelPending(): void {
    if (this.pending?.kind === "frame") cancelAnimationFrame(this.pending.id);
    else if (this.pending?.kind === "timer")
      window.clearTimeout(this.pending.id);
    this.pending = null;
  }

  clear(): void {
    this.cancelPending();
    this.layer.replaceChildren();
    this.labels.clear();
  }

  reset(): void {
    this.setGeometry(null);
    this.clear();
  }

  destroy(): void {
    this.clear();
    this.unregisterSource();
    this.layer.remove();
  }
}

function sameObservationRows(
  a: AgeStripGeometry | null,
  b: AgeStripGeometry | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.rows.length !== b.rows.length) return false;
  return a.rows.every(
    (row, index) =>
      row.tokenId === b.rows[index]!.tokenId &&
      row.oppositeTokenId === b.rows[index]!.oppositeTokenId,
  );
}

function sameGeometry(
  a: AgeStripGeometry | null,
  b: AgeStripGeometry | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.canvasWidth !== b.canvasWidth ||
    a.canvasHeight !== b.canvasHeight ||
    a.viewport.l !== b.viewport.l ||
    a.viewport.t !== b.viewport.t ||
    a.viewport.width !== b.viewport.width ||
    a.viewport.height !== b.viewport.height ||
    a.rows.length !== b.rows.length
  )
    return false;

  return a.rows.every((row, index) => {
    const other = b.rows[index]!;
    return (
      row.tokenId === other.tokenId &&
      row.oppositeTokenId === other.oppositeTokenId &&
      row.centerY === other.centerY &&
      row.topY === other.topY &&
      row.bottomY === other.bottomY
    );
  });
}
