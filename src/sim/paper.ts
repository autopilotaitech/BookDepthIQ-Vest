import { bestAsk, bestBid, type Book } from '../book/book.js';

// LOCAL paper broker. Fills against Vest's live quoted book in this process only — it has no
// network access and nothing it does ever reaches Vest. It exists so the execution UI can be
// exercised end to end before any real order path is built (DESIGN.md phase 3).
//
// Prices are integer ticks. Quantities are Vest units (linear: 1.0 unit = $1 per point).
//
// Fill model, deliberately conservative:
// - Market: walks the opposite side of the book level by level (VWAP), never better than touch.
// - Limit:  fills at its own price once the opposite best reaches it. Never price-improved.
// - Stop:   triggers when the same-side best reaches it, then fills as a market order.
// The quoted book here is one market maker's ladder (DESIGN.md §1), so these fills are an
// approximation of what Vest's own matching would do, not a guarantee.

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'stop';

export interface WorkingOrder {
  id: number;
  side: Side;
  type: OrderType;
  priceTicks: number;
  qty: number;
  reduceOnly: boolean;
  /** 'tp' | 'sl' for bracket legs; undefined for user orders. */
  leg?: 'tp' | 'sl';
}

export interface Fill {
  id: number;
  orderId: number | null; // null for market orders
  side: Side;
  qty: number;
  priceTicks: number; // may be fractional: VWAP across levels
  liquidity: 'maker' | 'taker';
  feeUsd: number;
  realizedUsd: number;
  ts: number;
  note: string;
}

export interface BracketSettings {
  enabled: boolean;
  tpTicks: number; // 0 = no take-profit leg
  slTicks: number; // 0 = no stop-loss leg
}

export interface PaperConfig {
  tickSize: number;
  sizeDecimals: number;
  takerFee: number; // fraction of notional, e.g. 0.000025
  makerFee: number;
}

export interface Position {
  qty: number; // signed
  avgTicks: number; // 0 when flat
}

export interface Result {
  ok: boolean;
  message: string;
}

const ok = (message: string): Result => ({ ok: true, message });
const refuse = (message: string): Result => ({ ok: false, message });

export class PaperBroker {
  position: Position = { qty: 0, avgTicks: 0 };
  orders: WorkingOrder[] = [];
  fills: Fill[] = [];
  realizedUsd = 0;
  feesUsd = 0;
  bracket: BracketSettings = { enabled: true, tpTicks: 0, slTicks: 0 };

  private book: Book | null = null;
  private nextOrderId = 1;
  private nextFillId = 1;

  constructor(private readonly cfg: PaperConfig) {}

  // ───────────── market data ─────────────

  onBook(book: Book): void {
    this.book = book;
    this.match();
  }

  get hasBook(): boolean {
    return !!this.book && bestBid(this.book) !== undefined && bestAsk(this.book) !== undefined;
  }

  // ───────────── user actions ─────────────

