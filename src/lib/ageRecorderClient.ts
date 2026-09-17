import type { StaleSignedVolumeSegment } from "./staleSignedVolume";

interface RecorderStateResponse {
  serverNowMs: number;
  states: Record<string, readonly StaleSignedVolumeSegment[]>;
}

/**
 * Fetch persisted sample-and-hold state and register the tokens with the
 * recorder. Failure is intentionally non-fatal: the UI can always fall back
 * to starting from the live websocket state.
 */
export async function fetchRecordedAgeState(
  tokenIds: readonly string[],
): Promise<Record<string, readonly StaleSignedVolumeSegment[]>> {
  if (tokenIds.length === 0) return {};

  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);

  try {
    const response = await fetch(`/api/recorder/state?${params}`);
    if (!response.ok) throw new Error(`recorder returned ${response.status}`);
    const body = (await response.json()) as RecorderStateResponse;
    return body.states ?? {};
  } catch (error) {
    console.warn("Age recorder unavailable; starting age state locally", error);
    return {};
  }
}
