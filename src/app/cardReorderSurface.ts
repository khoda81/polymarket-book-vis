export interface CardReorderStart {
  readonly surface: HTMLElement;
  readonly origin: { readonly x: number; readonly y: number };
  readonly event: PointerEvent;
}

export function reorderHandleKeydown(
  event: KeyboardEvent,
  step: (direction: -1 | 1) => void,
): void {
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    step(-1);
  } else if (
    event.key === "ArrowRight" ||
    event.key === "ArrowDown"
  ) {
    event.preventDefault();
    step(1);
  }
}

export function reorderHandleClick(
  event: MouseEvent,
  step: (direction: -1 | 1) => void,
): void {
  if (event.detail === 0) step(1);
}

const DRAG_THRESHOLD_PX = 5;
const NO_REORDER_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "details",
  "canvas",
  "img",
  "[contenteditable]",
  ".card-actions",
  ".cpv-chart-stage",
  ".cpv-hidden-markets",
  ".cpv-event-description",
  ".cpv-market-rules",
  ".cpv-heading-copy",
  ".cpv-status",
  ".series-nav",
].join(", ");

function isReorderSurface(
  card: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element) || !card.contains(target))
    return false;
  if (target.closest(".card-drag")) return true;
  return !target.closest(NO_REORDER_SELECTOR);
}

export function cardReorderSurface(
  card: HTMLElement,
  onStart: (start: CardReorderStart) => void,
): { destroy(): void } {
  let pending: {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
  } | null = null;

  const clearPending = (): void => {
    pending = null;
    window.removeEventListener("pointermove", movePending, true);
    window.removeEventListener("pointerup", endPending, true);
    window.removeEventListener("pointercancel", endPending, true);
  };

  const movePending = (event: PointerEvent): void => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (
      Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <
      DRAG_THRESHOLD_PX
    )
      return;

    const origin = { x: pending.x, y: pending.y };
    clearPending();
    onStart({ surface: card, origin, event });
  };

  const endPending = (event: PointerEvent): void => {
    if (event.pointerId === pending?.pointerId) clearPending();
  };

  const pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !isReorderSurface(card, event.target))
      return;
    if (
      event.pointerType !== "mouse" &&
      !(event.target instanceof Element &&
        event.target.closest(".card-drag"))
    )
      return;

    clearPending();
    pending = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    window.addEventListener("pointermove", movePending, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", endPending, true);
    window.addEventListener("pointercancel", endPending, true);
  };

  const pointerMove = (event: PointerEvent): void => {
    card.classList.toggle(
      "card--reorder-hover",
      event.pointerType === "mouse" &&
        isReorderSurface(card, event.target),
    );
  };

  const pointerLeave = (): void => {
    card.classList.remove("card--reorder-hover");
  };

  card.addEventListener("pointerdown", pointerDown);
  card.addEventListener("pointermove", pointerMove);
  card.addEventListener("pointerleave", pointerLeave);

  return {
    destroy() {
      clearPending();
      card.removeEventListener("pointerdown", pointerDown);
      card.removeEventListener("pointermove", pointerMove);
      card.removeEventListener("pointerleave", pointerLeave);
    },
  };
}
