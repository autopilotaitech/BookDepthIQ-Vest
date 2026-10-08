import { describe, expect, it } from 'vitest';
import type { Book } from '../src/book/book.js';
import { PaperBroker, formatPrice, tickDecimals } from '../src/sim/paper.js';

const CFG = { tickSize: 0.25, sizeDecimals: 4, takerFee: 0, makerFee: 0 };

/** A book with `depth` levels a side, `size` each, best bid `bid`, best ask `ask` (ticks). */
function book(bid: number, ask: number, size = 5, depth = 10): Book {
  return {
    bids: { ticks: Array.from({ length: depth }, (_, i) => bid - i), sizes: Array(depth).fill(size) },
    asks: { ticks: Array.from({ length: depth }, (_, i) => ask + i), sizes: Array(depth).fill(size) },
    tsMs: 0,
  };
}

function broker(bid = 100, ask = 102, brackets = { enabled: false, tpTicks: 0, slTicks: 0 }) {
  const b = new PaperBroker(CFG);
  b.bracket = brackets;
  b.onBook(book(bid, ask));
  return b;
}

describe('market orders', () => {
  it('buys at the ask and sells at the bid', () => {
    const b = broker();
    expect(b.marketOrder('buy', 2).ok).toBe(true);
    expect(b.position).toEqual({ qty: 2, avgTicks: 102 });
    b.marketOrder('sell', 2);
    expect(b.position.qty).toBe(0);
    // bought 102, sold 100: -2 ticks * 2 units * $0.25/tick-unit = -$1
    expect(b.realizedUsd).toBeCloseTo(-1);
  });

  it('walks the book for size beyond the top level (VWAP, never better than touch)', () => {
    const b = broker();
    b.marketOrder('buy', 7); // 5 @102 + 2 @103
    expect(b.position.avgTicks).toBeCloseTo((5 * 102 + 2 * 103) / 7);
  });

  it('refuses when the whole book cannot fill it', () => {
    const b = broker();
    expect(b.marketOrder('buy', 1000).ok).toBe(false);
    expect(b.position.qty).toBe(0);
  });

  it('refuses before any book arrives', () => {
    expect(new PaperBroker(CFG).marketOrder('buy', 1).ok).toBe(false);
  });
});

describe('limit and stop orders', () => {
  it('a resting buy limit fills at its own price once the ask reaches it', () => {
    const b = broker();
    b.limitOrder('buy', 1, 98);
    expect(b.position.qty).toBe(0);
    b.onBook(book(96, 97)); // ask went through 98 — still fills at 98, no price improvement
    expect(b.position).toEqual({ qty: 1, avgTicks: 98 });
    expect(b.fills[0]!.liquidity).toBe('maker');
  });

  it('refuses a stop that is already through the market', () => {
    const b = broker();
    expect(b.stopOrder('sell', 1, 101).ok).toBe(false);
    expect(b.stopOrder('buy', 1, 101).ok).toBe(false);
    expect(b.stopOrder('sell', 1, 99).ok).toBe(true);
  });

  it('a sell stop triggers on the bid and fills as a market order', () => {
    const b = broker();
    b.stopOrder('sell', 1, 95);
    b.onBook(book(95, 97));
    expect(b.position.qty).toBe(-1);
    expect(b.position.avgTicks).toBe(95);
  });

  it('modify refuses to drag a stop through the market', () => {
    const b = broker();
    b.stopOrder('sell', 1, 95);
    const id = b.orders[0]!.id;
    expect(b.modify(id, 100).ok).toBe(false);
    expect(b.modify(id, 97).ok).toBe(true);
    expect(b.orders[0]!.priceTicks).toBe(97);
  });
});

