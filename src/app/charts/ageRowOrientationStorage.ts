import {
  isAgeRowOrientation,
  type AgeRowOrientation,
} from "../../chart/age/ageStripOrientation";
import type { Event, Series } from "@polymarket/client";

const STORAGE_KEY = "polymarket-book-vis:age-row-orientation:v1";

export type AgeRowOrientationStorageKey =
  | { readonly kind: "event"; readonly id: Event["id"] }
  | {
      readonly kind: "event-group";
      readonly eventId: Event["id"];
      readonly groupKey: string;
    }
  | { readonly kind: "series"; readonly id: Series["id"] };

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadStoredAgeRowOrientation(
  key: AgeRowOrientationStorageKey,
  storage: KeyValueStorage = localStorage,
): AgeRowOrientation | null {
  return readOrientations(storage)[storageKey(key)] ?? null;
}

export function persistAgeRowOrientation(
  key: AgeRowOrientationStorageKey,
  orientation: AgeRowOrientation,
  storage: KeyValueStorage = localStorage,
): void {
  const orientations = readOrientations(storage);
  orientations[storageKey(key)] = orientation;
  storage.setItem(STORAGE_KEY, JSON.stringify(orientations));
}

function storageKey(key: AgeRowOrientationStorageKey): string {
  if (key.kind === "event-group")
    return `${key.kind}:${key.eventId}:${key.groupKey}`;
  return `${key.kind}:${key.id}`;
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
    for (const [key, value] of Object.entries(parsed))
      if (isAgeRowOrientation(value)) orientations[key] = value;
    return orientations;
  } catch {
    return {};
  }
}
