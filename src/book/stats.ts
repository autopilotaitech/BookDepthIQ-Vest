// Small pure helpers for the probe. Thresholds are measured before they are chosen (the BookDepthIQ
// rule, §4A): the probe prints DISTRIBUTIONS so a number is never picked by eye.

export function quantile(sorted: number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export interface Dist {
  n: number;
  min?: number;
  p10?: number;
  p50?: number;
  p90?: number;
  p99?: number;
  max?: number;
}

export function dist(values: number[]): Dist {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p10: quantile(s, 0.1),
    p50: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    p99: quantile(s, 0.99),
    max: s[s.length - 1],
  };
}

/**
 * How "machine-made" a set of resting sizes looks: the share of sizes that are a whole multiple
 * of the smallest one (within `tol`, relative). Organic books sit near 0; a single market maker's
 * quote ladder (sizes like 1.6, 3.2, 4.8, 6.4 ...) sits near 1.
 */
export function ladderScore(sizes: number[], tol = 0.002): { base?: number; score: number } {
  const pos = sizes.filter((s) => Number.isFinite(s) && s > 0);
  if (pos.length < 2) return { score: 0 };
  // Candidate base units are the smallest size divided by 1..4 (NQ's real ladder is 2x a
  // 1.6045 unit). Smaller divisors are not tried: with a tiny enough base every size is "a
  // multiple" and the score means nothing. A single stray size (one real order resting inside
  // the ladder) must lower the score, not redefine the unit — which is why the base is never
  // taken from a gap between two sizes.
  const smallest = Math.min(...pos);
  let best = { base: smallest, score: 0 };
  for (let d = 1; d <= 4; d++) {
    const base = smallest / d;
    const hits = pos.filter((s) => {
      const k = Math.round(s / base);
      return k >= 1 && Math.abs(s - k * base) <= base * k * tol;
    }).length;
    const score = hits / pos.length;
    if (score > best.score + 1e-9) best = { base, score };
  }
  return best;
}