  marketOrder(side: Side, qty: number, now = Date.now()): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    if (!this.hasBook) return refuse('no book yet');
    const before = this.position.qty;
    const f = this.executeMarket(side, q, null, now, 'market');
    if (!f) return refuse('book too thin to fill');
    this.afterEntryFill(before);
    return ok(`${side.toUpperCase()} ${q} @ ${this.px(f.priceTicks)}`);
  }

  limitOrder(side: Side, qty: number, priceTicks: number, now = Date.now()): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    this.orders.push({ id: this.nextOrderId++, side, type: 'limit', priceTicks, qty: q, reduceOnly: false });
    this.match(now);
    return ok(`${side.toUpperCase()} LMT ${q} @ ${this.px(priceTicks)}`);
  }

  stopOrder(side: Side, qty: number, priceTicks: number, now = Date.now()): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    if (!this.hasBook) return refuse('no book yet');
    // A stop already through the market would fire instantly — refuse rather than surprise.
    const bid = bestBid(this.book!)!;
    const ask = bestAsk(this.book!)!;
    if (side === 'buy' && priceTicks <= ask) return refuse('buy stop must be above the ask');
    if (side === 'sell' && priceTicks >= bid) return refuse('sell stop must be below the bid');
    this.orders.push({ id: this.nextOrderId++, side, type: 'stop', priceTicks, qty: q, reduceOnly: false });
    this.match(now);
    return ok(`${side.toUpperCase()} STP ${q} @ ${this.px(priceTicks)}`);
  }

  cancel(orderId: number): Result {
    const n = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== orderId);
    return n === this.orders.length ? refuse(`order ${orderId} not found`) : ok(`cancelled ${orderId}`);
  }

  /** Moves a working order. Stops may not be moved through the market. */
  modify(orderId: number, priceTicks: number, now = Date.now()): Result {
    const o = this.orders.find((x) => x.id === orderId);
    if (!o) return refuse(`order ${orderId} not found`);
    if (o.type === 'stop' && this.book) {
      const bid = bestBid(this.book);
      const ask = bestAsk(this.book);
      if (o.side === 'sell' && bid !== undefined && priceTicks >= bid) return refuse('sell stop must stay below the bid');
      if (o.side === 'buy' && ask !== undefined && priceTicks <= ask) return refuse('buy stop must stay above the ask');
    }
    o.priceTicks = priceTicks;
    this.match(now);
    return ok(`moved ${orderId} to ${this.px(priceTicks)}`);
  }

  cancelAll(): Result {
    const n = this.orders.length;
    this.orders = [];
    return ok(`cancelled ${n} order(s)`);
  }

  /** Cancel everything, then close the position at market. Always allowed. */
  flatten(now = Date.now()): Result {
    const n = this.orders.length;
    this.orders = [];
    const q = this.position.qty;
    if (q === 0) return ok(`FLATTEN — ${n} order(s), already flat`);
    if (!this.hasBook) return refuse(`FLATTEN — cancelled ${n} order(s), no book to close the position`);
    this.executeMarket(q > 0 ? 'sell' : 'buy', Math.abs(q), null, now, 'flatten');
    return ok(`FLATTEN — ${n} order(s), closed ${Math.abs(q)}`);
  }

  reverse(now = Date.now()): Result {
    const q = this.position.qty;
    if (q === 0) return refuse('no position to reverse');
    if (!this.hasBook) return refuse('no book yet');
    this.orders = this.orders.filter((o) => !o.reduceOnly);
    const before = q;
    this.executeMarket(q > 0 ? 'sell' : 'buy', Math.abs(q) * 2, null, now, 'reverse');
    this.afterEntryFill(before);
    return ok(`REVERSE to ${this.position.qty}`);
  }

  /**
   * Moves the protective stop to entry ± offset. Refused when that stop would already be through
   * the market — a long's break-even stop rests BELOW the bid, so pressing before price has run
   * past the offset is correctly refused (same rule as BookDepthIQ).
   */
  breakeven(offsetTicks: number, now = Date.now()): Result {
    const q = this.position.qty;
    if (q === 0) return refuse('flat — nothing to protect');
    if (!this.hasBook) return refuse('no book yet');
    const long = q > 0;
    const avg = this.position.avgTicks;
    const stop = long ? Math.floor(avg) + offsetTicks : Math.ceil(avg) - offsetTicks;
    const bid = bestBid(this.book!)!;
    const ask = bestAsk(this.book!)!;
    if (long && stop >= bid) return refuse(`B/E stop ${this.px(stop)} is not below the bid ${this.px(bid)}`);
    if (!long && stop <= ask) return refuse(`B/E stop ${this.px(stop)} is not above the ask ${this.px(ask)}`);
    const sl = this.orders.find((o) => o.leg === 'sl');
    if (sl) sl.priceTicks = stop;
    else
      this.orders.push({
        id: this.nextOrderId++,
        side: long ? 'sell' : 'buy',
        type: 'stop',
        priceTicks: stop,
        qty: Math.abs(q),
        reduceOnly: true,
        leg: 'sl',
      });
    this.match(now);
    return ok(`B/E stop @ ${this.px(stop)}`);
  }

  // ───────────── accounting ─────────────

  unrealizedUsd(): number {
    if (!this.book || this.position.qty === 0) return 0;
    const bid = bestBid(this.book);
    const ask = bestAsk(this.book);
    if (bid === undefined || ask === undefined) return 0;
    // Mark at the price we could actually exit at, not the mid.
    const exit = this.position.qty > 0 ? bid : ask;
    return (exit - this.position.avgTicks) * this.position.qty * this.cfg.tickSize;
  }

  /** |position| × mid, in $: what the position is worth on the open market right now. */
  notionalUsd(): number {
    if (this.position.qty === 0) return 0;
    const bid = this.book ? bestBid(this.book) : undefined;
    const ask = this.book ? bestAsk(this.book) : undefined;
    const mark = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : this.position.avgTicks;
    return Math.abs(this.position.qty) * mark * this.cfg.tickSize;
  }

  // ───────────── internals ─────────────

  private match(now = Date.now()): void {
    if (!this.hasBook) return;
    // Loop because one fill can arm or cancel other orders (brackets, OCO).
    for (let guard = 0; guard < 100; guard++) {
      const bid = bestBid(this.book!)!;
      const ask = bestAsk(this.book!)!;
      const due = this.orders.find((o) =>
        o.type === 'limit'
          ? o.side === 'buy'
            ? ask <= o.priceTicks
            : bid >= o.priceTicks
          : o.side === 'buy'
            ? ask >= o.priceTicks
            : bid <= o.priceTicks,
      );
      if (!due) return;
      this.orders = this.orders.filter((o) => o !== due);
      let qty = due.qty;
      if (due.reduceOnly) {
        // Reduce-only may close, never open or flip.
        const pos = this.position.qty;
        const closes = (due.side === 'sell' && pos > 0) || (due.side === 'buy' && pos < 0);
        qty = closes ? Math.min(qty, Math.abs(pos)) : 0;
        if (qty <= 0) continue;
      }
      const before = this.position.qty;
      if (due.type === 'limit') this.applyFill(due.side, qty, due.priceTicks, due.id, 'maker', now, due.leg ?? 'limit');
      else this.executeMarket(due.side, qty, due.id, now, due.leg ?? 'stop');
      if (due.leg) this.onBracketLegFilled();
      else this.afterEntryFill(before);
    }
  }

  /** Walks the opposite side of the book. Returns the fill, or null if the book is too thin. */
  private executeMarket(side: Side, qty: number, orderId: number | null, now: number, note: string): Fill | null {
    const lv = side === 'buy' ? this.book!.asks : this.book!.bids;
    let left = qty;
    let cost = 0;
    for (let i = 0; i < lv.ticks.length && left > 1e-12; i++) {
      const take = Math.min(left, lv.sizes[i]!);
      cost += take * lv.ticks[i]!;
      left -= take;
    }
    if (left > 1e-9) return null;
    return this.applyFill(side, qty, cost / qty, orderId, 'taker', now, note);
  }

  private applyFill(
    side: Side,
    qty: number,
    priceTicks: number,
    orderId: number | null,
    liquidity: 'maker' | 'taker',
    now: number,
    note: string,
  ): Fill {
    const signed = side === 'buy' ? qty : -qty;
    const pos = this.position;
    let realized = 0;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
      const newQty = this.roundQty(pos.qty + signed);
      pos.avgTicks = (pos.avgTicks * Math.abs(pos.qty) + priceTicks * qty) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = (priceTicks - pos.avgTicks) * closing * Math.sign(pos.qty) * this.cfg.tickSize;
      const newQty = this.roundQty(pos.qty + signed);
      if (newQty === 0) {
        pos.qty = 0;
        pos.avgTicks = 0;
      } else if (Math.sign(newQty) !== Math.sign(pos.qty)) {
        pos.qty = newQty; // flipped: the remainder opens at this fill's price
        pos.avgTicks = priceTicks;
      } else {
        pos.qty = newQty;
      }
    }
    const notional = qty * priceTicks * this.cfg.tickSize;
    const fee = notional * (liquidity === 'maker' ? this.cfg.makerFee : this.cfg.takerFee);
    this.realizedUsd += realized;
    this.feesUsd += fee;
    const f: Fill = {
      id: this.nextFillId++,
      orderId,
      side,
      qty,
      priceTicks,
      liquidity,
      feeUsd: fee,
      realizedUsd: realized,
      ts: now,
      note,
    };
    this.fills.push(f);
    if (this.position.qty === 0) this.dropProtectiveLegs();
    return f;
  }

  /** An entry changed the position: re-arm brackets for the whole position at the new average. */
  private afterEntryFill(before: number): void {
    if (this.position.qty === before) return;
    this.dropProtectiveLegs();
    if (this.position.qty === 0 || !this.bracket.enabled) return;
    const long = this.position.qty > 0;
    const qty = Math.abs(this.position.qty);
    const avg = this.position.avgTicks;
    const exit: Side = long ? 'sell' : 'buy';
    if (this.bracket.tpTicks > 0) {
      const tp = long ? Math.ceil(avg) + this.bracket.tpTicks : Math.floor(avg) - this.bracket.tpTicks;
      this.orders.push({ id: this.nextOrderId++, side: exit, type: 'limit', priceTicks: tp, qty, reduceOnly: true, leg: 'tp' });
    }
    if (this.bracket.slTicks > 0) {
      const sl = long ? Math.floor(avg) - this.bracket.slTicks : Math.ceil(avg) + this.bracket.slTicks;
      this.orders.push({ id: this.nextOrderId++, side: exit, type: 'stop', priceTicks: sl, qty, reduceOnly: true, leg: 'sl' });
    }
  }

  /** One bracket leg filled: OCO the other, and resize survivors to what is left. */
  private onBracketLegFilled(): void {
    if (this.position.qty === 0) {
      this.dropProtectiveLegs();
      return;
    }
    const left = Math.abs(this.position.qty);
    for (const o of this.orders) if (o.reduceOnly) o.qty = Math.min(o.qty, left);
  }

  /**
   * A protective leg with no position behind it is an entry order in disguise. Every reduce-only
   * order goes the moment the position is flat (BookDepthIQ BUG-1 / §3M).
   */
  private dropProtectiveLegs(): void {
    this.orders = this.orders.filter((o) => !o.reduceOnly);
  }

  private roundQty(q: number): number {
    const f = 10 ** this.cfg.sizeDecimals;
    return Math.round(q * f) / f;
  }

  private px(ticks: number): string {
    return formatPrice(ticks, this.cfg.tickSize);
  }
}

/** Decimal places a tick size needs: 0.25 -> 2, 0.01 -> 2, 0.03125 -> 5, 1 -> 0. */
export function tickDecimals(tickSize: number): number {
  for (let d = 0; d < 10; d++) {
    const scaled = tickSize * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 10;
}

export function formatPrice(ticks: number, tickSize: number): string {
  return (ticks * tickSize).toFixed(tickDecimals(tickSize));
}
