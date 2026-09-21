import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecorderStore } from "./recorderStore";

test("RecorderStore persists only token rows and restores live bands as ghosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.write([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 100,
        savedAtMs: 1_000,
        cells: [
          {
            lo: 0,
            hi: 1,
            bands: [
              {
                loVolume: 0,
                hiVolume: 42,
                side: 1,
                state: { kind: "live" },
              },
            ],
          },
        ],
      },
    ]);
    store.close();

    const reopened = new RecorderStore(dbPath);
    const rows = reopened.loadAll(2_000);
    reopened.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe("token-a");
    expect(rows[0]?.recordingSinceMs).toBe(100);
    expect(rows[0]?.cells?.[0]?.bands[0]?.state).toEqual({
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
