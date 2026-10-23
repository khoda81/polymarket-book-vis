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
  readonly rowSpan: number;
}

export interface DashboardDragSnapshot {
  /** Rendered cards in dashboard order. */
  readonly items: readonly DashboardDragItem[];
  readonly grid: DashboardGridSnapshot;
  /** Window scroll position paired with the viewport-space grid snapshot. */
  readonly viewportScrollY: number;
  /** Pointer position inside the dragged card at pointer-down. */
  readonly grabOffset: DashboardDragPoint;
}

const AUTO_SCROLL_EDGE_PX = 96;
const MAX_AUTO_SCROLL_PX_PER_SECOND = 900;

/** Signed window-scroll velocity for a pointer near a viewport edge. */
export function dashboardDragScrollVelocity(
  pointerY: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(pointerY) || !(viewportHeight > 0)) return 0;

  const edge = Math.min(AUTO_SCROLL_EDGE_PX, viewportHeight / 3);
  if (pointerY < edge)
    return (
      -MAX_AUTO_SCROLL_PX_PER_SECOND *
      Math.min(1, Math.max(0, (edge - pointerY) / edge))
    );
  if (pointerY > viewportHeight - edge)
    return (
      MAX_AUTO_SCROLL_PX_PER_SECOND *
      Math.min(1, Math.max(0, (pointerY - (viewportHeight - edge)) / edge))
    );
  return 0;
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
  viewportScrollY = snapshot.viewportScrollY,
): string[] {
  const originalIndex = snapshot.items.findIndex(
    (item) => item.key === draggedKey,
  );
  const dragged = snapshot.items[originalIndex]!;
  const others = snapshot.items.filter((item) => item !== dragged);

  let bestOrder: readonly DashboardDragItem[] = snapshot.items;
  let bestColumnDistance = Number.POSITIVE_INFINITY;
  let bestVerticalDistance = Number.POSITIVE_INFINITY;
  let bestIndexDistance = Number.POSITIVE_INFINITY;
  let bestInsertionIndex = Number.POSITIVE_INFINITY;
  const pointerColumn = columnForX(pointer.x, snapshot.grid);
  const pointerY =
    pointer.y + Math.max(0, viewportScrollY) - snapshot.viewportScrollY;

  for (
    let insertionIndex = 0;
    insertionIndex <= others.length;
    insertionIndex++
  ) {
    const candidate = [
      ...others.slice(0, insertionIndex),
      dragged,
      ...others.slice(insertionIndex),
    ];
    const rect = simulatedRect(candidate, insertionIndex, snapshot.grid);

    const columnDistance = Math.abs(rect.column - pointerColumn);
    const verticalDistance = squared(
      pointerY - (rect.top + snapshot.grabOffset.y),
    );
    const indexDistance = Math.abs(insertionIndex - originalIndex);

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

  return bestOrder.map((item) => item.key);
}

interface SimulatedRect {
  readonly column: number;
  readonly top: number;
}

/** Shortest-column placement of `items[targetIndex]` after the cards before it. */
function simulatedRect(
  items: readonly DashboardDragItem[],
  targetIndex: number,
  grid: DashboardGridSnapshot,
): SimulatedRect {
  const nextRow = new Array<number>(grid.columnCount).fill(0);
  for (const item of items.slice(0, targetIndex)) {
    const column = shortestColumn(nextRow);
    nextRow[column] = nextRow[column]! + item.rowSpan;
  }
  const column = shortestColumn(nextRow);
  return {
    column,
    top: grid.top + nextRow[column]! * (grid.rowHeight + grid.rowGap),
  };
}

function columnForX(x: number, grid: DashboardGridSnapshot): number {
  const pitch = grid.columnWidth + grid.columnGap;
  if (pitch <= 0) return 0;

  const firstCenter = grid.left + grid.columnWidth / 2;
  return Math.max(
    0,
    Math.min(grid.columnCount - 1, Math.round((x - firstCenter) / pitch)),
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
