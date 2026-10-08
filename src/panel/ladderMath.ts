// Pure maths behind the ladder's risk columns and signals. No DOM, no I/O.

/** $ P&L of a position of `qty` (signed units) at `avgTicks` if exited at `rowTicks`. */
export function rowPnlUsd(qty: number, avgTicks: number, rowTicks: number, tickSize: number): number {
  return (rowTicks - avgTicks) * qty * tickSize;
}

export interface RoundTripCost {
  spreadUsd: number;
  feesUsd: number;
  totalUsd: number;
}

/** What a market-in / market-out round trip costs right now: the spread plus two taker fees. */
export function roundTripCost(units: number, spreadTicks: number, tickSize: number, price: number, takerFee: number): RoundTripCost {
  const spreadUsd = Math.abs(units) * spreadTicks * tickSize;
  const feesUsd = 2 * Math.abs(units) * price * takerFee;
  return { spreadUsd, feesUsd, totalUsd: spreadUsd + feesUsd };
}

export interface Bracket {
  tpTicks?: number; // absolute price in ticks
  slTicks?: number;
  tpUsd?: number;
  slUsd?: number;
}

/** Where a bracket would land for an entry at `entryTicks`, and what each leg pays. */
export function bracketPreview(
  side: 'buy' | 'sell',
  entryTicks: number,
  units: number,
  tp: number,
  sl: number,
  tickSize: number,
): Bracket {
  const dir = side === 'buy' ? 1 : -1;
  const out: Bracket = {};
  if (tp > 0) {
    out.tpTicks = entryTicks + dir * tp;
    out.tpUsd = units * tp * tickSize;
  }
  if (sl > 0) {
    out.slTicks = entryTicks - dir * sl;
    out.slUsd = -units * sl * tickSize;
  }
  return out;
}

/**
 * Rolling window of spread samples that answers "is the spread wide FOR THIS MARKET RIGHT NOW",
 * by comparing against its own recent distribution instead of a hard-coded tick count.
 */
export class SpreadWindow {
  private samples: Array<[number, number]> = [];
  constructor(private readonly windowMs = 5 * 60_000) {}

  push(spreadTicks: number, now: number): void {
    this.samples.push([now, spreadTicks]);
    const cut = now - this.windowMs;
    while (this.samples.length && this.samples[0]![0] < cut) this.samples.shift();
  }

  get size(): number {
    return this.samples.length;
  }

  /** q-quantile of the window, or undefined with too little history to judge. */
  quantile(q: number, minSamples = 60): number | undefined {
    if (this.samples.length < minSamples) return undefined;
    const s = this.samples.map((x) => x[1]).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }

  /** True when `spread` is wider than this market's own recent p90. */
  isWide(spread: number): boolean {
    const p90 = this.quantile(0.9);
    return p90 !== undefined && spread > p90;
  }
}

/**
 * Slow EMA of the (Vest mid − index) gap, so `index + basis` is where the index says Vest's mid
 * "should" be. The gap drifts (carry, Vest's ±25 bps band), so it is tracked, never a constant.
 */
export class BasisTracker {
  private basis: number | undefined;
  private lastT = 0;
  constructor(private readonly halfLifeMs = 60_000) {}

  update(midTicks: number, indexTicks: number, now: number): void {
    const gap = midTicks - indexTicks;
    if (this.basis === undefined) {
      this.basis = gap;
    } else {
      const dt = Math.max(0, now - this.lastT);
      const a = 1 - Math.pow(0.5, dt / this.halfLifeMs);
      this.basis += a * (gap - this.basis);
    }
    this.lastT = now;
  }

  /** Index-implied Vest mid, in ticks; undefined until the first sample. */
  implied(indexTicks: number): number | undefined {
    return this.basis === undefined ? undefined : indexTicks + this.basis;
  }
}

export interface Offscreen {
  label: string;
  ticks: number;
  above: boolean;
  distance: number; // rows away from the visible edge
}

/** Markers (TP, SL, fail, orders) that fall outside [lo, hi] — pinned to the ladder edges. */
export function offscreen(markers: Array<{ label: string; ticks: number }>, lo: number, hi: number): Offscreen[] {
  return markers
    .filter((m) => m.ticks > hi || m.ticks < lo)
    .map((m) => ({ ...m, above: m.ticks > hi, distance: m.ticks > hi ? m.ticks - hi : lo - m.ticks }));
}

/** Ticks per ladder row. 1 = every tick; larger steps show a wider range on one screen. */
export const GROUP_STEPS = [1, 2, 4, 8, 20, 40, 100] as const;

/** Next finer (dir −1) or coarser (+1) group step, clamped to the list. */
export function stepGroup(current: number, dir: 1 | -1): number {
  const i = GROUP_STEPS.indexOf(current as (typeof GROUP_STEPS)[number]);
  const at = i < 0 ? 0 : i;
  return GROUP_STEPS[Math.min(GROUP_STEPS.length - 1, Math.max(0, at + dir))]!;
}

/** Row a tick belongs to: the bucket's lowest tick. Floor, so negatives bucket consistently. */
export function bucketOf(ticks: number, group: number): number {
  return Math.floor(ticks / group) * group;
}

/** Sums sizes into `group`-tick buckets keyed by bucket floor. group 1 is the identity. */
export function aggregate(ticks: number[], sizes: number[], group: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < ticks.length; i++) {
    const b = bucketOf(ticks[i]!, group);
    out.set(b, (out.get(b) ?? 0) + sizes[i]!);
  }
  return out;
}
