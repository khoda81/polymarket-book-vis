import { expect, test } from "bun:test";
import { ColumnLayout } from "./columnLayout";
import { COLUMN_LAYOUT_STORAGE_KEY } from "./dashboardStorage";

// A narrow CSSOM double for the learning contract; actual cascade and native
// MediaList mutation are also checked in the browser.
class TestSheet {
  readonly cssRules: { media: { mediaText: string } }[] = [];
  insertRule(text: string, index: number): number {
    const mediaText = text.slice("@media ".length, text.indexOf(" {"));
    this.cssRules.splice(index, 0, { media: { mediaText } });
    return index;
  }
  deleteRule(index: number): void {
    this.cssRules.splice(index, 1);
  }
}

function harness(
  run: (fixture: {
    storage: Pick<Storage, "getItem" | "setItem">;
    viewport: (width: number) => void;
    snapshot: () => number[];
    sheets: TestSheet[];
    queryCount: () => number;
  }) => void,
): void {
  let width = 1000;
  let queries = 0;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const sheets: TestSheet[] = [];
  const globals = {
    CSSStyleSheet: TestSheet,
    document: { adoptedStyleSheets: sheets },
    window: {
      get innerWidth() {
        return Math.round(width);
      },
      matchMedia(query: string) {
        queries++;
        const minWidth = Number(
          query.slice("(min-width: ".length, -"px)".length),
        );
        return { matches: width >= minWidth };
      },
    },
  };
  const originals = Object.keys(globals).map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    run({
      storage,
      viewport: (next) => {
        width = next;
      },
      snapshot: () => JSON.parse(storage.getItem(COLUMN_LAYOUT_STORAGE_KEY)!),
      sheets,
      queryCount: () => queries,
    });
  } finally {
    Object.keys(globals).forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test("native matching selects the default count without changing stored preferences", () => {
  harness(({ storage, viewport, snapshot }) => {
    const layout = new ColumnLayout(storage);
    expect(
      [799, 800, 1199, 1200].map((width) => {
        viewport(width);
        return layout.count;
      }),
    ).toEqual([1, 2, 2, 3]);
    expect(snapshot()).toEqual([0, 800, 1200]);
  });
});

test("shared boundaries retain every ordinal and the latest choice", () => {
  harness(({ storage, viewport, snapshot, sheets }) => {
    const layout = new ColumnLayout(storage);
    const origin = sheets[0]!.cssRules[0];
    const second = sheets[0]!.cssRules[1];
    layout.choose(4);
    expect(snapshot()).toEqual([0, 800, 1000, 1000]);
    expect(layout.count).toBe(4);
    expect(sheets[0]!.cssRules[0]).toBe(origin);
    expect(sheets[0]!.cssRules[1]).toBe(second);
    viewport(900);
    layout.choose(1);
    expect(snapshot()).toEqual([0, 1000, 1000, 1000]);
    expect(layout.count).toBe(1);
    viewport(1000);
    layout.choose(2);
    expect(snapshot()).toEqual([0, 1000]);
    expect(layout.count).toBe(2);
    viewport(2000);
    expect(layout.count).toBe(2);
  });
});

test("choices at fractional viewport widths take effect without reversing thresholds", () => {
  for (const width of [999.75, 1000, 1000.25, 1000.75]) {
    harness(({ storage, viewport, snapshot }) => {
      storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, "[0,1000,1200]");
      viewport(width);
      const layout = new ColumnLayout(storage);
      layout.choose(3);
      expect(layout.count).toBe(3);
      const thresholds = snapshot();
      expect(thresholds[0]).toBe(0);
      expect(thresholds[1]).toBeLessThanOrEqual(thresholds[2]!);
      viewport(998);
      expect(layout.count).toBe(1);
      viewport(1001);
      expect(layout.count).toBe(3);
    });
  }
});

