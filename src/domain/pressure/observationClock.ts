import { SvelteMap, SvelteSet } from "svelte/reactivity";

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

/** Derive the causal time reference for exactly this set of observations. */
export function observationReference(
  points: Iterable<ObservationPoint>,
): ObservationReference {
  let newestMs: ObservationTime | undefined;
  for (const point of points)
    if (newestMs === undefined || point.observedAtMs > newestMs)
      newestMs = point.observedAtMs;

  return newestMs === undefined
    ? { kind: "unobserved" }
    : { kind: "observed", newestMs };
}

/**
 * One directly reactive observation source.
 *
 * The map is the state. ObservationClock does not have a parallel revision or
 * notification channel; Svelte tracks map iteration in read().
 */
export interface ObservationSource {
  readonly points: ReadonlyMap<string, ObservationPoint>;
  readonly describe: (tokenId: string) => ObservationDescription;
}

/**
 * Update a reactive observation map without generating invalidations when its
 * logical contents are unchanged.
 */
export function syncObservationPoints(
  target: Map<string, ObservationPoint>,
  points: Iterable<ObservationPoint>,
): void {
  const next = new Map<string, ObservationPoint>();
  for (const point of points) {
    const previous = next.get(point.tokenId);
    if (!previous || point.observedAtMs > previous.observedAtMs)
      next.set(point.tokenId, point);
  }

  for (const tokenId of target.keys())
    if (!next.has(tokenId)) target.delete(tokenId);

  for (const [tokenId, point] of next) {
    const previous = target.get(tokenId);
    if (previous?.observedAtMs === point.observedAtMs) continue;
    target.set(tokenId, point);
  }
}

/**
 * Reactive aggregation of observation sources within one visualization scope.
 *
 * Both source membership and the observation maps themselves are reactive.
 * Consumers therefore depend directly on the timestamps they display.
 */
export class ObservationClock {
  private readonly sources = new SvelteSet<ObservationSource>();
  private readonly reference = new SvelteMap<"newest", ObservationTime>();

  /**
   * Advance the visualization-wide causal clock.
   *
   * The clock is monotonic and independent of source visibility. Removing or
   * hiding the source that most recently advanced time must never make pressure
   * become younger again.
   */
  advance(value: number | ObservationTime): void {
    const next = observationTime(value);
    const current = this.reference.get("newest");
    if (current !== undefined && next <= current) return;
    this.reference.set("newest", next);
  }

  readReference(): ObservationReference {
    const newestMs = this.reference.get("newest");
    return newestMs === undefined
      ? { kind: "unobserved" }
      : { kind: "observed", newestMs };
  }

  register(source: ObservationSource): () => void {
    this.sources.add(source);
    for (const point of source.points.values()) this.advance(point.observedAtMs);
    return () => {
      this.sources.delete(source);
    };
  }

  read(): ObservationFrame {
    const tokens = new Map<
      string,
      { readonly point: ObservationPoint; readonly source: ObservationSource }
    >();
    const reference = this.readReference();

    for (const source of this.sources) {
      for (const point of source.points.values()) {
        const previous = tokens.get(point.tokenId);
        if (!previous || point.observedAtMs > previous.point.observedAtMs)
          tokens.set(point.tokenId, { point, source });
      }
    }

    if (tokens.size === 0 || reference.kind === "unobserved")
      return { kind: "unobserved" };

    return {
      kind: "observed",
      newestMs: reference.newestMs,
      tokens: [...tokens.values()].map(({ point, source }) => ({
        ...point,
        ...source.describe(point.tokenId),
      })),
    };
  }
}
