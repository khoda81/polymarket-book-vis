import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../src/lib/price";
import { RecorderStore } from "./recorderStore";

test("RecorderStore persists timestamped pressure without temporal rewriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const memory = new PressureFrontierMemory();
    memory.updateLevels("bid", [{ price: p(0.5), shares: 42 }], 500);

    const store = new RecorderStore(dbPath);
    store.write([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 100,
        pressure: memory.snapshot(),
      },
    ]);
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(
      raw
        .query<{ type: string }, []>(
          "SELECT typeof(cells_json) AS type FROM token_state",
        )
        .get()?.type,
    ).toBe("blob");
    raw.close();

    const reopened = new RecorderStore(dbPath);
    expect(reopened.loadIndex()).toEqual([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 100,
        hasPressure: true,
      },
    ]);
    expect(reopened.load("missing")).toBeNull();
    const record = reopened.load("token-a");
    reopened.close();

    const restored = new PressureFrontierMemory();
    restored.restore(record?.pressure);
    expect(restored.shellsAtPrice(p(0.4))).toEqual([
      {
        loVolume: 0,
        hiVolume: 42,
        side: 1,
        validThroughMs: 500,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
