export interface DashboardDragPoint {
  readonly x: number;
  readonly y: number;
}

export interface DashboardDragRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface DashboardDragItem {
  readonly key: string;
  readonly rect: DashboardDragRect;
}

export interface DashboardDragSnapshot {
  readonly order: readonly string[];
  readonly items: readonly DashboardDragItem[];
}

/**
 * Compute the entire candidate order from immutable pointer-down geometry.
 *
 * Nothing from the currently reflowed dashboard is consulted here. That makes
 * dragging path-independent: revisiting the same pointer coordinate during one
 * drag always produces the same order.
 */
export function dashboardOrderForPointer(
  snapshot: DashboardDragSnapshot,
  draggedKey: string,
  pointer: DashboardDragPoint,
): string[] {
  if (!snapshot.order.includes(draggedKey))
    return [...snapshot.order];

  const withoutDragged = snapshot.order.filter(
    (key) => key !== draggedKey,
  );
  if (withoutDragged.length === 0) return [draggedKey];

  const rank = new Map(
    withoutDragged.map((key, index) => [key, index]),
  );
  const candidates = snapshot.items.filter(
    (item) =>
      item.key !== draggedKey &&
      rank.has(item.key),
  );
  if (candidates.length === 0) return [...snapshot.order];

  let target = candidates[0]!;
  let bestDistance = distanceSquaredToRect(pointer, target.rect);

  for (let index = 1; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const distance = distanceSquaredToRect(pointer, candidate.rect);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        (rank.get(candidate.key) ?? Number.POSITIVE_INFINITY) <
          (rank.get(target.key) ?? Number.POSITIVE_INFINITY))
    ) {
      target = candidate;
      bestDistance = distance;
    }
  }

  const targetIndex = rank.get(target.key);
  if (targetIndex === undefined) return [...snapshot.order];

  const insertAfter = pointerFallsAfterCard(pointer, target.rect);
  const insertionIndex = targetIndex + (insertAfter ? 1 : 0);

  return [
    ...withoutDragged.slice(0, insertionIndex),
    draggedKey,
    ...withoutDragged.slice(insertionIndex),
  ];
}

function distanceSquaredToRect(
  point: DashboardDragPoint,
  rect: DashboardDragRect,
): number {
  const dx =
    point.x < rect.left
      ? rect.left - point.x
      : point.x > rect.right
        ? point.x - rect.right
        : 0;
  const dy =
    point.y < rect.top
      ? rect.top - point.y
      : point.y > rect.bottom
        ? point.y - rect.bottom
        : 0;
  return dx * dx + dy * dy;
}

/**
 * Split a target card into stable before/after regions.
 *
 * Vertical motion is the primary ordering signal. Around the card's horizontal
 * midline, horizontal motion breaks the tie so moving across a row feels
 * natural. The boundary depends only on the pointer-down rectangle.
 */
function pointerFallsAfterCard(
  point: DashboardDragPoint,
  rect: DashboardDragRect,
): boolean {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const normalizedY =
    (point.y - centerY) / Math.max(1, rect.height);

  if (Math.abs(normalizedY) <= 0.2)
    return point.x > centerX;

  return point.y > centerY;
}
