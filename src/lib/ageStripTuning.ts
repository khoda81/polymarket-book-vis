import { DEFAULT_VOLUME_PER_CSS_PIXEL } from "./pressureInk";

export const AGE_ROW_BAND_PX = 28;
export const DEFAULT_GHOST_HALF_LIFE_MS = 5_000;

const TUNING_STORAGE_KEY = "polymarket-book-vis.age-strip-tuning.v1";

export interface AgeStripTuning {
  /** Share scale parameter, expressed as shares per CSS pixel of row height. */
  readonly volumePerCssPixel: number;
  /** Exponential half-life of historical pressure ghosts. */
  readonly ghostHalfLifeMs: number;
}

interface StoredAgeStripTuning {
  volumePerCssPixel?: number;
  ghostHalfLifeMs?: number;
  /** Legacy v1 name; migrated in place to volumePerCssPixel. */
  volumeSoftLimit?: number;
}

const listeners = new Set<
  (tuning: Readonly<AgeStripTuning>) => void
>();
let tuning = loadTuning();
let persistTimer: number | undefined;

export function getAgeStripTuning(): Readonly<AgeStripTuning> {
  return tuning;
}

export function subscribeAgeStripTuning(
  listener: (tuning: Readonly<AgeStripTuning>) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function scaleAgeStripVolumePerCssPixel(factor: number): void {
  if (!(factor > 0) || !Number.isFinite(factor)) return;

  const next = Math.max(
    1e-3,
    tuning.volumePerCssPixel * factor,
  );
  if (next === tuning.volumePerCssPixel) return;

  tuning = { ...tuning, volumePerCssPixel: next };
  schedulePersist();
  for (const listener of listeners) listener(tuning);
}

export function scaleAgeStripGhostHalfLife(factor: number): void {
  if (!(factor > 0) || !Number.isFinite(factor)) return;

  const next = Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(50, tuning.ghostHalfLifeMs * factor),
  );
  if (next === tuning.ghostHalfLifeMs) return;

  tuning = { ...tuning, ghostHalfLifeMs: next };
  schedulePersist();
  for (const listener of listeners) listener(tuning);
}

function loadTuning(): AgeStripTuning {
  const fallback: AgeStripTuning = {
    volumePerCssPixel: DEFAULT_VOLUME_PER_CSS_PIXEL,
    ghostHalfLifeMs: DEFAULT_GHOST_HALF_LIFE_MS,
  };

  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as StoredAgeStripTuning;
    const stored =
      typeof parsed.volumePerCssPixel === "number"
        ? parsed.volumePerCssPixel
        : parsed.volumeSoftLimit;
    return {
      volumePerCssPixel:
        typeof stored === "number" && Number.isFinite(stored) && stored > 0
          ? stored
          : fallback.volumePerCssPixel,
      ghostHalfLifeMs:
        typeof parsed.ghostHalfLifeMs === "number" &&
        Number.isFinite(parsed.ghostHalfLifeMs) &&
        parsed.ghostHalfLifeMs > 0
          ? parsed.ghostHalfLifeMs
          : fallback.ghostHalfLifeMs,
    };
  } catch {
    return fallback;
  }
}

function schedulePersist(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    try {
      window.localStorage.setItem(
        TUNING_STORAGE_KEY,
        JSON.stringify(tuning),
      );
    } catch {
      // Preferences are best effort.
    }
  }, 200);
}
