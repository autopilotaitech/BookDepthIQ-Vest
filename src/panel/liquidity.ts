// Absorption per price: a level one side kept hitting — more than was showing there — that held and
// still has size (see absorb()). Pure: no I/O. Prices in ticks; sizes in units.
//
// v1.8 also drew a 5-minute heatmap and pull/stack here. Both were removed (v1.8.3): on Vest's book,
// one market maker re-quotes its whole ladder a tick or two over several times a second, so resting
// size history and pulled/added size are mostly that re-quoting, not other traders.

import type { Book } from '../book/book.js';

export const WINDOW_MS = 60_000;

interface Hit {
  at: number;
  price: number;
  qty: number;
  /** Aggressor side: 'sell' hits the bid, 'buy' lifts the offer. */
  side: 'buy' | 'sell';
  /** Resting size showing at that price just before the trade. */
  shown: number;
}

export class LiquidityTracker {
  /** Resting size per price at the latest book. */
  private cur = new Map<number, number>();
  /** Every trade of the last minute. */
  private hits: Hit[] = [];
  private now = 0;

  onTrade(priceTicks: number, qty: number, side?: 'buy' | 'sell', at?: number): void {
    if (at !== undefined) this.now = Math.max(this.now, at);
    if (side) this.hits.push({ at: at ?? this.now, price: priceTicks, qty, side, shown: this.cur.get(priceTicks) ?? 0 });
  }

  onBook(book: Book, now: number): void {
    this.now = Math.max(this.now, now);
    const next = new Map<number, number>();
    book.bids.ticks.forEach((t, i) => next.set(t, book.bids.sizes[i]!));
    book.asks.ticks.forEach((t, i) => next.set(t, book.asks.sizes[i]!));
    this.cur = next;
    if (this.hits.length && this.now - this.hits[0]!.at > WINDOW_MS) this.hits = this.hits.filter((h) => this.now - h.at <= WINDOW_MS);
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
    const recent = this.hits.filter((h) => this.now - h.at <= WINDOW_MS);
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

  reset(): void {
    this.cur.clear();
    this.hits = [];
    this.now = 0;
  }
}
