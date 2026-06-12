import { WS_URL } from "./constants";

export interface OrderBookEntry {
  p: string;
  s: number;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export type BookUpdateCallback = (books: Record<string, OrderBook>) => void;

type Status = "live" | "err" | "conn";

export class MarketWS {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectIds: string[] = [];
  private _status: Status = "conn";
  private onStatus: (s: Status) => void;
  private onUpdate: BookUpdateCallback;
  private books: Record<string, OrderBook> = {};

  constructor(
    ids: string[],
    onStatus: (s: Status) => void,
    onUpdate: BookUpdateCallback,
  ) {
    this.reconnectIds = ids;
    this.onStatus = onStatus;
    this.onUpdate = onUpdate;
    this.connect(ids);
  }

  get status(): Status {
    return this._status;
  }

  private setDot(s: Status) {
    this._status = s;
    this.onStatus(s);
  }

  private connect(ids: string[]) {
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.setDot("err");
      return;
    }
    this.setDot("conn");

    this.ws.onopen = () => {
      this.setDot("live");
      this.ws!.send(
        JSON.stringify({
          assets_ids: ids,
          type: "market",
          custom_feature_enabled: false,
        }),
      );
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === 1) this.ws!.send("PING");
      }, 9000);
    };

    this.ws.onmessage = (e) => {
      if (e.data === "PONG") return;
      try {
        this.applyMsg(JSON.parse(e.data));
        this.onUpdate(this.books);
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.setDot("conn");
      if (this.pingTimer) clearInterval(this.pingTimer);
      setTimeout(() => {
        if (this.reconnectIds.length) this.connect(this.reconnectIds);
      }, 3000);
    };

    this.ws.onerror = () => this.setDot("err");
  }

  private applyMsg(msg: unknown) {
    if (Array.isArray(msg)) {
      msg.forEach((m) => this.applyMsg(m));
      return;
    }
    const m = msg as Record<string, unknown>;
    const et = m.event_type;
    if (et === "book") {
      this.books[m.asset_id as string] = {
        bids: ((m.bids as Array<{ price: string; size: string }>) ?? []).map(
          (o) => ({ p: o.price, s: +o.size }),
        ),
        asks: ((m.asks as Array<{ price: string; size: string }>) ?? []).map(
          (o) => ({ p: o.price, s: +o.size }),
        ),
      };
    } else if (et === "price_change") {
      for (const pc of m.price_changes as Array<{
        asset_id: string;
        side: string;
        price: string;
        size: string;
      }>) {
        const book = this.books[pc.asset_id];
        if (!book) continue;
        const arr = pc.side === "BUY" ? book.bids : book.asks;
        const idx = arr.findIndex((o) => o.p === pc.price);
        if (idx >= 0) arr[idx].s = +pc.size;
        else arr.push({ p: pc.price, s: +pc.size });
      }
    }
  }

  close() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
