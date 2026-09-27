import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../src/lib/price";
import { RecorderStore } from "./recorderStore";

test("RecorderStore persists timestamped pressure without temporal rewriting", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const memory = new PressureFrontierMemory();
    memory.updateLevels([{ price: p(0.5), shares: 42 }], 500);

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
          "SELECT typeof(pressure) AS type FROM token_state",
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
    expect(restored.bandsAtPrice(p(0.6))).toEqual([
      {
        loVolume: 0,
        hiVolume: 42,
        validThroughMs: 500,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecorderStore conservatively migrates ownership-era ask history", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-v1-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.close();

    const legacy = {
      bid: { current: [] },
      // Old ask frontiers used complemented local keys: 0.5 -> token price 0.5.
      ask: { current: [{ key: p(0.5), weight: 40 }] },
      field: {
        revision: 3,
        runs: [
          {
            lo: p(0),
            hi: p(0.5),
            bidVolume: 0,
            askVolume: 0,
            bidRevision: 0,
            askRevision: 0,
            bands: [],
          },
          {
            lo: p(0.5),
            hi: p(1),
            bidVolume: 40,
            askVolume: 40,
            bidRevision: 3,
            askRevision: 2,
            bands: [
              {
                loVolume: 0,
                hiVolume: 40,
                side: 1,
                validThroughMs: 3_000,
              },
              {
                loVolume: 40,
                hiVolume: 100,
                side: -1,
                validThroughMs: 1_000,
              },
            ],
          },
        ],
      },
    };

    const raw = new Database(dbPath);
    raw
      .query(
        `INSERT INTO token_state
          (token_id, status, recording_since_ms, pressure)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "token-v1",
        "watched",
        500,
        gzipSync(JSON.stringify(legacy), { level: 1 }),
      );
    raw.close();

    const reopened = new RecorderStore(dbPath);
    const record = reopened.load("token-v1");
    reopened.close();

    const restored = new PressureFrontierMemory();
    restored.restore(record?.pressure);

    expect(restored.currentLevels()).toEqual([{ key: p(0.5), weight: 40 }]);
    expect(restored.bandsAtPrice(p(0.75))).toEqual([
      {
        loVolume: 0,
        hiVolume: 40,
        validThroughMs: 3_000,
      },
      {
        loVolume: 40,
        hiVolume: 100,
        validThroughMs: 1_000,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
