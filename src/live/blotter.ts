// The order blotter: every request the panel sends to Vest, with where it stands. Pure: no I/O.
//   SENT      request on its way
//   ACKED     Vest answered OK (ack time in ms)
//   WORKING   a resting order seen in Vest's open orders
//   FILLED    a working order that left the book while a position changed (or a market entry)
//   GONE      a working order that left the book otherwise
//   REJECTED  Vest answered with an error
//   NO ANSWER still SENT after 3 s — check Vest before resending

export type BlotterStatus = 'SENT' | 'ACKED' | 'WORKING' | 'FILLED' | 'GONE' | 'REJECTED' | 'NO ANSWER';

export interface BlotterRow {
  id: number;
  at: number;
  /** What the request does, e.g. "LIMIT", "MARKET", "APPEND", "CANCEL", "STOP MOVE". */
  kind: string;
  side?: 'buy' | 'sell';
  qty?: string;
  price?: string;
  symbol?: string;
  status: BlotterStatus;
  ackMs?: number;
  orderId?: string;
  note?: string;
}

export const NO_ANSWER_MS = 3000;

/** What a write to `path` with `body` is, for the blotter. */
export function describeWrite(path: string, body: Record<string, unknown> | undefined): Pick<BlotterRow, 'kind' | 'side' | 'qty' | 'price' | 'symbol'> {
  const b = body ?? {};
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const sideOf = (): 'buy' | 'sell' | undefined => (b.side === 'long' || b.isBuy === true ? 'buy' : b.side === 'short' || b.isBuy === false ? 'sell' : undefined);
  const base = { qty: str(b.quantity), price: str(b.price ?? b.triggerPrice), symbol: str(b.symbol) };
  if (path.endsWith('/positions/open')) return { kind: String(b.orderType ?? 'order').toUpperCase(), side: sideOf(), ...base };
  if (path.endsWith('/positions/append')) return { kind: 'APPEND', side: sideOf(), ...base };
  if (path.endsWith('/positions/reduce')) return { kind: 'REDUCE', ...base };
  if (path.endsWith('/positions/close')) return { kind: 'CLOSE', ...base };
  if (path.endsWith('/positions/cancel-order')) return { kind: 'CANCEL', ...base, price: undefined };
  if (path.endsWith('/positions/stop-loss')) return { kind: b.stopLossId ? 'STOP MOVE' : 'STOP ADD', ...base };
  if (path.endsWith('/positions/take-profit')) return { kind: b.takeProfitId ? 'TP MOVE' : 'TP ADD', ...base };
  return { kind: path.split('/').pop() ?? 'write', ...base };
}

export class Blotter {
  rows: BlotterRow[] = [];
  private nextId = 1;

  constructor(private readonly keep = 50) {}

  sent(at: number, d: Pick<BlotterRow, 'kind' | 'side' | 'qty' | 'price' | 'symbol'>): number {
    const row: BlotterRow = { id: this.nextId++, at, status: 'SENT', ...d };
    this.rows.unshift(row);
    if (this.rows.length > this.keep) this.rows.length = this.keep;
    return row.id;
  }

  answered(id: number, at: number, ok: boolean, info: { orderId?: string; error?: string }): void {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    r.ackMs = at - r.at;
    if (!ok) {
      r.status = 'REJECTED';
      r.note = info.error;
      return;
    }
    r.orderId = info.orderId ?? r.orderId;
    r.status = r.kind === 'MARKET' || r.kind === 'CLOSE' || r.kind === 'REDUCE' ? 'FILLED' : 'ACKED';
  }

  /** After a positions + orders read: resting orders seen → WORKING; ones that left → FILLED/GONE. */
  reconcile(openOrderIds: Set<string>, positionChanged: boolean, now: number): void {
    for (const r of this.rows) {
      if (r.status === 'SENT' && now - r.at >= NO_ANSWER_MS) r.status = 'NO ANSWER';
      if (!r.orderId) continue;
      if (openOrderIds.has(r.orderId)) {
        if (r.status === 'ACKED') r.status = 'WORKING';
      } else if (r.status === 'WORKING') {
        r.status = positionChanged ? 'FILLED' : 'GONE';
      }
    }
  }

  /** The newest row for a Vest order id. */
  forOrder(orderId: string): BlotterRow | undefined {
    return this.rows.find((r) => r.orderId === orderId);
  }

  ackTimes(): number[] {
    return this.rows.filter((r) => r.ackMs !== undefined && r.status !== 'REJECTED').map((r) => r.ackMs!);
  }
}
