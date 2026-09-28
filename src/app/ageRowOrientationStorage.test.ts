import { expect, test } from "bun:test";
import type { Event, Series } from "@polymarket/client";
import {
  loadStoredAgeRowOrientation,
  persistAgeRowOrientation,
} from "./ageRowOrientationStorage";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function mockEvent(id: string): Event {
  return { id } as unknown as Event;
}

function mockSeries(id: string): Series {
  return { id } as unknown as Series;
}

test("age row orientation persists independently per typed card key", () => {
  const storage = new MemoryStorage();
  const event = { kind: "event", id: mockEvent("event-a").id } as const;
  const series = { kind: "series", id: mockSeries("1").id } as const;

  expect(loadStoredAgeRowOrientation(event, storage)).toBeNull();

  persistAgeRowOrientation(event, "negative-above", storage);
  persistAgeRowOrientation(series, "positive-above", storage);

  expect(loadStoredAgeRowOrientation(event, storage)).toBe("negative-above");
  expect(loadStoredAgeRowOrientation(series, storage)).toBe("positive-above");
});

test("invalid stored orientation data is ignored at the storage boundary", () => {
  const storage = new MemoryStorage();
  const valid = { kind: "event", id: mockEvent("valid").id } as const;
  const invalid = { kind: "event", id: mockEvent("invalid").id } as const;
  storage.setItem(
    "polymarket-book-vis:age-row-orientation:v1",
    JSON.stringify({
      "event:valid": "negative-above",
      "event:invalid": "sideways",
    }),
  );

  expect(loadStoredAgeRowOrientation(valid, storage)).toBe("negative-above");
  expect(loadStoredAgeRowOrientation(invalid, storage)).toBeNull();
});
