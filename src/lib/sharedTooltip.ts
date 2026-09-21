export type TooltipOwner = symbol;

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
): void {
  if (suppressed) return;

  const element = ensureOverlay();
  if (activeOwner !== owner || activeSignature !== signature) {
    render(element);
    activeOwner = owner;
    activeSignature = signature;
  }

  element.style.display = "block";
  element.style.left = `${anchorX}px`;
  element.style.top = `${anchorY}px`;
  element.style.transform =
    `${anchorX > window.innerWidth / 2
      ? "translateX(calc(-100% - 12px))"
      : "translateX(12px)"} ${anchorY > window.innerHeight / 2
        ? "translateY(calc(-100% - 12px))"
        : "translateY(12px)"}`;
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
