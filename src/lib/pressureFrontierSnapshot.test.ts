import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import {
  parsePressureFrontierSnapshot,
  rebasePressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

test("frontier snapshot round trip preserves visible shells", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("bid", [{ price: 0.6, shares: 100 }], 1_000);
  source.updateLevels("bid", [{ price: 0.6, shares: 40 }], 2_000);
  source.updateLevels("ask", [{ price: 0.5, shares: 70 }], 3_000);
  source.updateLevels("ask", [{ price: 0.5, shares: 0 }], 4_000);

  const parsed = parsePressureFrontierSnapshot(
    JSON.parse(JSON.stringify(source.snapshot())),
  );
  const restored = new PressureFrontierMemory();
  restored.restore(parsed);

  for (const price of [0.1, 0.49, 0.55, 0.59, 0.8])
    expect(restored.shellsAtPrice(price)).toEqual(source.shellsAtPrice(price));
});

test("rebasing preserves ghost ages across clocks", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("bid", [{ price: 0.5, shares: 50 }], 8_000);
  source.updateLevels("bid", [{ price: 0.5, shares: 0 }], 9_000);

  const rebased = rebasePressureFrontierSnapshot(
    source.snapshot(),
    10_000,
    100_000,
  );

  expect(rebased.bid.history[0]?.sinceMs).toBe(99_000);
});
