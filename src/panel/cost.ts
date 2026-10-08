// What an entry really costs, from the live book. Pure: no I/O.
//
// Vest's NQ book is one market maker's quote ladder (DESIGN.md §1), so most of a scalp's cost is
// the spread crossed, not depth. These numbers make that cost visible before the click:
//   - fill: walk the book for your size → average fill, slippage past the best price
//   - break-even: buy across the spread and sell back across it, plus both taker fees, in points
//   - spread gate: where today's spread sits in this market's own recent distribution

import type { BookSide } from '../book/book.js';

export interface Fill {
  /** Average fill price in ticks (fractional when the size spans levels). */
  avgTicks: number;
  /** Best level touched. */
  bestTicks: number;
  /** Worst level touched. */
  worstTicks: number;
  /** Ticks between the average fill and the best price (≥ 0). */
  slipTicks: number;
  /** Levels the size reaches into. */
  levels: number;
  /** False when the visible book is too thin for the whole size. */
  complete: boolean;
}

/** Walk one side of the book (best first) for `units`. Undefined for an empty side or no size. */
export function walkBook(side: BookSide, units: number): Fill | undefined {
  if (!(units > 0) || side.ticks.length === 0) return undefined;
  let left = units;
  let notional = 0;
  let levels = 0;
  let worst = side.ticks[0]!;
  for (let i = 0; i < side.ticks.length && left > 1e-12; i++) {
    const take = Math.min(left, side.sizes[i]!);
    if (take <= 0) continue;
    notional += take * side.ticks[i]!;
    left -= take;
    levels++;
    worst = side.ticks[i]!;
  }
  const filled = units - Math.max(0, left);
  if (filled <= 0) return undefined;
  const avg = notional / filled;
  const best = side.ticks[0]!;
  return { avgTicks: avg, bestTicks: best, worstTicks: worst, slipTicks: Math.abs(avg - best), levels, complete: left <= 1e-12 };
}

export interface RoundTrip {
  /** Entry fill. */
  entry: Fill;
  /** Exit fill if you closed at once on the other side. */
  exit: Fill;
  /** Spread + slippage both ways, in points. */
  crossPts: number;
  /** Both taker fees, in $. */
  feesUsd: number;
  /** All-in $ for the round trip. */
  totalUsd: number;
  /** Points price must move your way just to get back to zero. */
  breakEvenPts: number;
}

/**
 * Round trip for a `side` entry of `units`: enter by walking the far side, exit by walking the near
 * side, plus a taker fee each way. Perp P&L = units × points, so break-even pts = $ / units.
 */
export function roundTrip(bids: BookSide, asks: BookSide, side: 'buy' | 'sell', units: number, tick: number, takerFee: number): RoundTrip | undefined {
  const entry = walkBook(side === 'buy' ? asks : bids, units);
  const exit = walkBook(side === 'buy' ? bids : asks, units);
  if (!entry || !exit) return undefined;
  const crossPts = Math.abs(entry.avgTicks - exit.avgTicks) * tick;
  const px = entry.avgTicks * tick;
  const feesUsd = 2 * units * px * Math.max(0, takerFee);
  const totalUsd = crossPts * units + feesUsd;
  return { entry, exit, crossPts, feesUsd, totalUsd, breakEvenPts: totalUsd / units };
}

export type Gate = 'cheap' | 'normal' | 'wide';

/**
 * Spread gate against this market's own recent spreads (no fixed tick count): at or below the
 * median = cheap to cross, up to p90 = normal, above p90 = wide. Undefined until there is enough
 * history (`p50`/`p90` undefined).
 */
export function spreadGate(spread: number, p50: number | undefined, p90: number | undefined): Gate | undefined {
  if (p50 === undefined || p90 === undefined) return undefined;
  if (spread <= p50) return 'cheap';
  if (spread <= p90) return 'normal';
  return 'wide';
}

/** TP distance as a multiple of the all-in break-even move (undefined without both). */
export function edgeRatio(tpPts: number, breakEvenPts: number | undefined): number | undefined {
  return tpPts > 0 && breakEvenPts !== undefined && breakEvenPts > 0 ? tpPts / breakEvenPts : undefined;
}