test("decreasing counts reuses the next inactive width or truncates the tail", () => {
  harness(({ storage, viewport, snapshot }) => {
    const layout = new ColumnLayout(storage);
    viewport(900);
    layout.choose(1);
    expect(snapshot()).toEqual([0, 1200, 1200]);
    viewport(1199);
    expect(layout.count).toBe(1);
    viewport(1200);
    expect(layout.count).toBe(3);
    viewport(1400);
    layout.choose(1);
    expect(snapshot()).toEqual([0]);
    viewport(0);
    layout.choose(2);
    expect(snapshot()).toEqual([0, 0]);
    expect(layout.count).toBe(2);
  });
});

test("successive contradictory choices preserve monotonicity and honor the latest constraint", () => {
  harness(({ storage, viewport, snapshot }) => {
    const layout = new ColumnLayout(storage);
    for (const [width, count] of [
      [390, 2],
      [1600, 5],
      [900, 1],
      [1200, 6],
      [1200, 3],
      [0, 2],
      [3000, 1],
    ]) {
      viewport(width!);
      layout.choose(count!);
      expect(layout.count).toBe(count!);
      const thresholds = snapshot();
      expect(thresholds[0]).toBe(0);
      expect(
        thresholds.every(
          (value, index) => index === 0 || value >= thresholds[index - 1]!,
        ),
      ).toBe(true);
      let previous = 0;
      for (let sample = 0; sample <= 4000; sample += 10) {
        viewport(sample);
        const current = layout.count;
        expect(current).toBeGreaterThanOrEqual(previous);
        expect(current).toBeLessThanOrEqual(thresholds.length);
        previous = current;
      }
    }
  });
});

test("query lookup uses logarithmic browser matching rather than scanning every rule", () => {
  harness(({ storage, viewport, queryCount }) => {
    storage.setItem(
      COLUMN_LAYOUT_STORAGE_KEY,
      JSON.stringify(Array.from({ length: 128 }, (_, index) => index * 100)),
    );
    const layout = new ColumnLayout(storage);
    viewport(6500);
    const before = queryCount();
    expect(layout.count).toBe(66);
    expect(queryCount() - before).toBeLessThanOrEqual(7);
  });
});

test("invalid counts cannot change the owned rules", () => {
  harness(({ storage, snapshot }) => {
    const layout = new ColumnLayout(storage);
    for (const value of [0, -1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
      layout.choose(value);
      expect(snapshot()).toEqual([0, 800, 1200]);
    }
  });
});

test("stored thresholds reject invalid widths, ordering, holes, and missing origins", () => {
  for (const value of [
    null,
    [],
    [800],
    [-1, 800],
    [0, -1],
    [0, 800, 799],
    [0, 800.5],
    [0, Infinity],
    [0, NaN],
    [0, "800"],
    [0, null],
    [0, undefined, 1200],
    [{ minWidth: 0, columns: 1 }],
  ]) {
    harness(({ storage, snapshot }) => {
      storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(value));
      new ColumnLayout(storage);
      expect(snapshot()).toEqual([0, 800, 1200]);
    });
  }
});

test("restoration keeps shared zero-width boundaries", () => {
  harness(({ storage, viewport, snapshot }) => {
    storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, "[0,0,800,800]");
    const layout = new ColumnLayout(storage);
    expect(snapshot()).toEqual([0, 0, 800, 800]);
    viewport(0);
    expect(layout.count).toBe(2);
    viewport(800);
    expect(layout.count).toBe(4);
  });
});

test("learned thresholds survive reload", () => {
  harness(({ storage, viewport, snapshot }) => {
    viewport(1400);
    const layout = new ColumnLayout(storage);
    layout.choose(4);
    expect(snapshot()).toEqual([0, 800, 1200, 1400]);
    layout.destroy();
    const restored = new ColumnLayout(storage);
    expect(
      [390, 1000, 1400, 2000].map((width) => {
        viewport(width);
        return restored.count;
      }),
    ).toEqual([1, 2, 4, 4]);
  });
});

test("destroy removes only this owner's sheet and is idempotent", () => {
  harness(({ storage, sheets }) => {
    const first = new ColumnLayout(storage);
    const second = new ColumnLayout(storage);
    const retained = sheets[1];
    first.destroy();
    first.destroy();
    expect(sheets).toEqual([retained!]);
    second.destroy();
    expect(sheets).toEqual([]);
  });
});
