import {
  parsePressureCells,
  rebasePressureCells,
  type PressureCell,
} from "./pressureMemory";

interface RecorderStateResponse {
  serverNowMs?: number;
  recordingSinceMsByToken?: Record<string, number>;
  states?: Record<string, { cells?: unknown }>;
}

export interface RecorderHydration {
  /** Individual recorder coverage starts, keyed by token id. */
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
  /** Layered pressure memory rebased onto the browser clock. */
  readonly pressureCellsByToken: Readonly<
    Record<string, readonly PressureCell[]>
  >;
}

const RECORDER_FETCH_TIMEOUT_MS = 1_500;

/**
 * Register tokens with the recorder and opportunistically hydrate ghost state.
 *
 * This request is optional and bounded; live market startup never waits for it.
 */
export async function fetchRecorderHydration(
  tokenIds: readonly string[],
): Promise<RecorderHydration> {
  if (tokenIds.length === 0)
    return {
      recordingSinceMsByToken: {},
      pressureCellsByToken: {},
    };

  const params = new URLSearchParams();
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
    if (!response.ok)
      throw new Error(`recorder returned ${response.status}`);

    const body = (await response.json()) as RecorderStateResponse;
    const perToken = Object.fromEntries(
      Object.entries(body.recordingSinceMsByToken ?? {}).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );

    const sourceNowMs =
      typeof body.serverNowMs === "number" &&
      Number.isFinite(body.serverNowMs)
        ? body.serverNowMs
        : Date.now();
    const targetNowMs = Date.now();

    const pressureCellsByToken: Record<
      string,
      readonly PressureCell[]
    > = {};
    for (const [tokenId, state] of Object.entries(body.states ?? {})) {
      try {
        pressureCellsByToken[tokenId] = rebasePressureCells(
          parsePressureCells(state.cells),
          sourceNowMs,
          targetNowMs,
        );
      } catch (error) {
        console.warn(
          `Ignoring malformed recorder pressure state for ${tokenId}`,
          error,
        );
      }
    }

    return {
      recordingSinceMsByToken: perToken,
      pressureCellsByToken,
    };
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      console.warn("Age recorder unavailable", error);
    return {
      recordingSinceMsByToken: {},
      pressureCellsByToken: {},
    };
  } finally {
    clearTimeout(timeout);
  }
}
