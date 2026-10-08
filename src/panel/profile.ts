// Session volume profile and delta for the ladder. Pure: no I/O.
//
// Same idea as BookDepthIQ's ladder (concept only, written fresh here): per-price volume with the
// POC (most-traded price) and a value area holding `vaFraction` of all volume, grown outward from
// the POC one row at a time toward the heavier neighbour; and per-price signed delta
// (aggressive buys − aggressive sells).

export interface Profile {
  /** Row (ticks) with the most volume; undefined when nothing traded. */
  poc: number | undefined;
  /** Value-area high / low rows (inclusive). */
  vah: number | undefined;
  val: number | undefined;
  maxVol: number;
  maxAbsDelta: number;
  totalVol: number;
}

export const EMPTY_PROFILE: Profile = { poc: undefined, vah: undefined, val: undefined, maxVol: 0, maxAbsDelta: 0, totalVol: 0 };

/**
 * `vol` and `delta` are keyed by row (ticks, already grouped). Rows are treated as contiguous in
 * key order; empty rows between traded prices simply add nothing to the value area.
 */
export function buildProfile(vol: Map<number, number>, delta: Map<number, number>, vaFraction = 0.7): Profile {
  const rows = [...vol.entries()].filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  let maxAbsDelta = 0;
  for (const d of delta.values()) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(d));
  if (rows.length === 0) return { ...EMPTY_PROFILE, maxAbsDelta };

  let pocI = 0;
  let totalVol = 0;
  for (let i = 0; i < rows.length; i++) {
    totalVol += rows[i]![1];
    if (rows[i]![1] > rows[pocI]![1]) pocI = i;
  }
  const target = totalVol * Math.min(1, Math.max(0, vaFraction));
  let lo = pocI;
  let hi = pocI;
  let area = rows[pocI]![1];
  while (area < target - 1e-12 && (lo > 0 || hi < rows.length - 1)) {
    const down = lo > 0 ? rows[lo - 1]![1] : -1;
    const up = hi < rows.length - 1 ? rows[hi + 1]![1] : -1;
    if (down >= up) area += rows[--lo]![1];
    else area += rows[++hi]![1];
  }
  return { poc: rows[pocI]![0], vah: rows[hi]![0], val: rows[lo]![0], maxVol: rows[pocI]![1], maxAbsDelta, totalVol };
}

/** Signed size for delta: + for an aggressive buy, − for an aggressive sell. */
export function signedQty(side: 'buy' | 'sell', qty: number): number {
  return side === 'buy' ? qty : -qty;
}
