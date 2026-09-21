import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { RecorderStore } from "./recorderStore";

test("RecorderStore persists frontier state and restores live pressure as ghost history", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const memory = new PressureFrontierMemory();
    memory.updateLevels("bid", [{ price: 0.5, shares: 42 }], 500);

    const store = new RecorderStore(dbPath);
    store.write([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 100,
        savedAtMs: 1_000,
        pressure: memory.snapshot(),
      },
    ]);
    store.close();

    const reopened = new RecorderStore(dbPath);
    const rows = reopened.loadAll(2_000);
    reopened.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe("token-a");
    expect(rows[0]?.recordingSinceMs).toBe(100);

    const restored = new PressureFrontierMemory();
    restored.restore(rows[0]!.pressure!);
    expect(restored.shellsAtPrice(0.4)).toEqual([
      {
        loVolume: 0,
        hiVolume: 42,
        side: 1,
        state: { kind: "ghost", sinceMs: 1_000 },
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecorderStore migrates v2 JSON once and preserves the source as a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-migration-"));
  const dbPath = join(dir, "recorder.sqlite");
  const jsonPath = join(dir, "recorder.json");

  try {
    writeFileSync(
      jsonPath,
      JSON.stringify({
        version: 2,
        savedAtMs: 1_000,
        watchedTokenIds: ["watched"],
        completedTokenIds: ["done"],
        recordingSinceMs: {
          watched: 100,
          done: 200,
        },
        states: {
          watched: [
            {
              lo: 0,
              hi: 1,
              bands: [],
            },
          ],
          done: [
            {
              lo: 0,
              hi: 1,
              bands: [],
            },
          ],
        },
      }),
    );

    const store = new RecorderStore(dbPath);
    expect(store.migrateLegacyJson(jsonPath)).toBe(true);
    expect(store.migrateLegacyJson(jsonPath)).toBe(false);

    const rows = store
      .loadAll(2_000)
      .sort((a, b) => a.tokenId.localeCompare(b.tokenId));
    store.close();

    expect(rows.map((row) => [row.tokenId, row.status])).toEqual([
      ["done", "completed"],
      ["watched", "watched"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
