import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../src/lib/price";
import {
  RECORDER_CHECKPOINT_MUTATIONS,
  RECORDER_DATABASE_VERSION,
  RecorderStore,
} from "./recorderStore";

test("RecorderStore persists checkpointed pressure without temporal rewriting", () => {
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
        checkpoint: memory.snapshot(),
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
    expect(
      raw
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pressure_log",
        )
        .get()?.count,
    ).toBe(0);
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

test("RecorderStore replays incremental mutations and compacts them into a checkpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-log-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.write([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 500,
        mutations: [
          {
            kind: "replace",
            validThroughMs: 500,
            levels: [{ key: p(0.5), weight: 42 }],
          },
          {
            kind: "update",
            validThroughMs: 750,
            changes: [{ price: p(0.5), shares: 20 }],
          },
        ],
      },
    ]);

    expect(store.needsCheckpoint("token-a", 0)).toBe(false);
    expect(
      store.needsCheckpoint("token-a", RECORDER_CHECKPOINT_MUTATIONS - 2),
    ).toBe(true);

    const beforeCheckpoint = store.load("token-a");
    expect(beforeCheckpoint?.pressure).not.toBeNull();

    const raw = new Database(dbPath, { readonly: true });
    expect(
      raw
        .query<{ type: string }, []>(
          "SELECT typeof(pressure) AS type FROM token_state",
        )
        .get()?.type,
    ).toBe("null");
    expect(
      raw
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pressure_log",
        )
        .get()?.count,
    ).toBe(2);
    raw.close();

    const restored = new PressureFrontierMemory();
    restored.restore(beforeCheckpoint?.pressure);
    expect(restored.bandsAtPrice(p(0.6))).toEqual([
      {
        loVolume: 0,
        hiVolume: 20,
        validThroughMs: 750,
      },
      {
        loVolume: 20,
        hiVolume: 42,
        validThroughMs: 500,
      },
    ]);

    store.write([
      {
        tokenId: "token-a",
        status: "watched",
        recordingSinceMs: 500,
        checkpoint: beforeCheckpoint!.pressure,
      },
    ]);
    expect(store.needsCheckpoint("token-a", 0)).toBe(false);
    store.close();

    const compacted = new Database(dbPath, { readonly: true });
    expect(
      compacted
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pressure_log",
        )
        .get()?.count,
    ).toBe(0);
    compacted.close();

    const reopened = new RecorderStore(dbPath);
    expect(reopened.load("token-a")?.pressure).toEqual(
      beforeCheckpoint?.pressure,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecorderStore upgrades the additive v4 schema to incremental v5", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-v4-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE pressure_log;
      PRAGMA user_version = 4;
    `);
    raw.close();

    const reopened = new RecorderStore(dbPath);
    reopened.close();

    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.query("PRAGMA user_version").get()).toEqual({
      user_version: RECORDER_DATABASE_VERSION,
    });
    expect(
      upgraded
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pressure_log'",
        )
        .get()?.name,
    ).toBe("pressure_log");
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RecorderStore rejects databases older than the incremental predecessor", () => {
  const dir = mkdtempSync(join(tmpdir(), "recorder-store-old-version-"));
  const dbPath = join(dir, "recorder.sqlite");

  try {
    const store = new RecorderStore(dbPath);
    store.close();

    const raw = new Database(dbPath);
    raw.exec("PRAGMA user_version = 3");
    raw.close();

    expect(() => new RecorderStore(dbPath)).toThrow(
      `Recorder database version 3 requires migration to ${RECORDER_DATABASE_VERSION}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
