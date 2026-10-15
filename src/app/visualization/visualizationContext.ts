import { getContext, onMount, setContext } from "svelte";
import { AgeStripTuningStore } from "@/chart/age/ageStripTuningStore";
import { ObservationClock } from "@/domain/pressure/observationClock";
import { PresentationCoordinator } from "@/chart/presentationCoordinator";
import { MarketState } from "@/domain/markets/marketState";
import { startWallClock, WallClock } from "@/shared/wallClock";
import type { PublicClient } from "@polymarket/client";

const VISUALIZATION_CONTEXT = Symbol("lobservatory.visualization");

export interface VisualizationContext {
  readonly client: PublicClient;
  readonly observations: ObservationClock;
  readonly wallClock: WallClock;
  readonly tuning: AgeStripTuningStore;
  readonly presentation: PresentationCoordinator;
  readonly markets: MarketState;
}

/**
 * Establish the dashboard-wide visualization scope.
 *
 * Context owns dependency identity; the objects inside it own reactive state.
 * Descendants subscribe only to the fields they actually read.
 */
export function provideVisualizationContext(
  client: PublicClient,
): VisualizationContext {
  const context: VisualizationContext = {
    client,
    observations: new ObservationClock(),
    wallClock: new WallClock(),
    tuning: new AgeStripTuningStore(
      typeof window === "undefined" ? null : window.localStorage,
    ),
    presentation: new PresentationCoordinator(),
    markets: new MarketState(
      typeof window === "undefined" ? null : window.localStorage,
    ),
  };
  setContext(VISUALIZATION_CONTEXT, context);
  onMount(() => startWallClock(context.wallClock));
  return context;
}

export function getVisualizationContext(): VisualizationContext {
  const context = getContext<VisualizationContext>(VISUALIZATION_CONTEXT);
  if (!context)
    throw new Error("Visualization context is not available in this subtree");
  return context;
}
