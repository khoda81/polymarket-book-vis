import type { TokenBook } from "@/domain/books/orderBook";
import type { ClobAssetId } from "@polymarket/client";
import type { MarketEvent } from "@polymarket/client/actions";

export function sameTokenKeys(
  left: ReadonlySet<ClobAssetId> | undefined,
  right: ReadonlySet<ClobAssetId>,
): boolean {
  if (!left) return right.size === 0;
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function booksEqual(left: TokenBook, right: TokenBook): boolean {
  return (
    ordersEqual(left.usdToYes.asOrders(), right.usdToYes.asOrders()) &&
    ordersEqual(left.yesToUsd.asSellOrders(), right.yesToUsd.asSellOrders())
  );
}

function ordersEqual(
  left: Iterable<{ readonly price: unknown; readonly take: number }>,
  right: Iterable<{ readonly price: unknown; readonly take: number }>,
): boolean {
  const a = [...left];
  const b = [...right];
  return (
    a.length === b.length &&
    a.every(
      (order, index) =>
        order.price === b[index]!.price && order.take === b[index]!.take,
    )
  );
}

export function marketEventPayload(
  event: MarketEvent,
): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

export function marketEventKey(event: MarketEvent): string | null {
  const payload = marketEventPayload(event);
  const value = payload.conditionId ?? payload.market;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function marketEventTimeMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0
    ? Math.trunc(timestamp)
    : null;
}
