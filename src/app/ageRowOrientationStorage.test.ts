import { expect, test } from "bun:test";
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

test("age row orientation persists independently per event", () => {
  const storage = new MemoryStorage();

  expect(loadStoredAgeRowOrientation("a", storage)).toBeNull();

  persistAgeRowOrientation("a", "negative-above", storage);
  persistAgeRowOrientation("b", "positive-above", storage);

  expect(loadStoredAgeRowOrientation("a", storage)).toBe("negative-above");
  expect(loadStoredAgeRowOrientation("b", storage)).toBe("positive-above");
});

test("invalid stored orientation data is ignored", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "polymarket-book-vis:age-row-orientation:v1",
    JSON.stringify({
      valid: "negative-above",
      invalid: "sideways",
    }),
  );

  expect(loadStoredAgeRowOrientation("valid", storage)).toBe("negative-above");
  expect(loadStoredAgeRowOrientation("invalid", storage)).toBeNull();
});
