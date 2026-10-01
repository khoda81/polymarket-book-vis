import { DEFAULT_VOLUME_PER_CSS_PIXEL } from "../../rendering/colors/pressureInk";

const STORAGE_KEY = "polymarket-book-vis.age-strip-tuning.v1";
const PERSIST_DELAY_MS = 200;
export const DEFAULT_GHOST_HALF_LIFE_MS = 5_000;

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

type TuningStorage = Pick<Storage, "getItem" | "setItem">;

export class AgeStripTuningStore {
  private readonly listeners = new Set<
    (tuning: Readonly<AgeStripTuning>) => void
  >();
  private tuning: AgeStripTuning;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly storage: TuningStorage | null) {
    this.tuning = loadTuning(storage);
  }

  get(): Readonly<AgeStripTuning> {
    return this.tuning;
  }

  subscribe(listener: (tuning: Readonly<AgeStripTuning>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  scale(volumeFactor: number, ghostFactor: number): void {
    const validVolumeFactor = positiveFactor(volumeFactor);
    const validGhostFactor = positiveFactor(ghostFactor);
    const volumePerCssPixel = Math.max(
      1e-3,
      this.tuning.volumePerCssPixel * validVolumeFactor,
    );
    const ghostHalfLifeMs = this.tuning.ghostHalfLifeMs * validGhostFactor;
    if (!(ghostHalfLifeMs > 0) || !Number.isFinite(ghostHalfLifeMs)) return;
    if (
      volumePerCssPixel === this.tuning.volumePerCssPixel &&
      ghostHalfLifeMs === this.tuning.ghostHalfLifeMs
    )
      return;

    this.tuning = { volumePerCssPixel, ghostHalfLifeMs };
    this.schedulePersist();
    for (const listener of this.listeners) listener(this.tuning);
  }

  private schedulePersist(): void {
    if (!this.storage) return;
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      try {
        this.storage!.setItem(STORAGE_KEY, JSON.stringify(this.tuning));
      } catch (error) {
        console.warn("Could not persist age-strip tuning:", error);
      }
    }, PERSIST_DELAY_MS);
  }
}

function positiveFactor(value: number): number {
  return value > 0 && Number.isFinite(value) ? value : 1;
}

function loadTuning(storage: TuningStorage | null): AgeStripTuning {
  const fallback: AgeStripTuning = {
    volumePerCssPixel: DEFAULT_VOLUME_PER_CSS_PIXEL,
    ghostHalfLifeMs: DEFAULT_GHOST_HALF_LIFE_MS,
  };
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as StoredAgeStripTuning;
    const storedVolume =
      typeof parsed.volumePerCssPixel === "number"
        ? parsed.volumePerCssPixel
        : parsed.volumeSoftLimit;
    return {
      volumePerCssPixel: positiveValue(
        storedVolume,
        fallback.volumePerCssPixel,
      ),
      ghostHalfLifeMs: positiveValue(
        parsed.ghostHalfLifeMs,
        fallback.ghostHalfLifeMs,
      ),
    };
  } catch (error) {
    console.warn("Could not restore age-strip tuning:", error);
    return fallback;
  }
}

function positiveValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
