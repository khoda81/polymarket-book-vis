import type { PublicClient } from "@polymarket/client";

// Wall time cannot accidentally be passed as the pressure opacity reference.
declare const observationTimeBrand: unique symbol;
export type ObservationTime = number & {
  readonly [observationTimeBrand]: true;
};

/** Boundary between timestamped pressure histories and display-time projection. */
export function observationTime(value: number): ObservationTime {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(
      "observation time must be a finite nonnegative timestamp",
    );
  return value as ObservationTime;
}

export interface ObservationPoint {
  readonly tokenId: string;
  readonly observedAtMs: ObservationTime;
}

export interface ObservationDescription {
  readonly name: string;
  readonly color: string;
}

export interface ObservedToken
  extends ObservationPoint, ObservationDescription {}

export type ObservationReference =
  | { readonly kind: "unobserved" }
  | { readonly kind: "observed"; readonly newestMs: ObservationTime };

export type ObservationFrame =
  | { readonly kind: "unobserved" }
  | {
      readonly kind: "observed";
      readonly newestMs: ObservationTime;
      readonly tokens: readonly ObservedToken[];
    };

export function opacityReference(frame: ObservationReference): ObservationTime {
  // Unobserved fields have no finite pressure; persistent terminal fields ignore time.
  return frame.kind === "observed" ? frame.newestMs : observationTime(0);
}

/**
 * One source of truth for observation time. Presentation is derived only when
 * a consumer needs the full token list; there is no separately stored/latest
 * timestamp that can drift out of sync with the points.
 */
export interface ObservationSource {
  readonly points: () => Iterable<ObservationPoint>;
  readonly describe: (tokenId: string) => ObservationDescription;
}

type ObservationListener = (reference: ObservationReference) => void;
type ObservationNotifyScheduler = (notify: () => void) => void;

export class ObservationClock {
  private readonly sources = new Set<ObservationSource>();
  private readonly listeners = new Set<ObservationListener>();
  private notifyPending = false;

  constructor(
    private readonly scheduleNotify: ObservationNotifyScheduler = scheduleObservationNotify,
  ) {}

  register(source: ObservationSource): () => void {
    this.sources.add(source);
    this.changed();
    return () => {
      this.sources.delete(source);
      this.changed();
    };
  }

  subscribe(listener: ObservationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  changed(): void {
    if (this.listeners.size === 0 || this.notifyPending) return;
    this.notifyPending = true;
    this.scheduleNotify(() => {
      this.notifyPending = false;
      if (this.listeners.size === 0) return;

      // Observation changes are visual invalidations. Collapse every book
      // update in one display frame into one derived reference instead of
      // rescanning every chart for every websocket event.
      const reference = this.readReference();
      for (const listener of this.listeners) listener(reference);
    });
  }

  readReference(): ObservationReference {
    let newestMs: ObservationTime | undefined;
    for (const source of this.sources) {
      for (const point of source.points()) {
        if (newestMs === undefined || point.observedAtMs > newestMs)
          newestMs = point.observedAtMs;
      }
    }
    return newestMs === undefined
      ? { kind: "unobserved" }
      : { kind: "observed", newestMs };
  }

  read(): ObservationFrame {
    // Keep only the newest point for each token, remembering the source whose
    // presentation belongs to that point. newestMs is derived from the same
    // points in this pass, so it cannot disagree with the token observations.
    const tokens = new Map<
      string,
      { readonly point: ObservationPoint; readonly source: ObservationSource }
    >();
    let newestMs: ObservationTime | undefined;

    for (const source of this.sources) {
      for (const point of source.points()) {
        if (newestMs === undefined || point.observedAtMs > newestMs)
          newestMs = point.observedAtMs;

        const previous = tokens.get(point.tokenId);
        if (!previous || point.observedAtMs > previous.point.observedAtMs)
          tokens.set(point.tokenId, { point, source });
      }
    }

    if (newestMs === undefined) return { kind: "unobserved" };

    return {
      kind: "observed",
      newestMs,
      tokens: [...tokens.values()].map(({ point, source }) => ({
        ...point,
        ...source.describe(point.tokenId),
      })),
    };
  }
}

function scheduleObservationNotify(notify: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => notify());
    return;
  }
  queueMicrotask(notify);
}

const clocks = new WeakMap<PublicClient, ObservationClock>();
export function observationClock(client: PublicClient): ObservationClock {
  let clock = clocks.get(client);
  if (!clock) {
    clock = new ObservationClock();
    clocks.set(client, clock);
  }
  return clock;
}
