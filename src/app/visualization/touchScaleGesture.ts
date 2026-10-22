import { setSharedTooltipSuppressed } from "@/rendering/sharedTooltip";

interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

interface PinchSpan {
  readonly x: number;
  readonly y: number;
}

export interface PinchScale {
  readonly volumeLogScale: number;
  readonly ghostLogScale: number;
}

// Smooth near-axis pinches instead of dividing by a vanishing x or y span.
const AXIS_SOFTENING_PX = 32;

export function pinchSpan(a: TouchPoint, b: TouchPoint): PinchSpan {
  return {
    x: Math.hypot(b.clientX - a.clientX, AXIS_SOFTENING_PX),
    y: Math.hypot(b.clientY - a.clientY, AXIS_SOFTENING_PX),
  };
}

export function pinchScale(previous: PinchSpan, next: PinchSpan): PinchScale {
  // Spreading zooms in: fewer shares per pixel and a shorter time window.
  return {
    volumeLogScale: Math.log(previous.y / next.y),
    ghostLogScale: Math.log(previous.x / next.x),
  };
}

type Gesture =
  | { readonly kind: "idle" }
  | { readonly kind: "pinching"; readonly span: PinchSpan | null };

/** One dashboard-wide gesture owner; one-finger pans remain browser-owned. */
export function startTouchScaleGesture(
  target: EventTarget,
  scale: (scale: PinchScale) => void,
): () => void {
  let gesture: Gesture = { kind: "idle" };

  const spanFor = (touches: TouchList): PinchSpan | null =>
    touches.length === 2 ? pinchSpan(touches[0]!, touches[1]!) : null;

  const start = (raw: Event) => {
    const event = raw as TouchEvent;
    if (event.touches.length < 2) return;
    gesture = { kind: "pinching", span: spanFor(event.touches) };
    setSharedTooltipSuppressed(true);
    if (event.cancelable) event.preventDefault();
  };

  const move = (raw: Event) => {
    const event = raw as TouchEvent;
    if (gesture.kind === "idle") return;
    const next = spanFor(event.touches);
    if (event.cancelable) {
      event.preventDefault();
      if (gesture.span && next) scale(pinchScale(gesture.span, next));
    }
    gesture = { kind: "pinching", span: next };
  };

  const end = (raw: Event) => {
    const event = raw as TouchEvent;
    if (gesture.kind === "idle") return;
    // Suppress compatibility clicks and a stray scroll as the last finger lifts.
    if (event.cancelable) event.preventDefault();
    if (event.touches.length > 0) {
      gesture = { kind: "pinching", span: spanFor(event.touches) };
    } else {
      gesture = { kind: "idle" };
      setSharedTooltipSuppressed(false);
    }
  };

  const cancel = () => {
    gesture = { kind: "idle" };
    setSharedTooltipSuppressed(false);
  };

  const options = { capture: true, passive: false };
  target.addEventListener("touchstart", start, options);
  target.addEventListener("touchmove", move, options);
  target.addEventListener("touchend", end, options);
  target.addEventListener("touchcancel", cancel, options);
  return () => {
    target.removeEventListener("touchstart", start, true);
    target.removeEventListener("touchmove", move, true);
    target.removeEventListener("touchend", end, true);
    target.removeEventListener("touchcancel", cancel, true);
    cancel();
  };
}
