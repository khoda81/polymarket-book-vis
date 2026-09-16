import { Database } from "bun:sqlite";
import type { SpreadAgeSnapshot } from "../src/lib/spreadAge";

export interface TrackedToken {
  readonly tokenId: string;
  readonly eventId?: string;
  readonly marketId?: string;
  readonly question?: string;
  readonly resolutionAtMs?: number;
}

export interface StoredAgeState {
  readonly tokenId: string;
  readonly bid: number;
  readonly ask: number;
  readonly observedAtMs: number;
  readonly snapshot: SpreadAgeSnapshot;
}

export class AgeStore {
  private readonly db: Database;

  constructor(path = process.env.AGE_DB_PATH ?? "data/age.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tracked_tokens (
        token_id TEXT PRIMARY KEY,
        event_id TEXT,
        market_id TEXT,
        question TEXT,
        resolution_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS age_state (
        token_id TEXT PRIMARY KEY,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        FOREIGN KEY(token_id) REFERENCES tracked_tokens(token_id)
      )
    `);
  }

  track(tokens: readonly TrackedToken[]): void {
    if (tokens.length === 0) return;
    const now = Date.now();
    const query = this.db.query(`
      INSERT INTO tracked_tokens (
        token_id, event_id, market_id, question, resolution_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        event_id = COALESCE(excluded.event_id, tracked_tokens.event_id),
        market_id = COALESCE(excluded.market_id, tracked_tokens.market_id),
        question = COALESCE(excluded.question, tracked_tokens.question),
        resolution_at_ms = COALESCE(
          excluded.resolution_at_ms,
          tracked_tokens.resolution_at_ms
        ),
        updated_at_ms = excluded.updated_at_ms
    `);

    const transaction = this.db.transaction((rows: readonly TrackedToken[]) => {
      for (const token of rows)
        query.run(
          token.tokenId,
          token.eventId ?? null,
          token.marketId ?? null,
          token.question ?? null,
          token.resolutionAtMs ?? null,
          now,
          now,
        );
    });
    transaction(tokens);
  }

  trackedTokens(): TrackedToken[] {
    const rows = this.db
      .query(`
        SELECT
          token_id AS tokenId,
          event_id AS eventId,
          market_id AS marketId,
          question,
          resolution_at_ms AS resolutionAtMs
        FROM tracked_tokens
        ORDER BY created_at_ms
      `)
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      tokenId: String(row.tokenId),
      eventId: nullableString(row.eventId),
      marketId: nullableString(row.marketId),
      question: nullableString(row.question),
      resolutionAtMs:
        typeof row.resolutionAtMs === "number" ? row.resolutionAtMs : undefined,
    }));
  }

  saveAgeState(state: StoredAgeState): void {
    this.db
      .query(`
        INSERT INTO age_state (
          token_id, bid, ask, observed_at_ms, snapshot_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          bid = excluded.bid,
          ask = excluded.ask,
          observed_at_ms = excluded.observed_at_ms,
          snapshot_json = excluded.snapshot_json
      `)
      .run(
        state.tokenId,
        state.bid,
        state.ask,
        state.observedAtMs,
        JSON.stringify(state.snapshot),
      );
  }

  ageStates(tokenIds: readonly string[]): StoredAgeState[] {
    if (tokenIds.length === 0) return [];
    const query = this.db.query(`
      SELECT
        token_id AS tokenId,
        bid,
        ask,
        observed_at_ms AS observedAtMs,
        snapshot_json AS snapshotJson
      FROM age_state
      WHERE token_id = ?
    `);

    const states: StoredAgeState[] = [];
    for (const tokenId of tokenIds) {
      const row = query.get(tokenId) as Record<string, unknown> | null;
      if (!row) continue;
      try {
        states.push({
          tokenId: String(row.tokenId),
          bid: Number(row.bid),
          ask: Number(row.ask),
          observedAtMs: Number(row.observedAtMs),
          snapshot: JSON.parse(String(row.snapshotJson)) as SpreadAgeSnapshot,
        });
      } catch {
        // Ignore corrupt rows; the collector will replace them on a snapshot.
      }
    }
    return states;
  }

  /** A collector observation gap invalidates continuity for these tokens. */
  invalidateAgeStates(tokenIds: readonly string[]): void {
    if (tokenIds.length === 0) return;
    const query = this.db.query("DELETE FROM age_state WHERE token_id = ?");
    const transaction = this.db.transaction((ids: readonly string[]) => {
      for (const tokenId of ids) query.run(tokenId);
    });
    transaction(tokenIds);
  }

  close(): void {
    this.db.close();
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
