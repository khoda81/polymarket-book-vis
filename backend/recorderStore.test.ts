import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
        savedAtMs: 1_000,
        hasPressure: true,
      },
    ]);
    expect(reopened.load("missing")).toBeNull();
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

test("RecorderStore reads uncompressed legacy SQLite rows on demand", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-plain-sqlite-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.close();

    const memory = new PressureFrontierMemory();
    memory.updateLevels("bid", [{ price: 0.5, shares: 42 }], 500);
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO token_state
       (token_id, status, recording_since_ms, cells_json, saved_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("plain", "watched", 100, JSON.stringify(memory.snapshot()), 1_000);
    db.close();

    const reopened = new RecorderStore(dbPath);
    expect(reopened.loadIndex()[0]?.hasPressure).toBe(true);
    const record = reopened.load("plain", 2_000);
    reopened.close();

    const restored = new PressureFrontierMemory();
    restored.restore(record?.pressure);
    expect(restored.shellsAtPrice(0.4)[0]?.state).toEqual({
      kind: "ghost",
      sinceMs: 1_000,
    });
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
