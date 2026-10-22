export interface ColumnStep {
  readonly minWidth: number;
  readonly columns: number;
}

export type ColumnLayout = readonly ColumnStep[];

export const DEFAULT_COLUMN_LAYOUT: ColumnLayout = [
  { minWidth: 0, columns: 1 },
  { minWidth: 800, columns: 2 },
  { minWidth: 1200, columns: 3 },
];

export function columnsForWidth(layout: ColumnLayout, width: number): number {
  let columns = layout[0]!.columns;
  for (const step of layout) {
    if (step.minWidth > width) break;
    columns = step.columns;
  }
  return columns;
}

/** Learn this width's count, clipping incompatible steps on either side. */
export function learnColumnCount(
  layout: ColumnLayout,
  width: number,
  columns: number,
): ColumnLayout {
  const steps = layout
    .filter((step) => step.minWidth !== width)
    .map((step) => ({
      minWidth: step.minWidth,
      columns:
        step.minWidth < width
          ? Math.min(step.columns, columns)
          : Math.max(step.columns, columns),
    }));
  steps.push({ minWidth: width, columns });
  steps.sort((a, b) => a.minWidth - b.minWidth);
  return steps.filter(
    (step, index) => index === 0 || step.columns !== steps[index - 1]!.columns,
  );
}

export function parseColumnLayout(value: unknown): ColumnLayout | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const layout: ColumnStep[] = [];
  for (const step of value) {
    if (
      typeof step !== "object" ||
      step === null ||
      !Number.isSafeInteger(step.minWidth) ||
      step.minWidth < 0 ||
      !Number.isSafeInteger(step.columns) ||
      step.columns < 1
    )
      return null;
    const previous = layout.at(-1);
    if (
      previous
        ? step.minWidth <= previous.minWidth || step.columns < previous.columns
        : step.minWidth !== 0
    )
      return null;
    layout.push({ minWidth: step.minWidth, columns: step.columns });
  }
  return layout;
}
