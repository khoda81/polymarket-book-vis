export interface DashboardDragPoint {
  readonly x: number;
  readonly y: number;
}

export interface DashboardGridSnapshot {
  /** Viewport-space origin of the first grid track. */
  readonly left: number;
  readonly top: number;
  readonly columnWidth: number;
  readonly columnGap: number;
  readonly rowHeight: number;
  readonly rowGap: number;
  readonly columnCount: number;
}

export interface DashboardDragItem {
  readonly key: string;
  readonly height: number;
  readonly rowSpan: number;
}

export interface DashboardDragSnapshot {
  readonly order: readonly string[];
  readonly items: readonly DashboardDragItem[];
  readonly grid: DashboardGridSnapshot;
  /** Pointer position inside the dragged card at pointer-down. */
  readonly grabOffset: DashboardDragPoint;
}

/**
 * Compute the candidate order from one immutable pointer-down snapshot.
 *
 * For every possible insertion slot we simulate the same shortest-column
 * masonry placement used by the dashboard. Prefer the insertion that places
 * the card in the pointer's column, then match the original grab point's
 * vertical position to the pointer.
 *
 * So placement is:
 *
 *   order = f(dragged card, pointer, drag-start layout)
 *
 * It never depends on an intermediate reflow.
 */
export function dashboardOrderForPointer(
  snapshot: DashboardDragSnapshot,
  draggedKey: string,
  pointer: DashboardDragPoint,
): string[] {
  const originalIndex = snapshot.order.indexOf(draggedKey);
  if (originalIndex < 0) return [...snapshot.order];

  const itemByKey = new Map(
    snapshot.items.map((item) => [item.key, item]),
  );
  if (!itemByKey.has(draggedKey)) return [...snapshot.order];

  const withoutDragged = snapshot.order.filter(
    (key) => key !== draggedKey,
  );
  if (withoutDragged.length === 0) return [draggedKey];

  let bestOrder = [...snapshot.order];
  let bestColumnDistance = Number.POSITIVE_INFINITY;
  let bestVerticalDistance = Number.POSITIVE_INFINITY;
  let bestIndexDistance = Number.POSITIVE_INFINITY;
  let bestInsertionIndex = Number.POSITIVE_INFINITY;
  const pointerColumn = columnForX(pointer.x, snapshot.grid);

  for (
    let insertionIndex = 0;
    insertionIndex <= withoutDragged.length;
    insertionIndex++
  ) {
    const candidate = [
      ...withoutDragged.slice(0, insertionIndex),
      draggedKey,
      ...withoutDragged.slice(insertionIndex),
    ];
    const rect = simulatedRectForKey(
      candidate,
      draggedKey,
      itemByKey,
      snapshot.grid,
    );
    if (!rect) continue;

    const columnDistance = Math.abs(rect.column - pointerColumn);
    const verticalDistance = squared(
      pointer.y - (rect.top + snapshot.grabOffset.y),
    );
    const indexDistance = Math.abs(
      insertionIndex - originalIndex,
    );

    if (
      columnDistance < bestColumnDistance ||
      (columnDistance === bestColumnDistance &&
        (verticalDistance < bestVerticalDistance ||
          (verticalDistance === bestVerticalDistance &&
            (indexDistance < bestIndexDistance ||
              (indexDistance === bestIndexDistance &&
                insertionIndex < bestInsertionIndex)))))
    ) {
      bestOrder = candidate;
      bestColumnDistance = columnDistance;
      bestVerticalDistance = verticalDistance;
      bestIndexDistance = indexDistance;
      bestInsertionIndex = insertionIndex;
    }
  }

  return bestOrder;
}

interface SimulatedRect {
  readonly column: number;
  readonly top: number;
}

function simulatedRectForKey(
  order: readonly string[],
  targetKey: string,
  itemByKey: ReadonlyMap<string, DashboardDragItem>,
  grid: DashboardGridSnapshot,
): SimulatedRect | null {
  const columnCount = Math.max(1, Math.floor(grid.columnCount));
  const nextRow = new Array<number>(columnCount).fill(0);

  for (const key of order) {
    const item = itemByKey.get(key);
    if (!item) continue;

    const column = shortestColumn(nextRow);
    const row = nextRow[column]!;
    if (key === targetKey) {
      return {
        column,
        top:
          grid.top +
          row * (grid.rowHeight + grid.rowGap),
      };
    }

    nextRow[column] = row + Math.max(1, item.rowSpan);
  }

  return null;
}

function columnForX(x: number, grid: DashboardGridSnapshot): number {
  const columnCount = Math.max(1, Math.floor(grid.columnCount));
  const pitch = grid.columnWidth + grid.columnGap;
  if (pitch <= 0) return 0;

  const firstCenter = grid.left + grid.columnWidth / 2;
  return Math.max(
    0,
    Math.min(columnCount - 1, Math.round((x - firstCenter) / pitch)),
  );
}

function shortestColumn(nextRow: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < nextRow.length; index++)
    if (nextRow[index]! < nextRow[best]!) best = index;
  return best;
}

function squared(value: number): number {
  return value * value;
}
