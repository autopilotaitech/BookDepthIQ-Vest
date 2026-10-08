import type { DepthMsg, Level } from '../vest/types.js';

// Vest's @depth stream sends a FULL top-of-book snapshot every message (no diffs, no order ids),
// so the book is simply replaced on each message. Prices are kept as integer TICKS so equality
// and spread maths never touch floating point.

export interface BookSide {
  /** Best first: bids descending, asks ascending. */
  ticks: number[];
  sizes: number[];
}

export interface Book {
  bids: BookSide;
  asks: BookSide;
  tsMs: number;
}

function side(levels: Level[], tick: number, descending: boolean): BookSide {
  const rows = levels
    .map(([p, q]) => [Math.round(Number(p) / tick), Number(q)] as const)
    .filter(([t, q]) => Number.isFinite(t) && Number.isFinite(q) && q > 0);
  rows.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return { ticks: rows.map((r) => r[0]), sizes: rows.map((r) => r[1]) };
}

export function bookFromDepth(msg: DepthMsg, tick: number, nowMs = Date.now()): Book {
  return {
    bids: side(msg.data.bids, tick, true),
    asks: side(msg.data.asks, tick, false),
    tsMs: msg.tsMs ?? nowMs,
  };
}

export function bestBid(b: Book): number | undefined {
  return b.bids.ticks[0];
}

export function bestAsk(b: Book): number | undefined {
  return b.asks.ticks[0];
}

/** Spread in ticks; undefined when either side is empty. Negative means a crossed book. */
export function spreadTicks(b: Book): number | undefined {
  const bid = bestBid(b);
  const ask = bestAsk(b);
  return bid === undefined || ask === undefined ? undefined : ask - bid;
}

export function midTicks(b: Book): number | undefined {
  const bid = bestBid(b);
  const ask = bestAsk(b);
  return bid === undefined || ask === undefined ? undefined : (bid + ask) / 2;
}
