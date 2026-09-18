interface RecorderStateResponse {
  recordingSinceMsByToken?: Record<string, number>;
}

export interface RecorderCoverage {
  /** Individual recorder coverage starts, keyed by token id. */
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
}

const RECORDER_FETCH_TIMEOUT_MS = 1_500;

/**
 * Register tokens with the recorder and fetch only coverage metadata.
 *
 * This request is optional and bounded; live market startup never waits for it.
 */
export async function fetchRecordedAgeState(
  tokenIds: readonly string[],
): Promise<RecorderCoverage> {
  if (tokenIds.length === 0) return { recordingSinceMsByToken: {} };

  const params = new URLSearchParams({ metadataOnly: "1" });
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    RECORDER_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`/api/recorder/state?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`recorder returned ${response.status}`);
    const body = (await response.json()) as RecorderStateResponse;
    const perToken = Object.fromEntries(
      Object.entries(body.recordingSinceMsByToken ?? {}).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
    return { recordingSinceMsByToken: perToken };
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      console.warn("Age recorder metadata unavailable", error);
    return { recordingSinceMsByToken: {} };
  } finally {
    clearTimeout(timeout);
  }
}
