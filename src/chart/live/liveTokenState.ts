import type { MutableTokenBook, TokenBook } from "@/domain/books/orderBook";

export interface ObservedTokenBook {
  readonly book: TokenBook;
  readonly validThroughMs: number;
}

/** The stream's own observation; only the live stream mutates its book. */
interface StreamObservation {
  readonly book: MutableTokenBook;
  readonly validThroughMs: number;
}

type TokenStreamState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "awaiting-snapshot";
      readonly cached: StreamObservation | null;
      readonly requestedAtMs: number | null;
      readonly marketKey: string | null;
    }
  | {
      readonly kind: "live";
      readonly observed: StreamObservation;
      readonly marketKey: string | null;
    };

export interface AcceptedSnapshot extends ObservedTokenBook {
  readonly firstOnStream: boolean;
}

/** Owns the valid transitions for one token across websocket streams. */
export class LiveTokenState {
  private state: TokenStreamState = { kind: "idle" };

  get observed(): ObservedTokenBook | null {
    return this.observation;
  }

  private get observation(): StreamObservation | null {
    switch (this.state.kind) {
      case "idle":
        return null;
      case "awaiting-snapshot":
        return this.state.cached;
      case "live":
        return this.state.observed;
    }
  }

  get book(): TokenBook | undefined {
    return this.observed?.book;
  }

  get synchronized(): boolean {
    return this.state.kind === "live";
  }

  get marketKey(): string | null {
    return this.state.kind === "idle" ? null : this.state.marketKey;
  }

  beginStream(requestedAtMs: number): void {
    this.state = {
      kind: "awaiting-snapshot",
      cached: this.observation,
      requestedAtMs,
      marketKey: null,
    };
  }

  disconnect(): void {
    this.state = {
      kind: "awaiting-snapshot",
      cached: this.observation,
      requestedAtMs: null,
      marketKey: null,
    };
  }

  associateMarket(marketKey: string): void {
    if (this.state.kind === "idle") return;
    this.state = { ...this.state, marketKey };
  }

  acceptSnapshot(
    book: MutableTokenBook,
    marketWatermarkMs: number | undefined,
  ): AcceptedSnapshot {
    const firstOnStream = this.state.kind !== "live";
    const cached = this.observed;
    const requestedAtMs =
      this.state.kind === "awaiting-snapshot"
        ? (this.state.requestedAtMs ?? undefined)
        : undefined;
    const validThroughMs = causalMax(
      cached?.validThroughMs,
      marketWatermarkMs,
      firstOnStream ? requestedAtMs : undefined,
    );
    if (validThroughMs === undefined)
      throw new Error("book snapshot has no causal watermark");

    const observed = { book, validThroughMs };
    const marketKey = this.marketKey;
    this.state = { kind: "live", observed, marketKey };
    return { ...observed, firstOnStream };
  }

  streamBook(): MutableTokenBook | null {
    return this.state.kind === "live" ? this.state.observed.book : null;
  }

  advanceThrough(watermarkMs: number | undefined): number | null {
    if (this.state.kind !== "live" || watermarkMs === undefined) return null;
    const previous = this.state.observed.validThroughMs;
    const validThroughMs = this.confirmThrough(watermarkMs);
    return validThroughMs === previous ? null : validThroughMs;
  }

  confirmThrough(watermarkMs: number | undefined): number {
    if (this.state.kind !== "live")
      throw new Error("cannot advance a token before its stream snapshot");
    const validThroughMs =
      watermarkMs === undefined
        ? this.state.observed.validThroughMs
        : Math.max(this.state.observed.validThroughMs, watermarkMs);
    if (validThroughMs !== this.state.observed.validThroughMs)
      this.state = {
        ...this.state,
        observed: { ...this.state.observed, validThroughMs },
      };
    return validThroughMs;
  }
}

function causalMax(
  ...values: readonly (number | undefined)[]
): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    result = result === undefined ? value : Math.max(result, value);
  }
  return result;
}
