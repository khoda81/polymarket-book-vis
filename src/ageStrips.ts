import type { PolymarketCPV } from "./component";
import type { TokenBook } from "@/lib/orderBook";
import { signedVolumeColor } from "@/lib/signedVolume";
import {
  StaleSignedVolume,
  staleVolumeAlpha,
} from "@/lib/staleSignedVolume";

/**
 * Experimental age-mode renderer.
 *
 * This deliberately installs at the component boundary so the experiment can
 * reuse the existing websocket/order-book machinery without changing it. The
 * component's private methods are ordinary prototype methods at runtime; the
 * narrow adapter below hooks the exact point where a complete book update has
 * already been applied, then replaces only the age-mode renderer.
 */
export function installAgeStripView(chart: PolymarketCPV): void {
  const component = chart as unknown as {
    event?: {
      markets: Array<{
        id: string;
        question: string;
        outcomes: { yes: { tokenId: string | null } };
      }>;
    };
    activeTokens: Set<string>;
    books: Record<string, TokenBook<string>>;
    titles: Record<string, string>;
    theme: unknown;
    plotter: {
      beginFrame(theme: unknown, domain: {
        xRange: { min: number; max: number };
        yRange: { min: number; max: number };
      }): any;
    };
    updateSpreadAge(tokenId: string, nowMs: number): void;
    drawAgeView(): void;
    load(event: unknown): Promise<void>;
  };

  const memories = new Map<string, StaleSignedVolume>();

  const originalUpdateSpreadAge = component.updateSpreadAge.bind(component);
  component.updateSpreadAge = (tokenId: string, nowMs: number) => {
    originalUpdateSpreadAge(tokenId, nowMs);
    const book = component.books[tokenId];
    if (!book) return;
    const memory = memories.get(tokenId) ?? new StaleSignedVolume();
    memory.update(book, nowMs);
    memories.set(tokenId, memory);
  };

  const originalLoad = component.load.bind(component);
  component.load = async (event: unknown) => {
    memories.clear();
    await originalLoad(event);
  };

  component.drawAgeView = () => {
    const markets = component.event?.markets ?? [];
    const views = markets.flatMap((market) => {
      const tokenId = market.outcomes.yes.tokenId;
      if (tokenId === null || !component.activeTokens.has(tokenId)) return [];
      return [
        {
          tokenId,
          label: compactLabel(component.titles[market.id] ?? market.question),
        },
      ];
    });

    const count = Math.max(1, views.length);
    const frame = component.plotter.beginFrame(component.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: count - 0.5 },
    });

    const rowLabels = new Map<number, string>();
    const yTicks: number[] = [];
    for (const [index, view] of views.entries()) {
      const y = count - 1 - index;
      yTicks.push(y);
      rowLabels.set(y, view.label);
    }

    frame.drawAxes({
      yTicks,
      formatY: (value: number) => rowLabels.get(Math.round(value)) ?? "",
    });

    if (views.length === 0) return;

    const rowSpacing = frame.viewport.height / count;
    const lineWidth = Math.max(4, Math.min(12, rowSpacing * 0.3));
    const nowMs = performance.now();

    for (const [index, view] of views.entries()) {
      const y = count - 1 - index;
      const screenY = frame.toScreenY(0, y);

      // A faint full-width rail makes very old/transparent regions legible as
      // missing information rather than looking like a rendering bug.
      frame.ctx.save();
      frame.ctx.strokeStyle = frame.theme.grid;
      frame.ctx.lineWidth = Math.max(1, lineWidth * 0.15);
      frame.ctx.beginPath();
      frame.ctx.moveTo(frame.toScreenX(0, y), screenY);
      frame.ctx.lineTo(frame.toScreenX(1, y), screenY);
      frame.ctx.stroke();
      frame.ctx.restore();

      const segments = memories.get(view.tokenId)?.segments(nowMs) ?? [];
      for (const segment of segments) {
        frame.ctx.save();
        frame.ctx.globalAlpha = staleVolumeAlpha(segment.ageMs);
        frame.ctx.strokeStyle = signedVolumeColor(segment.volume);
        frame.ctx.lineWidth = lineWidth;
        frame.ctx.lineCap = "butt";
        frame.ctx.beginPath();
        frame.ctx.moveTo(frame.toScreenX(segment.lo, y), screenY);
        frame.ctx.lineTo(frame.toScreenX(segment.hi, y), screenY);
        frame.ctx.stroke();
        frame.ctx.restore();
      }
    }
  };
}

function compactLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 9)}…`;
}
