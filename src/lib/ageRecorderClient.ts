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
  states: Record<string, RecorderTransportState>;
}

export interface RecordedAgeState {
  segments: readonly StaleSignedVolumeSegment[];
}

/**
 * Fetch persisted pressure-memory state and register the tokens with the
 * recorder. Failure is intentionally non-fatal: the UI can always fall back
 * to starting from the live websocket state.
 */
export async function fetchRecordedAgeState(
  tokenIds: readonly string[],
): Promise<Record<string, RecordedAgeState>> {
  if (tokenIds.length === 0) return {};

  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);

  try {
    const response = await fetch(`/api/recorder/state?${params}`);
    if (!response.ok) throw new Error(`recorder returned ${response.status}`);
    const body = (await response.json()) as RecorderStateResponse;

    return Object.fromEntries(
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
  } catch (error) {
    console.warn("Age recorder unavailable; starting age state locally", error);
    return {};
  }
}
