import { expect, test } from "bun:test";
import { MarketState } from "./marketState";
import type { MarketId } from "@polymarket/client";

test("shared visibility choices survive reload and override closed/resolved defaults", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const id = "5130978" as MarketId;
  const first = new MarketState(storage);
  first.reconcile(id, { kind: "live" });
  first.userSetVisible(id, false);
  const reloaded = new MarketState(storage);
  reloaded.reconcile(id, { kind: "awaiting-resolution" });
  expect(reloaded.visibilityFor(id)).toEqual({
    kind: "hidden",
    reason: "user",
  });
  reloaded.userSetVisible(id, true);
  reloaded.resolve(
    id,
    { kind: "resolved", winningTokenId: "yes" as never, winningOutcome: "Yes" },
    1_000,
  );
  reloaded.reconcile(id, { kind: "live" });
  expect(reloaded.lifecycles.get(id)?.kind).toBe("resolved");
  expect(reloaded.visibilityFor(id)).toEqual({ kind: "visible" });
  const again = new MarketState(storage);
  again.reconcile(id, { kind: "awaiting-resolution" });
  expect(again.visibilityFor(id)).toEqual({ kind: "visible" });
});

test("a stream winner supersedes metadata-derived endpoint prices", () => {
  const markets = new MarketState(null);
  const id = "1" as MarketId;
  markets.reconcile(id, {
    kind: "resolved",
    winningTokenId: "no" as never,
    winningOutcome: "No",
  });
  markets.resolve(
    id,
    { kind: "resolved", winningTokenId: "yes" as never, winningOutcome: "Yes" },
    1_000,
  );
  markets.reconcile(id, {
    kind: "resolved",
    winningTokenId: "no" as never,
    winningOutcome: "No",
  });
  expect(markets.lifecycles.get(id)).toMatchObject({ winningOutcome: "Yes" });
});
