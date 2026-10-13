import { bestAsk, bestBid, type Book } from '../book/book.js';
import { splitTargets, type Target } from '../live/targets.js';
import { lineTrailTarget, trailTarget, type TrendLines } from '../live/manage.js';

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
  /** Entry orders: the bracket as it was when you clicked (so a fill later uses the same stop the
   * size was worked out from). */
  bracket?: BracketSettings;
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
  /** TP1..TP3 + size split; 2 or more on = partial targets instead of the one tpTicks leg. */
  targets?: Target[];
  /** With partial targets: stop to entry ± beOffset once TP1 fills. */
  beAfterTp1?: boolean;
  beOffset?: number;
  /** Trailing stop: starts at this many × risk in your favour, keeps 1 risk behind. 0 = off. */
  trailStartR?: number;
  /** Or a SuperTrend trail: the stop follows ST1 / ST2 (wins over trailStartR). */
  trailLine?: 1 | 2;
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
  /** B/E after TP1 already done for the current position. */
  private beDone = false;
  /** Trailing stop for the current position: risk in ticks at entry, best exit price since. */
  private trailRisk = 0;
  private trailBest: number | undefined;
  /** The panel's SuperTrend lines, fed by the model on every trade (SuperTrend trail). */
  trendLines: TrendLines = {};
  private nextOrderId = 1;
  private nextFillId = 1;

  constructor(private readonly cfg: PaperConfig) {}

  // ───────────── market data ─────────────

  onBook(book: Book): void {
    this.book = book;
    this.match();
    if (this.trailStep()) this.match();
  }

  get hasBook(): boolean {
    return !!this.book && bestBid(this.book) !== undefined && bestAsk(this.book) !== undefined;
  }

  // ───────────── user actions ─────────────

  marketOrder(side: Side, qty: number, now = Date.now(), bracket?: BracketSettings): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    if (!this.hasBook) return refuse('no book yet');
    const before = this.position.qty;
    const f = this.executeMarket(side, q, null, now, 'market');
    if (!f) return refuse('book too thin to fill');
    this.afterEntryFill(before, bracket);
    return ok(`${side.toUpperCase()} ${q} @ ${this.px(f.priceTicks)}`);
  }

  limitOrder(side: Side, qty: number, priceTicks: number, now = Date.now(), bracket?: BracketSettings): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    this.orders.push({ id: this.nextOrderId++, side, type: 'limit', priceTicks, qty: q, reduceOnly: false, bracket });
    this.match(now);
    return ok(`${side.toUpperCase()} LMT ${q} @ ${this.px(priceTicks)}`);
  }

  stopOrder(side: Side, qty: number, priceTicks: number, now = Date.now(), bracket?: BracketSettings): Result {
    const q = this.roundQty(qty);
    if (q <= 0) return refuse('quantity must be > 0');
    if (!this.hasBook) return refuse('no book yet');
    // A stop already through the market would fire instantly — refuse rather than surprise.
    const bid = bestBid(this.book!)!;
    const ask = bestAsk(this.book!)!;
    if (side === 'buy' && priceTicks <= ask) return refuse('buy stop must be above the ask');
    if (side === 'sell' && priceTicks >= bid) return refuse('sell stop must be below the bid');
    this.orders.push({ id: this.nextOrderId++, side, type: 'stop', priceTicks, qty: q, reduceOnly: false, bracket });
    this.match(now);
    return ok(`${side.toUpperCase()} STP ${q} @ ${this.px(priceTicks)}`);
  }

  /**
   * A trade printed on this market. A stop entry fires on the first trade that touches it (at or
   * through), as LIVE panel-held stops do, even if the book has not shown the move yet.
   */
  onTradePrint(priceTicks: number, timeMs: number): void {
    if (!this.hasBook) return;
    const due = this.orders.filter((o) => o.type === 'stop' && !o.leg && !o.reduceOnly && (o.side === 'buy' ? priceTicks >= o.priceTicks : priceTicks <= o.priceTicks));
    for (const o of due) {
      this.orders = this.orders.filter((x) => x !== o);
      const before = this.position.qty;
      if (this.executeMarket(o.side, o.qty, o.id, timeMs, 'stop (touched)')) this.afterEntryFill(before, o.bracket);
    }
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

  /** Close part of the position at market; protective legs shrink to what is left. Never blocked. */
  closePart(fraction: number, now = Date.now()): Result {
    const q = this.position.qty;
    if (q === 0) return refuse('flat — nothing to close');
    if (!this.hasBook) return refuse('no book yet');
    const f = 10 ** this.cfg.sizeDecimals;
    const part = Math.floor(Math.abs(q) * fraction * f + 1e-9) / f;
    if (!(part > 0) || part >= Math.abs(q)) return refuse(`${Math.abs(q)} is too small to split — use FLATTEN`);
    const fill = this.executeMarket(q > 0 ? 'sell' : 'buy', part, null, now, 'close part');
    if (!fill) return refuse('book too thin to fill');
    const left = Math.abs(this.position.qty);
    for (const o of this.orders) if (o.reduceOnly) o.qty = Math.min(o.qty, left);
    // Partial targets: drop the furthest ones until the targets fit what is left.
    let tpSum = this.orders.filter((o) => o.leg === 'tp').reduce((a, o) => a + o.qty, 0);
    const tps = this.orders.filter((o) => o.leg === 'tp').sort((a, b) => Math.abs(b.priceTicks - this.position.avgTicks) - Math.abs(a.priceTicks - this.position.avgTicks));
    for (const o of tps) {
      if (tpSum <= left + 1e-12) break;
      const cut = Math.min(o.qty, tpSum - left);
      o.qty = Math.round((o.qty - cut) * f) / f;
      tpSum -= cut;
    }
    this.orders = this.orders.filter((o) => !(o.leg === 'tp' && o.qty <= 0));
    return ok(`closed ${part} @ ${this.px(fill.priceTicks)}`);
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
      if (due.leg) this.onBracketLegFilled(due.leg);
      else this.afterEntryFill(before, due.bracket);
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

  /** An entry changed the position: re-arm brackets for the whole position at the new average,
   * from the bracket the entry was placed with (else the current one). */
  private afterEntryFill(before: number, placed?: BracketSettings): void {
    if (this.position.qty === before) return;
    const br = placed ?? this.bracket;
    this.dropProtectiveLegs();
    this.beDone = false;
    this.trailRisk = 0;
    this.trailBest = undefined;
    if (this.position.qty === 0 || !br.enabled) return;
    if (br.slTicks > 0) this.trailRisk = br.slTicks;
    const long = this.position.qty > 0;
    const qty = Math.abs(this.position.qty);
    const avg = this.position.avgTicks;
    const exit: Side = long ? 'sell' : 'buy';
    const on = (br.targets ?? []).filter((t) => t.ticks > 0);
    const split = on.length >= 2 ? splitTargets(qty, this.cfg.sizeDecimals, on) : undefined;
    // An unsplittable size falls back to the one TP1 leg (the ticket shows why in red).
    const tps = split?.ok ? split.legs : br.tpTicks > 0 ? [{ ticks: br.tpTicks, qty }] : [];
    for (const l of tps) {
      const tp = long ? Math.ceil(avg) + l.ticks : Math.floor(avg) - l.ticks;
      this.orders.push({ id: this.nextOrderId++, side: exit, type: 'limit', priceTicks: tp, qty: l.qty, reduceOnly: true, leg: 'tp' });
    }
    if (br.slTicks > 0) {
      const sl = long ? Math.floor(avg) - br.slTicks : Math.ceil(avg) + br.slTicks;
      this.orders.push({ id: this.nextOrderId++, side: exit, type: 'stop', priceTicks: sl, qty, reduceOnly: true, leg: 'sl' });
    }
  }

  /** One bracket leg filled: OCO the other, and resize survivors to what is left. A first TP fill
   * moves the stop to entry ± offset when B/E after TP1 is on. */
  private onBracketLegFilled(leg: 'tp' | 'sl'): void {
    if (this.position.qty === 0) {
      this.dropProtectiveLegs();
      return;
    }
    const left = Math.abs(this.position.qty);
    for (const o of this.orders) if (o.reduceOnly) o.qty = Math.min(o.qty, left);
    if (leg !== 'tp' || this.beDone || !this.bracket.beAfterTp1) return;
    this.beDone = true;
    const long = this.position.qty > 0;
    const avg = this.position.avgTicks;
    const off = this.bracket.beOffset ?? 0;
    const stop = long ? Math.floor(avg) + off : Math.ceil(avg) - off;
    const bid = bestBid(this.book!)!;
    const ask = bestAsk(this.book!)!;
    if (long ? stop >= bid : stop <= ask) return; // already through the market: keep the stop where it is
    const sl = this.orders.find((o) => o.leg === 'sl');
    if (sl) sl.priceTicks = stop;
    else this.orders.push({ id: this.nextOrderId++, side: long ? 'sell' : 'buy', type: 'stop', priceTicks: stop, qty: left, reduceOnly: true, leg: 'sl' });
  }

  /** Trailing stop: follow the best exit price at one risk behind. True if the stop moved. */
  private trailStep(): boolean {
    const q = this.position.qty;
    if (q === 0 || !this.hasBook) return false;
    const long = q > 0;
    const bid = bestBid(this.book!)!;
    const ask = bestAsk(this.book!)!;
    const px = long ? bid : ask;
    this.trailBest = this.trailBest === undefined ? px : long ? Math.max(this.trailBest, px) : Math.min(this.trailBest, px);
    // The trail menu applies to the open position as it is NOW, even if turned on after the entry.
    const line = this.bracket.trailLine;
    const startR = this.bracket.trailStartR ?? 0;
    if (!line && !(startR > 0)) return false;
    const sl = this.orders.find((o) => o.leg === 'sl');
    if (!sl) return false;
    if (!(this.trailRisk > 0)) this.trailRisk = Math.max(1, Math.round(Math.abs(this.position.avgTicks - sl.priceTicks)));
    const want = line
      ? lineTrailTarget(long, this.trendLines[line], sl.priceTicks)
      : trailTarget(long, this.position.avgTicks, this.trailRisk, this.trailBest, startR, sl.priceTicks);
    if (want === undefined || (long ? want >= bid : want <= ask)) return false;
    sl.priceTicks = want;
    return true;
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
