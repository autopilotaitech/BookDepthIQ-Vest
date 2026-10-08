// Footprint and liquidity marks for the ladder. Pure: no I/O.
//
// Rows are price buckets in ticks, `g` ticks apart (the ladder's grouping). "Bought" is volume
// that lifted the ask at that price, "sold" is volume that hit the bid.

export interface Imbalances {
  /** Rows where buyers dominate diagonally: bought here ≥ ratio × sold one row below. */
  buy: Set<number>;
  /** Rows where sellers dominate diagonally: sold here ≥ ratio × bought one row above. */
  sell: Set<number>;
  /** Rows inside a run of `stackMin`+ consecutive buy imbalances. */
  buyStack: Set<number>;
  sellStack: Set<number>;
}

/**
 * Diagonal imbalances, the footprint convention: a buyer lifting the ask at P is compared with a
 * seller hitting the bid one row lower (the bid that was across from that ask).
 * `minQty`: a row must trade at least this much to count, so a single tiny print against an empty
 * neighbour is not an "infinite" imbalance; the empty side is treated as `minQty`.
 */
export function imbalances(bought: Map<number, number>, sold: Map<number, number>, g: number, ratio = 3, minQty = 0, stackMin = 3): Imbalances {
  const buy = new Set<number>();
  const sell = new Set<number>();
  for (const [t, b] of bought) {
    if (b > 0 && b >= minQty && b >= ratio * Math.max(sold.get(t - g) ?? 0, minQty, 1e-12)) buy.add(t);
  }
  for (const [t, s] of sold) {
    if (s > 0 && s >= minQty && s >= ratio * Math.max(bought.get(t + g) ?? 0, minQty, 1e-12)) sell.add(t);
  }
  return { buy, sell, buyStack: runs(buy, g, stackMin), sellStack: runs(sell, g, stackMin) };
}

/** Members of runs of at least `min` consecutive rows (`g` apart). */
export function runs(rows: Set<number>, g: number, min: number): Set<number> {
  const out = new Set<number>();
  const sorted = [...rows].sort((a, b) => a - b);
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i]! - sorted[i - 1]! === g) continue;
    if (i - start >= min) for (let k = start; k < i; k++) out.add(sorted[k]!);
    start = i;
  }
  return out;
}

/** Levels resting at least `mult` × the average non-zero size on that side. */
export function walls(sizes: Map<number, number>, mult = 3): Set<number> {
  const vals = [...sizes.values()].filter((v) => v > 0);
  const out = new Set<number>();
  if (vals.length < 3) return out; // too few levels for "average" to mean anything
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  for (const [t, v] of sizes) if (v >= mult * avg) out.add(t);
  return out;
}

/** Share of visible resting size on the bid, 0–1 (undefined when the book is empty). */
export function bidShare(bids: Iterable<number>, asks: Iterable<number>): number | undefined {
  let b = 0;
  let a = 0;
  for (const v of bids) b += v;
  for (const v of asks) a += v;
  return b + a > 0 ? b / (b + a) : undefined;
}
