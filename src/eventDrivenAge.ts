import type { PolymarketCPV } from "./component";

/**
 * Age is event-driven state, not animation.
 *
 * The legacy age-tower view periodically requested redraws so its vertical
 * height appeared to grow continuously. The strip view stores transition
 * timestamps instead: book/spread events update the state, and age is derived
 * lazily as `now - staleSince` whenever some real event causes a render.
 *
 * Disable the legacy per-chart polling timer without changing websocket or
 * user-interaction redraws.
 */
export function disableAgePolling(chart: PolymarketCPV): void {
  const component = chart as unknown as {
    startAgeTimer(): void;
    ageTimer?: number;
  };

  if (component.ageTimer !== undefined) {
    clearInterval(component.ageTimer);
    component.ageTimer = undefined;
  }

  component.startAgeTimer = () => {};
}