describe('brackets', () => {
  const BR = { enabled: true, tpTicks: 8, slTicks: 4 };

  it('arms TP and SL from the user numbers on entry', () => {
    const b = broker(100, 102, BR);
    b.marketOrder('buy', 2);
    const tp = b.orders.find((o) => o.leg === 'tp')!;
    const sl = b.orders.find((o) => o.leg === 'sl')!;
    expect(tp).toMatchObject({ side: 'sell', type: 'limit', priceTicks: 110, qty: 2, reduceOnly: true });
    expect(sl).toMatchObject({ side: 'sell', type: 'stop', priceTicks: 98, qty: 2, reduceOnly: true });
  });

  it('TP fill cancels the SL (OCO) and leaves nothing working', () => {
    const b = broker(100, 102, BR);
    b.marketOrder('buy', 2);
    b.onBook(book(110, 111));
    expect(b.position.qty).toBe(0);
    expect(b.orders).toEqual([]);
    expect(b.realizedUsd).toBeCloseTo(8 * 2 * 0.25);
  });

  it('SL fill cancels the TP', () => {
    const b = broker(100, 102, BR);
    b.marketOrder('sell', 1); // short @100, TP 92, SL 104
    b.onBook(book(103, 104));
    expect(b.position.qty).toBe(0);
    expect(b.orders).toEqual([]);
  });

  it('no naked leg survives a manual exit (the BookDepthIQ BUG-1 rule)', () => {
    const b = broker(100, 102, BR);
    b.marketOrder('buy', 2);
    b.marketOrder('sell', 2);
    expect(b.position.qty).toBe(0);
    expect(b.orders).toEqual([]);
  });

  it('adding to a position re-arms both legs for the full size at the new average', () => {
    const b = broker(100, 102, BR);
    b.marketOrder('buy', 1); // @102
    b.onBook(book(102, 104));
    b.marketOrder('buy', 1); // @104 → avg 103
    const legs = b.orders.filter((o) => o.reduceOnly);
    expect(legs).toHaveLength(2);
    expect(legs.every((o) => o.qty === 2)).toBe(true);
    expect(legs.find((o) => o.leg === 'tp')!.priceTicks).toBe(111);
    expect(legs.find((o) => o.leg === 'sl')!.priceTicks).toBe(99);
  });

  it('brackets off places nothing', () => {
    const b = broker();
    b.marketOrder('buy', 1);
    expect(b.orders).toEqual([]);
  });
});

describe('flatten, reverse, break-even', () => {
  it('flatten cancels everything and closes the position', () => {
    const b = broker(100, 102, { enabled: true, tpTicks: 8, slTicks: 4 });
    b.marketOrder('buy', 3);
    b.limitOrder('buy', 1, 90);
    const r = b.flatten();
    expect(r.ok).toBe(true);
    expect(b.position.qty).toBe(0);
    expect(b.orders).toEqual([]);
  });

  it('flatten when already flat still cancels and reports it', () => {
    const b = broker();
    b.limitOrder('buy', 1, 90);
    expect(b.flatten().message).toContain('1 order(s)');
    expect(b.orders).toEqual([]);
  });

  it('reverse flips the position', () => {
    const b = broker();
    b.marketOrder('buy', 2);
    b.reverse();
    expect(b.position.qty).toBe(-2);
    expect(b.position.avgTicks).toBe(100);
  });

  it('B/E is refused until price has run past entry + offset', () => {
    const b = broker(100, 102, { enabled: true, tpTicks: 20, slTicks: 4 });
    b.marketOrder('buy', 1); // @102, SL 98
    expect(b.breakeven(2).ok).toBe(false); // stop 104 is above the 100 bid
    b.onBook(book(106, 107));
    expect(b.breakeven(2).ok).toBe(true);
    expect(b.orders.find((o) => o.leg === 'sl')!.priceTicks).toBe(104);
  });

  it('B/E creates a protective stop when brackets were off', () => {
    const b = broker();
    b.marketOrder('buy', 1); // @102
    b.onBook(book(106, 107));
    expect(b.breakeven(0).ok).toBe(true);
    expect(b.orders).toEqual([expect.objectContaining({ leg: 'sl', priceTicks: 102, reduceOnly: true })]);
  });
});

describe('accounting', () => {
  it('unrealized marks at the exit side, not the mid', () => {
    const b = broker();
    b.marketOrder('buy', 4); // @102
    b.onBook(book(104, 106));
    expect(b.unrealizedUsd()).toBeCloseTo((104 - 102) * 4 * 0.25);
  });

  it('charges taker on market fills and maker on limit fills', () => {
    const b = new PaperBroker({ ...CFG, takerFee: 0.001, makerFee: 0 });
    b.bracket = { enabled: false, tpTicks: 0, slTicks: 0 };
    b.onBook(book(400, 402));
    b.marketOrder('buy', 1); // notional 402 * 0.25 = 100.5
    expect(b.feesUsd).toBeCloseTo(0.1005);
    b.limitOrder('sell', 1, 401);
    b.onBook(book(401, 403));
    expect(b.feesUsd).toBeCloseTo(0.1005);
  });

  it('formats prices to the tick size', () => {
    expect(tickDecimals(0.25)).toBe(2);
    expect(tickDecimals(0.03125)).toBe(5);
    expect(tickDecimals(1)).toBe(0);
    expect(formatPrice(125915, 0.25)).toBe('31478.75');
  });
});
