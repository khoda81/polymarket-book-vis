import type { CardReorderStart } from "./cardReorderSurface";
import {
  dashboardDragScrollVelocity,
  dashboardOrderForPointer,
  type DashboardDragSnapshot,
} from "./dashboardReorder";
import { setSharedTooltipSuppressed } from "../../rendering/sharedTooltip";

const GRID_SELECTOR = ".grid";
const GRID_ITEM_SELECTOR = ".grid-item[data-layout-key]";
const DEFAULT_FRAME_MS = 1_000 / 60;
const MAX_FRAME_MS = 1_000 / 30;
const MILLISECONDS_PER_SECOND = 1_000;

interface DragSession {
  readonly key: string;
  readonly snapshot: DashboardDragSnapshot;
  pointer: { x: number; y: number };
}

export interface DashboardReorderControllerOptions {
  readonly getOrder: () => readonly string[];
  readonly getColumnCount: () => number;
  readonly setOrder: (order: string[]) => void;
  readonly setDraggingKey: (key: string | null) => void;
  readonly persistOrder: () => void;
}

/** Owns the complete pointer-drag lifecycle, including listeners and RAF state. */
export class DashboardReorderController {
  private session: DragSession | null = null;
  private scrollFrame: number | null = null;
  private scrollFrameTime: number | null = null;

  constructor(private readonly options: DashboardReorderControllerOptions) {}

  start(start: CardReorderStart, key: string): void {
    const { event, origin, surface } = start;
    event.preventDefault();
    this.finish();

    const grid = document.querySelector<HTMLElement>(GRID_SELECTOR);
    if (!grid) return;
    const nodes = Array.from(
      grid.querySelectorAll<HTMLElement>(GRID_ITEM_SELECTOR),
    );
    const draggedNode = nodes.find((node) => node.dataset.layoutKey === key);
    if (!draggedNode) return;

    const gridStyles = getComputedStyle(grid);
    const gridRect = grid.getBoundingClientRect();
    const draggedRect = draggedNode.getBoundingClientRect();
    const rowHeight = Number.parseFloat(gridStyles.gridAutoRows);
    const rowGap = Number.parseFloat(gridStyles.rowGap);
    const columnGap = Number.parseFloat(gridStyles.columnGap);
    const paddingLeft = Number.parseFloat(gridStyles.paddingLeft);
    const paddingTop = Number.parseFloat(gridStyles.paddingTop);
    if (
      ![rowHeight, rowGap, columnGap, paddingLeft, paddingTop].every(
        Number.isFinite,
      )
    )
      return;

    const items = nodes.flatMap((node) => {
      const itemKey = node.dataset.layoutKey;
      if (!itemKey) return [];
      const rect = node.getBoundingClientRect();
      return [
        {
          key: itemKey,
          height: rect.height,
          rowSpan: Math.max(
            1,
            Math.ceil((rect.height + rowGap) / (rowHeight + rowGap)),
          ),
        },
      ];
    });
    const order = this.options.getOrder();
    const visibleKeys = new Set(items.map((item) => item.key));
    const visibleOrder = [
      ...order.filter((itemKey) => visibleKeys.has(itemKey)),
      ...items
        .map((item) => item.key)
        .filter((itemKey) => !order.includes(itemKey)),
    ];
    const snapshot: DashboardDragSnapshot = {
      order: visibleOrder,
      items,
      viewportScrollY: window.scrollY,
      grid: {
        left: gridRect.left + paddingLeft,
        top: gridRect.top + paddingTop,
        columnWidth: draggedRect.width,
        columnGap,
        rowHeight,
        rowGap,
        columnCount: this.options.getColumnCount(),
      },
      grabOffset: {
        x: origin.x - draggedRect.left,
        y: origin.y - draggedRect.top,
      },
    };

    this.session = {
      key,
      snapshot,
      pointer: { x: event.clientX, y: event.clientY },
    };
    this.options.setDraggingKey(key);
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may fail when the browser has already ended the input.
    }

    setSharedTooltipSuppressed(true);
    window.addEventListener("pointermove", this.move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", this.finish, {
      capture: true,
      once: true,
    });
    window.addEventListener("pointercancel", this.finish, {
      capture: true,
      once: true,
    });
    this.move(event);
  }

  step(key: string, direction: -1 | 1, visibleKeys: readonly string[]): void {
    const index = visibleKeys.indexOf(key);
    const neighbor = visibleKeys[index + direction];
    if (index < 0 || !neighbor) return;

    const order = this.options.getOrder();
    const from = order.indexOf(key);
    const to = order.indexOf(neighbor);
    if (from < 0 || to < 0) return;

    const next = [...order];
    [next[from], next[to]] = [next[to]!, next[from]!];
    this.options.setOrder(next);
    this.options.persistOrder();
  }

  readonly finish = (): void => {
    window.removeEventListener("pointermove", this.move, true);
    window.removeEventListener("pointerup", this.finish, true);
    window.removeEventListener("pointercancel", this.finish, true);
    if (this.session) this.options.persistOrder();
    this.stopAutoScroll();
    this.session = null;
    this.options.setDraggingKey(null);
    setSharedTooltipSuppressed(false);
  };

  private readonly move = (event: PointerEvent): void => {
    if (!this.session) return;
    event.preventDefault();
    event.stopPropagation();
    this.session.pointer = { x: event.clientX, y: event.clientY };
    this.applyAtPointer();
    this.updateAutoScroll();
  };

  private applyAtPointer(): void {
    const session = this.session;
    if (!session) return;
    const nextVisible = dashboardOrderForPointer(
      session.snapshot,
      session.key,
      session.pointer,
      window.scrollY,
    );
    const visible = new Set(session.snapshot.order);
    let nextIndex = 0;
    const current = this.options.getOrder();
    const next = current.map((itemKey) =>
      visible.has(itemKey) ? (nextVisible[nextIndex++] ?? itemKey) : itemKey,
    );
    if (next.every((itemKey, index) => itemKey === current[index])) return;
    this.options.setOrder(next);
  }

  private updateAutoScroll(): void {
    if (!this.session) return;
    if (
      dashboardDragScrollVelocity(
        this.session.pointer.y,
        window.innerHeight,
      ) === 0
    ) {
      this.stopAutoScroll();
      return;
    }
    if (this.scrollFrame === null)
      this.scrollFrame = requestAnimationFrame(this.runAutoScroll);
  }

  private readonly runAutoScroll = (time: number): void => {
    this.scrollFrame = null;
    if (!this.session) return;
    const velocity = dashboardDragScrollVelocity(
      this.session.pointer.y,
      window.innerHeight,
    );
    if (velocity === 0) {
      this.scrollFrameTime = null;
      return;
    }

    const elapsedMs =
      this.scrollFrameTime === null
        ? DEFAULT_FRAME_MS
        : Math.min(MAX_FRAME_MS, Math.max(0, time - this.scrollFrameTime));
    this.scrollFrameTime = time;
    const before = window.scrollY;
    window.scrollBy(0, (velocity * elapsedMs) / MILLISECONDS_PER_SECOND);
    if (window.scrollY === before) {
      this.scrollFrameTime = null;
      return;
    }

    this.applyAtPointer();
    this.scrollFrame = requestAnimationFrame(this.runAutoScroll);
  };

  private stopAutoScroll(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.scrollFrameTime = null;
  }
}
