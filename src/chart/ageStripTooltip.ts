import type { BookHoverSnapshot } from "@/lib/bookHover";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";

export function tooltipSignature(
  tokenName: string,
  hover: BookHoverSnapshot,
): string {
  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? ""
      : formatProbability(
          isBid
            ? hover.effectivePrice
            : 1 - hover.effectivePrice,
        );

  return [
    tokenName,
    hover.side,
    formatProbability(tokenPrice),
    formatShares(hover.shares),
    effectivePrice,
  ].join("|");
}

export function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  hover: BookHoverSnapshot,
  colorScale: SignedVolumeColorScale,
): void {
  overlay.replaceChildren();

  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? null
      : isBid
        ? hover.effectivePrice
        : 1 - hover.effectivePrice;

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent =
    `${tokenName}@${formatProbability(tokenPrice)}`;
  title.style.color = signedVolumeColor(
    isBid ? 1 : -1,
    colorScale,
  );
  overlay.appendChild(title);
  overlay.appendChild(
    tooltipRow("Shares", formatShares(hover.shares)),
  );

  if (effectivePrice !== null)
    overlay.appendChild(
      tooltipRow(
        "Effective",
        formatProbability(effectivePrice),
      ),
    );
}

function tooltipRow(
  name: string,
  value: string,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cpv-ov-row";

  const key = document.createElement("span");
  key.textContent = name;

  const amount = document.createElement("b");
  amount.textContent = value;

  row.append(key, amount);
  return row;
}

function formatProbability(value: number): string {
  return value.toFixed(3);
}

function formatShares(value: number): string {
  if (!(value > 0)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}
