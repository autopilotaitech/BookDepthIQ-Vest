// The order log: every order click and what became of it — sent, refused (with the reason), or
// stopped before anything was sent (stale feed, day limit, second-click check, no market). Kept
// across reloads so a "my orders don't work" report can be copied and pasted. Pure: no I/O; the
// caller persists `entries`.

export type OrderLogStatus = 'click' | 'blocked' | 'ok' | 'refused' | 'error';

export interface OrderLogEntry {
  t: number;
  status: OrderLogStatus;
  /** What was clicked, e.g. "PAPER BUY MKT 12.4u GC-PERP", or the outcome text. */
  text: string;
}

export const ORDER_LOG_MAX = 300;

export class OrderLog {
  entries: OrderLogEntry[];
  constructor(entries: OrderLogEntry[] = []) {
    this.entries = entries.slice(-ORDER_LOG_MAX);
  }
  add(status: OrderLogStatus, text: string, t = Date.now()): OrderLogEntry {
    const e = { t, status, text };
    this.entries.push(e);
    if (this.entries.length > ORDER_LOG_MAX) this.entries.splice(0, this.entries.length - ORDER_LOG_MAX);
    return e;
  }
  clear(): void {
    this.entries = [];
  }
  /** Oldest first, one line each, with a header of the context it was copied in. */
  text(header: string[] = []): string {
    const mark: Record<OrderLogStatus, string> = { click: '→', blocked: '⊘', ok: '✓', refused: '✗', error: '!!' };
    const lines = this.entries.map((e) => `${new Date(e.t).toISOString().slice(11, 23)}Z ${mark[e.status]} ${e.text}`);
    return [...header, ...lines].join('\n');
  }
}
