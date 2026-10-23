import { SvelteMap } from "svelte/reactivity";
import type { MarketId } from "@polymarket/client";
import type { MarketLifecycle } from "./marketLifecycle";
import {
  initialMarketVisibility,
  loadStoredMarketVisibility,
  persistStoredMarketVisibility,
  type KeyValueStorage,
  type StoredMarketVisibility,
} from "./marketVisibility";

/** Dashboard-wide facts and choices, independent of chart/viewport lifetimes. */
export class MarketState {
  readonly #lifecycles = new SvelteMap<MarketId, MarketLifecycle>();
  readonly #resolvedAtMs = new SvelteMap<MarketId, number>();
  private readonly choices: SvelteMap<string, StoredMarketVisibility>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: KeyValueStorage | null) {
    this.choices = new SvelteMap(
      storage ? loadStoredMarketVisibility(storage) : [],
    );
  }

  /** Read-only: reconcile() and resolve() keep visibility in step with lifecycle. */
  get lifecycles(): ReadonlyMap<MarketId, MarketLifecycle> {
    return this.#lifecycles;
  }

  get resolvedAtMs(): ReadonlyMap<MarketId, number> {
    return this.#resolvedAtMs;
  }

  reconcile(marketId: MarketId, lifecycle: MarketLifecycle): void {
    const current = this.#lifecycles.get(marketId);
    // A stale Gamma response cannot erase a winner observed on the stream.
    if (current?.kind === "resolved" || current?.kind === lifecycle.kind)
      return;
    this.#lifecycles.set(marketId, lifecycle);
    if (lifecycle.kind === "resolved")
      this.autoHide(marketId, "hidden-resolved");
    this.notify();
  }

  visibilityFor(marketId: MarketId, availableForLiveOrders: boolean) {
    return initialMarketVisibility(
      this.choices.get(marketId),
      this.#lifecycles.get(marketId) ?? { kind: "live" },
      availableForLiveOrders,
    );
  }

  resolve(
    marketId: MarketId,
    lifecycle: Extract<MarketLifecycle, { kind: "resolved" }>,
    timestamp: number | null,
  ): void {
    this.#lifecycles.set(marketId, lifecycle);
    if (timestamp !== null) this.#resolvedAtMs.set(marketId, timestamp);
    this.autoHide(marketId, "hidden-resolved");
    this.notify();
  }

  userSetVisible(marketId: MarketId, visible: boolean): void {
    this.setChoice(marketId, visible ? "visible-user" : "hidden-user");
  }

  autoHide(
    marketId: MarketId,
    reason: "hidden-empty" | "hidden-resolved",
  ): void {
    const choice = this.choices.get(marketId);
    if (choice === "visible-user" || choice === "hidden-user") return;
    if (choice === "hidden-resolved" && reason === "hidden-empty") return;
    this.setChoice(marketId, reason);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setChoice(marketId: MarketId, choice: StoredMarketVisibility): void {
    if (this.choices.get(marketId) === choice) return;
    this.choices.set(marketId, choice);
    if (this.storage)
      persistStoredMarketVisibility(marketId, choice, this.storage);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
