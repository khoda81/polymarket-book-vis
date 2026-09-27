import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../src/lib/price";
import { RECORDER_DATABASE_VERSION, RecorderStore } from "./recorderStore";

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
    expect(raw.query("PRAGMA user_version").get()).toEqual({
      user_version: RECORDER_DATABASE_VERSION,
    });
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

test("RecorderStore rejects databases that require migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-old-version-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.close();

    const raw = new Database(dbPath);
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    expect(() => new RecorderStore(dbPath)).toThrow(
      `Recorder database version 2 requires migration to ${RECORDER_DATABASE_VERSION}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
