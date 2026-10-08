// Pure helpers for the lead-lag probe.

/** Last value carried forward onto a fixed grid [t0, t1] every `step` ms. */
export function resample(series: Array<[number, number]>, t0: number, t1: number, step: number): number[] {
  const out: number[] = [];
  let j = 0;
  let last = series[0]?.[1] ?? NaN;
  for (let t = t0; t <= t1; t += step) {
    while (j < series.length && series[j]![0] <= t) last = series[j++]![1];
    out.push(last);
  }
  return out;
}

function diffs(x: number[]): number[] {
  return x.slice(1).map((v, i) => v - x[i]!);
}

/**
 * Pearson correlation of a's changes at time t with b's changes at t+lag, for lag in
 * [-maxLag, maxLag] grid steps. A peak at a positive lag means a leads b.
 */
export function crossCorrelation(a: number[], b: number[], maxLag: number): Array<{ lag: number; r: number }> {
  const da = diffs(a);
  const db = diffs(b);
  const out: Array<{ lag: number; r: number }> = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < da.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= db.length) continue;
      if (!Number.isFinite(da[i]!) || !Number.isFinite(db[j]!)) continue;
      xs.push(da[i]!);
      ys.push(db[j]!);
    }
    out.push({ lag, r: pearson(xs, ys) });
  }
  return out;
}

export function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Every time `lead` moves ≥ `moveTicks` within `windowSteps`, measure how many steps until
 * `follow` has moved ≥ moveTicks/2 the same way from where it was at the event, giving up after
 * `horizonSteps`. Events closer than the window to the previous one are skipped (no overlap).
 */
export function eventStudy(
  lead: number[],
  follow: number[],
  stepMs: number,
  moveTicks: number,
  windowSteps: number,
  horizonSteps: number,
): { events: number; followed: number; against: number; none: number; delaysMs: number[] } {
  let events = 0;
  let followed = 0;
  let against = 0;
  let none = 0;
  const delaysMs: number[] = [];
  let skipUntil = -1;
  for (let i = windowSteps; i < lead.length; i++) {
    if (i < skipUntil) continue;
    const move = lead[i]! - lead[i - windowSteps]!;
    if (!Number.isFinite(move) || Math.abs(move) < moveTicks) continue;
    events++;
    skipUntil = i + windowSteps;
    const dir = Math.sign(move);
    const base = follow[i]!;
    const need = moveTicks / 2;
    let outcome: 'f' | 'a' | 'n' = 'n';
    for (let k = 0; k <= horizonSteps && i + k < follow.length; k++) {
      const d = (follow[i + k]! - base) * dir;
      if (d >= need) {
        outcome = 'f';
        delaysMs.push(k * stepMs);
        break;
      }
      if (d <= -need) {
        outcome = 'a';
        break;
      }
    }
    if (outcome === 'f') followed++;
    else if (outcome === 'a') against++;
    else none++;
  }
  return { events, followed, against, none, delaysMs };
}
