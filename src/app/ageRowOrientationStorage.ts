import type { AgeRowOrientation } from "../chart/ageStripOrientation";

const STORAGE_KEY = "polymarket-book-vis:age-row-orientation:v1";

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadStoredAgeRowOrientation(
  eventId: string,
  storage: KeyValueStorage = localStorage,
): AgeRowOrientation | null {
  return readOrientations(storage)[eventId] ?? null;
}

export function persistAgeRowOrientation(
  eventId: string,
  orientation: AgeRowOrientation,
  storage: KeyValueStorage = localStorage,
): void {
  const orientations = readOrientations(storage);
  orientations[eventId] = orientation;
  storage.setItem(STORAGE_KEY, JSON.stringify(orientations));
}

function readOrientations(
  storage: KeyValueStorage,
): Record<string, AgeRowOrientation> {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const orientations: Record<string, AgeRowOrientation> = {};
    for (const [eventId, value] of Object.entries(parsed)) {
      if (value === "positive-above" || value === "negative-above")
        orientations[eventId] = value;
    }
    return orientations;
  } catch {
    return {};
  }
}
