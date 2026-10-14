// Liquidity over time, per price: a heatmap of resting size (last 5 minutes in 10 s bins), and
// pull/stack — size that left the book WITHOUT trading (pulled) or arrived (stacked) — over the last
// minute. ABSORB marks a price that one side kept hitting — more than was showing there — while the
// level held and its size stayed (see absorb()). Pure: no I/O.
// Prices in ticks; sizes in units.

import type { Book } from '../book/book.js';

export const BIN_MS = 10_000;
export const BINS = 30; // 5 minutes
export const FLOW_WINDOW_MS = 60_000;
/** The heat windows the user can pick (minutes); clicking the heat column header steps through them. */
export const HEAT_WINDOWS = [5, 15, 30, 60];
export function nextHeatMin(cur: number): number {
  const i = HEAT_WINDOWS.indexOf(cur);
  return HEAT_WINDOWS[(i + 1) % HEAT_WINDOWS.length]!;
}
/** Outermost book levels per side left out of pull/stack (they flicker in and out of view). */
export const EDGE_LEVELS = 3;

interface Hit {
  at: number;
  price: number;
  qty: number;
  /** Aggressor side: 'sell' hits the bid, 'buy' lifts the offer. */
  side: 'buy' | 'sell';
  /** Resting size showing at that price just before the trade. */
  shown: number;
}

interface Flow {
  at: number;
  pull: number;
  stack: number;
  traded: number;
}

export class LiquidityTracker {
  /** One heat bin (window / 30) and the pull/stack + absorb window (a fifth of the heat window: 1 min at
   * the default 5 min, 12 min at 60 min). The heat window is the user's choice: 5, 15, 30 or 60 min. */
  readonly binMs: number;
  readonly flowMs: number;
  constructor(windowMs = BINS * BIN_MS) {
    const w = Math.max(BINS * 1000, windowMs);
    this.binMs = w / BINS;
    this.flowMs = w / 5;
  }

  /** Resting size per price at the latest book. */
  private cur = new Map<number, number>();
  /** Each finished 10 s bin: per price, the TIME-AVERAGED resting size over the bin, signed
   * (+ bid, − offer), oldest first. Averaging is what makes the picture steady: Vest's book flickers
   * several times a second, so a single snapshot per bin looked random. */
  private bins: Array<Map<number, number>> = [];
  private binStart: number | undefined;
  /** The latest book, signed (+ bid, − offer), and size × ms credited so far to the open bin. */
  private curSigned = new Map<number, number>();
  private acc = new Map<number, number>();
  private lastBookAt: number | undefined;
  /** Traded volume per price since the last book update. */
  private tradedSince = new Map<number, number>();
  /** Recent pull/stack/traded per price. */
  private flows = new Map<number, Flow[]>();
  private maxSize = 0;
  private edge: number[] = [];
  /** Every trade of the last minute (for absorption). */
  private hits: Hit[] = [];
  private now = 0;

  onTrade(priceTicks: number, qty: number, side?: 'buy' | 'sell', at?: number): void {
    this.tradedSince.set(priceTicks, (this.tradedSince.get(priceTicks) ?? 0) + qty);
    if (at !== undefined) this.now = Math.max(this.now, at);
    if (side) this.hits.push({ at: at ?? this.now, price: priceTicks, qty, side, shown: this.cur.get(priceTicks) ?? 0 });
  }

