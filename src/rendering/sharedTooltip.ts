export type TooltipOwner = symbol;
export type TooltipVerticalPlacement = "auto" | "above" | "below";

let overlay: HTMLDivElement | null = null;
let activeOwner: TooltipOwner | null = null;
let activeSignature = "";
let suppressed = false;

export function showSharedTooltip(
  owner: TooltipOwner,
  signature: string,
  render: (overlay: HTMLDivElement) => void,
  anchorX: number,
  anchorY: number,
  verticalPlacement: TooltipVerticalPlacement = "auto",
): void {
  if (suppressed) return;

  const element = ensureOverlay();
  if (activeOwner !== owner || activeSignature !== signature) {
    render(element);
    activeOwner = owner;
    activeSignature = signature;
  }

  if (element.style.display !== "block") element.style.display = "block";
  const left = `${anchorX}px`;
  const top = `${anchorY}px`;
  if (element.style.left !== left) element.style.left = left;
  if (element.style.top !== top) element.style.top = top;

  const translateY =
    verticalPlacement === "above"
      ? "translateY(calc(-100% - 12px))"
      : verticalPlacement === "below"
        ? "translateY(12px)"
        : anchorY > window.innerHeight / 2
          ? "translateY(calc(-100% - 12px))"
          : "translateY(12px)";

  const transform = `${
    anchorX > window.innerWidth / 2
      ? "translateX(calc(-100% - 12px))"
      : "translateX(12px)"
  } ${translateY}`;
  if (element.style.transform !== transform)
    element.style.transform = transform;
}

export function hideSharedTooltip(owner: TooltipOwner): void {
  if (activeOwner !== owner) return;
  hideActiveTooltip();
}

export function releaseSharedTooltip(owner: TooltipOwner): void {
  hideSharedTooltip(owner);
}

export function setSharedTooltipSuppressed(next: boolean): void {
  suppressed = next;
  if (suppressed) hideActiveTooltip();
}

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.className = "cpv-overlay";
  overlay.setAttribute("role", "tooltip");
  document.body.appendChild(overlay);
  return overlay;
}

function hideActiveTooltip(): void {
  if (overlay) overlay.style.display = "none";
  activeOwner = null;
  activeSignature = "";
}
