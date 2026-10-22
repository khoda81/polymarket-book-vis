/** Index i owns the minimum viewport width for i + 1 columns. */
export type ColumnLayout = readonly [0, ...number[]];

export const DEFAULT_COLUMN_LAYOUT: ColumnLayout = [0, 800, 1200];

export function columnsForWidth(layout: ColumnLayout, width: number): number {
  for (let index = layout.length - 1; index > 0; index--) {
    if (layout[index]! <= width) return index + 1;
  }
  return 1;
}

/** Clip thresholds around this width without removing intermediate counts. */
export function learnColumnCount(
  layout: ColumnLayout,
  width: number,
  columns: number,
): ColumnLayout {
  const higher = layout.slice(columns);
  const nextWidth = higher.find((minWidth) => minWidth > width);
  return [
    0,
    ...Array.from({ length: columns - 1 }, (_, index) =>
      Math.min(layout[index + 1] ?? width, width),
    ),
    ...(nextWidth === undefined
      ? []
      : higher.map((minWidth) => Math.max(minWidth, nextWidth))),
  ];
}

export function parseColumnLayout(value: unknown): ColumnLayout | null {
  if (!Array.isArray(value) || value[0] !== 0) return null;
  const layout: [0, ...number[]] = [0];
  for (const minWidth of value.slice(1)) {
    if (
      !Number.isSafeInteger(minWidth) ||
      minWidth < layout[layout.length - 1]!
    )
      return null;
    layout.push(minWidth);
  }
  return layout;
}