  onBook(book: Book, now: number): void {
    this.now = Math.max(this.now, now);
    const next = new Map<number, number>();
    book.bids.ticks.forEach((t, i) => next.set(t, book.bids.sizes[i]!));
    book.asks.ticks.forEach((t, i) => next.set(t, book.asks.sizes[i]!));
    // The first book after a start or reset is the baseline, not size that just arrived. Only prices
    // inside the range BOTH snapshots cover count: Vest sends the top levels only, so a level at the
    // edge drops in and out of view as the book moves — that is not size being pulled or added.
    const range = (m: Map<number, number>) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [p, v] of m) if (v > 0) (lo = Math.min(lo, p)), (hi = Math.max(hi, p));
      return { lo, hi };
    };
    const a = range(this.cur);
    const b = range(next);
    const lo = Math.max(a.lo, b.lo);
    const hi = Math.min(a.hi, b.hi);
    // The outermost levels flicker between neighbouring ticks on Vest's quoted book: skip them too.
    const edge = new Set([...book.bids.ticks.slice(-EDGE_LEVELS), ...book.asks.ticks.slice(-EDGE_LEVELS), ...this.edge]);
    const prices = this.cur.size ? [...new Set([...this.cur.keys(), ...next.keys()])].filter((p) => p >= lo && p <= hi && !edge.has(p)) : [];
    this.edge = [...book.bids.ticks.slice(-EDGE_LEVELS), ...book.asks.ticks.slice(-EDGE_LEVELS)];
    for (const p of prices) {
      const before = this.cur.get(p) ?? 0;
      const after = next.get(p) ?? 0;
      const traded = this.tradedSince.get(p) ?? 0;
      const drop = before - after;
      const pull = drop > 0 ? Math.max(0, drop - traded) : 0;
      const stack = after > before ? after - before : 0;
      if (pull > 0 || stack > 0 || traded > 0) {
        const arr = this.flows.get(p) ?? [];
        arr.push({ at: now, pull, stack, traded });
        this.flows.set(p, arr);
      }
    }
    this.tradedSince.clear();
    // Heat: credit the book that was showing (since the last update) to the open bin, time-weighted,
    // closing every bin that ended on the way.
    let binStart = this.binStart ?? now;
    let last = this.lastBookAt ?? now;
    if (now - binStart > (BINS + 1) * this.binMs) {
      // After a long quiet gap, only the last 5 minutes of bins matter.
      binStart = now - (BINS + 1) * this.binMs;
      last = Math.max(last, binStart);
    }
    const credit = (ms: number) => {
      if (ms <= 0) return;
      for (const [p, v] of this.curSigned) this.acc.set(p, (this.acc.get(p) ?? 0) + v * ms);
    };
    while (now - binStart >= this.binMs) {
      const end: number = binStart + this.binMs;
      credit(end - last);
      last = end;
      const avg = new Map<number, number>();
      for (const [p, v] of this.acc) if (v !== 0) avg.set(p, v / this.binMs);
      this.bins.push(avg);
      if (this.bins.length > BINS) this.bins.shift();
      this.acc.clear();
      binStart = end;
    }
    credit(now - last);
    this.binStart = binStart;
    this.lastBookAt = now;
    this.cur = next;
    this.curSigned = new Map<number, number>();
    book.bids.ticks.forEach((t, i) => this.curSigned.set(t, book.bids.sizes[i]!));
    book.asks.ticks.forEach((t, i) => this.curSigned.set(t, -book.asks.sizes[i]!));
    this.maxSize = 0;
    for (const b of this.bins) for (const v of b.values()) this.maxSize = Math.max(this.maxSize, v);
    for (const v of this.cur.values()) this.maxSize = Math.max(this.maxSize, v);
    if (prices.length) this.prune(now);
  }

  private prune(now: number): void {
    if (this.hits.length && now - this.hits[0]!.at > this.flowMs) this.hits = this.hits.filter((h) => now - h.at <= this.flowMs);
    for (const [p, arr] of this.flows) {
      const keep = arr.filter((f) => now - f.at <= this.flowMs);
      if (keep.length) this.flows.set(p, keep);
      else this.flows.delete(p);
    }
  }

  /** Resting size (units) on the row `price`..`price+group−1`: one time-averaged value per 10 s
   * bin, oldest first, then the book now. Signed: + bid, − offer (the side it was on THEN). */
  heat(price: number, group = 1): number[] {
    const at = (m: Map<number, number>) => {
      let s = 0;
      for (let k = 0; k < group; k++) s += m.get(price + k) ?? 0;
      return s;
    };
    return [...this.bins.map(at), at(this.curSigned)];
  }

  /**
   * Absorption at the row `price`..`price+group−1` over the last minute: 'bid' when sellers kept
   * hitting it and buyers soaked it up, 'ask' the other way round. All of:
   *  1. one side's aggressive volume there ≥ `absorbMin` and ≥ 2× the other side's;
   *  2. that volume ≥ 1.5× the size that was SHOWING when the hitting began (hidden or refilled size);
   *  3. the level held: no trade through it since (below a bid, above an offer);
   *  4. at least half of that size still rests there now.
   * The market maker's re-quoting (which moves size in and out constantly) plays no part.
   */
  absorb(price: number, group = 1, absorbMin = 5): 'bid' | 'ask' | undefined {
    const top = price + group - 1;
    const recent = this.hits.filter((h) => this.now - h.at <= this.flowMs);
    const here = recent.filter((h) => h.price >= price && h.price <= top);
    if (!here.length) return undefined;
    const sells = here.filter((h) => h.side === 'sell').reduce((a, h) => a + h.qty, 0);
    const buys = here.filter((h) => h.side === 'buy').reduce((a, h) => a + h.qty, 0);
    const side = sells >= absorbMin && sells >= 2 * buys ? 'bid' : buys >= absorbMin && buys >= 2 * sells ? 'ask' : undefined;
    if (!side) return undefined;
    const hitSide = side === 'bid' ? 'sell' : 'buy';
    const first = here.find((h) => h.side === hitSide)!;
    const traded = side === 'bid' ? sells : buys;
    let shown = 0;
    for (let p = price; p <= top; p++) shown = Math.max(shown, here.find((h) => h.side === hitSide && h.price === p)?.shown ?? 0);
    if (traded < 1.5 * shown) return undefined;
    if (recent.some((h) => h.at >= first.at && (side === 'bid' ? h.price < price : h.price > top))) return undefined;
    let rest = 0;
    for (let p = price; p <= top; p++) rest += this.cur.get(p) ?? 0;
    if (rest <= 0 || rest < 0.5 * shown) return undefined;
    return side;
  }

  /** Over the last minute at `price` (a row of `group` ticks): units stacked − pulled, traded, and
   * absorption (see absorb()). `signal` is false when the net is under 20% of the churn: on Vest's quoted book the market maker
   * re-quotes its ladder a tick or two over several times a second, which moves size in and out of
   * every price without anyone pulling or adding. */
  flow(price: number, group = 1, absorbMin = 5): { net: number; pulled: number; stacked: number; traded: number; absorb: 'bid' | 'ask' | undefined; signal: boolean } {
    let pulled = 0;
    let stacked = 0;
    let traded = 0;
    for (let k = 0; k < group; k++)
      for (const f of this.flows.get(price + k) ?? []) {
        pulled += f.pull;
        stacked += f.stack;
        traded += f.traded;
      }
    const net = stacked - pulled;
    return { net, pulled, stacked, traded, absorb: this.absorb(price, group, absorbMin), signal: Math.abs(net) > 0 && Math.abs(net) >= 0.2 * (pulled + stacked) };
  }

  reset(): void {
    this.cur.clear();
    this.bins = [];
    this.binStart = undefined;
    this.lastBookAt = undefined;
    this.curSigned.clear();
    this.acc.clear();
    this.edge = [];
    this.tradedSince.clear();
    this.flows.clear();
    this.hits = [];
    this.now = 0;
    this.maxSize = 0;
  }
}
