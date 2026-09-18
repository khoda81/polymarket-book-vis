import type { StaleSignedVolumeSegment } from "./staleSignedVolume";

interface RecorderTransportSegment {
  lo: number;
  hi: number;
  volume: number;
  /** Missing/null means an older recorder did not capture economic magnitude. */
  sweepCost?: number | null;
  /** null is the backend wire encoding of age Infinity / never observed. */
  ageMs: number | null;
}

interface RecorderTransportState {
  segments: RecorderTransportSegment[];
}

interface RecorderStateResponse {
  serverNowMs: number;
  connected: boolean;
  recordingSinceMs: number | null;
  recordingSinceMsByToken?: Record<string, number>;
  states: Record<string, RecorderTransportState>;
}

export interface RecordedAgeState {
  segments: readonly StaleSignedVolumeSegment[];
}

export interface RecordedAgeHydration {
  readonly states: Record<string, RecordedAgeState>;
  readonly connected: boolean;
  readonly serverNowMs: number;
  /** Start of recorder coverage shared by every requested token. */
  readonly recordingSinceMs: number | null;
  /** Individual recorder coverage starts, keyed by token id. */
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
}

/**
 * Fetch persisted pressure-memory state and register the tokens with the
 * recorder. Failure is intentionally non-fatal: the UI can always fall back
 * to starting from the live websocket state.
 */
export async function fetchRecordedAgeState(
  tokenIds: readonly string[],
): Promise<RecordedAgeHydration> {
  if (tokenIds.length === 0)
    return {
      states: {},
      connected: false,
      serverNowMs: Date.now(),
      recordingSinceMs: null,
      recordingSinceMsByToken: {},
    };

  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);

  try {
    const response = await fetch(`/api/recorder/state?${params}`);
    if (!response.ok) throw new Error(`recorder returned ${response.status}`);
    const body = (await response.json()) as RecorderStateResponse;

    const states = Object.fromEntries(
      Object.entries(body.states ?? {}).map(([tokenId, state]) => [
        tokenId,
        {
          segments: state.segments.map(({ ageMs, sweepCost, ...segment }) => ({
            ...segment,
            sweepCost:
              typeof sweepCost === "number" && Number.isFinite(sweepCost)
                ? sweepCost
                : null,
            ageMs: ageMs === null ? Infinity : ageMs,
          })),
        } satisfies RecordedAgeState,
      ]),
    );

    const commonRecordingSince =
      typeof body.recordingSinceMs === "number" &&
      Number.isFinite(body.recordingSinceMs)
        ? body.recordingSinceMs
        : null;
    const perToken = Object.fromEntries(
      Object.entries(body.recordingSinceMsByToken ?? {}).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
    // Older recorder processes do not expose the per-token map yet. The common
    // coverage start is a conservative fallback until that process restarts.
    if (Object.keys(perToken).length === 0 && commonRecordingSince !== null)
      for (const tokenId of tokenIds) perToken[tokenId] = commonRecordingSince;

    return {
      states,
      connected: body.connected,
      serverNowMs: body.serverNowMs,
      recordingSinceMs: commonRecordingSince,
      recordingSinceMsByToken: perToken,
    };
  } catch (error) {
    console.warn("Age recorder unavailable; starting age state locally", error);
    return {
      states: {},
      connected: false,
      serverNowMs: Date.now(),
      recordingSinceMs: null,
      recordingSinceMsByToken: {},
    };
  }
}
