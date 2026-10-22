import { COLUMN_LAYOUT_STORAGE_KEY, loadStoredJson } from "./dashboardStorage";

type ColumnStorage = Pick<Storage, "getItem" | "setItem">;
/** A storage snapshot only; live thresholds belong to the stylesheet. */
type StoredThresholds = readonly [0, ...number[]];

/** Owns one ordered media rule per count; rule index i means i + 1 columns. */
export class ColumnLayout {
  readonly #sheet = new CSSStyleSheet();
  readonly #storage: ColumnStorage;

  constructor(storage: ColumnStorage = localStorage) {
    this.#storage = storage;
    const saved = parseThresholds(
      loadStoredJson(COLUMN_LAYOUT_STORAGE_KEY, storage),
    );
    for (const width of saved ?? [0, 800, 1200])
      this.#append(`(min-width: ${width}px)`);

    this.#persist();
    document.adoptedStyleSheets.push(this.#sheet);
  }

  get count(): number {
    // Upper bound of the matching prefix, including repeated thresholds.
    let lo = 1;
    let hi = this.#sheet.cssRules.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (window.matchMedia(this.#rule(mid).media.mediaText).matches)
        lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Teach the current viewport's count by editing only the conflicting rules. */
  choose(columns: number): void {
    // CSSOM rule indices are unsigned longs, rather than arbitrary JS integers.
    if (!Number.isInteger(columns) || columns < 1 || columns > 0xffffffff)
      return;
    const current = this.count;

    if (columns === current) return;

    if (columns > current) {
      let width = window.innerWidth;
      // innerWidth can round up past the fractional CSS viewport width.
      if (!window.matchMedia(`(min-width: ${width}px)`).matches) width -= 1;
      const media = `(min-width: ${width}px)`;
      for (let index = current; index < columns; index++) {
        if (index < this.#sheet.cssRules.length)
          this.#rule(index).media.mediaText = media;
        else this.#append(media);
      }
    } else if (current < this.#sheet.cssRules.length) {
      // Reuse the next inactive boundary; do not invent a later width.
      const media = this.#rule(current).media.mediaText;
      for (let index = columns; index < current; index++)
        this.#rule(index).media.mediaText = media;
    } else {
      while (this.#sheet.cssRules.length > columns)
        this.#sheet.deleteRule(this.#sheet.cssRules.length - 1);
    }
    this.#persist();
  }

  destroy(): void {
    const index = document.adoptedStyleSheets.indexOf(this.#sheet);
    if (index >= 0) document.adoptedStyleSheets.splice(index, 1);
  }

  #rule(index: number): CSSMediaRule {
    return this.#sheet.cssRules[index] as CSSMediaRule;
  }

  #append(media: string): void {
    const index = this.#sheet.cssRules.length;
    this.#sheet.insertRule(
      `@media ${media} { .grid { --dashboard-columns: ${index + 1}; } }`,
      index,
    );
  }

  #persist(): void {
    const thresholds = Array.from(this.#sheet.cssRules, (_, index) => {
      // Only this owner authors these simple px conditions. Parsing happens
      // solely at the storage boundary, never during lookup or learning.
      const media = this.#rule(index).media.mediaText;
      return Number(media.slice("(min-width: ".length, -"px)".length));
    });
    this.#storage.setItem(
      COLUMN_LAYOUT_STORAGE_KEY,
      JSON.stringify(thresholds),
    );
  }
}

function parseThresholds(value: unknown): StoredThresholds | null {
  if (!Array.isArray(value) || value[0] !== 0) return null;
  let previous = 0;
  for (const width of value) {
    if (!Number.isSafeInteger(width) || width < previous) return null;
    previous = width;
  }
  return value as [0, ...number[]];
}
