// Per-instrument indicator settings and the stacked-imbalance zone helper. Pure: no I/O.

export interface IndicatorCfg {
  // VWAP
  vwapOn: boolean;
  /** Session start / stop, "HH:MM" in `vwapTz`. */
  vwapStart: string;
  vwapEnd: string;
  vwapTz: string;
  /** Band multipliers in σ; empty = no bands. */
  vwapBands: number[];
  // Footprint imbalances
  fpOn: boolean;
  /** Lights a Sold/Bought cell at this diagonal ratio (3 = 3:1). */
  fpRatio: number;
  /** A row must trade at least this % of the busiest row to count. */
  fpMinPct: number;
  /** Consecutive imbalances that make a stacked zone. */
  fpStack: number;
  /** Draw stacked zones as lines across the ladder. */
  fpLines: boolean;
  // Big trades
  bigOn: boolean;
  /** A print this size or more (units) is "big" and is highlighted on the tape. */
  bigMin: number;
  // RTH opening range (BookDepthIQ PAXOR) — NQ and ES only
  orOn: boolean;
  orMid: boolean;
}

export const DEFAULT_INDICATORS: IndicatorCfg = {
  vwapOn: true,
  vwapStart: '09:30',
  vwapEnd: '16:00',
  vwapTz: 'America/New_York',
  vwapBands: [1, 2],
  fpOn: true,
  fpRatio: 3,
  fpMinPct: 5,
  fpStack: 3,
  fpLines: true,
  bigOn: true,
  // Measured 2026-10-09 on 6,000 Vest NQ prints: median 3.25u, p99 ≈ 7.75u (most prints are
  // multiples of the market maker's 1.6045 quote). 8u ≈ the top 1%. Tune per instrument.
  bigMin: 8,
  orOn: true,
  orMid: false,
};

/** Settings for `symbol`: its saved overrides on top of the defaults. */
export function indicatorsFor(all: Record<string, Partial<IndicatorCfg>> | undefined, symbol: string | undefined): IndicatorCfg {
  return { ...DEFAULT_INDICATORS, ...((symbol && all?.[symbol]) || {}) };
}

/** "1, 2" → [1, 2] (positive numbers only, at most 3). */
export function parseBands(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 3);
}

/**
 * Stacked-imbalance zones as lines: for each run of consecutive buy imbalances, a support line at
 * the run's lowest row; for each sell run, a resistance line at its highest row.
 */
export function stackZones(buyStack: Set<number>, sellStack: Set<number>, g: number): Array<{ ticks: number; side: 'buy' | 'sell'; rows: number }> {
  const zones: Array<{ ticks: number; side: 'buy' | 'sell'; rows: number }> = [];
  const walk = (set: Set<number>, side: 'buy' | 'sell') => {
    const rows = [...set].sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && rows[i]! - rows[i - 1]! === g) continue;
      if (i > start) zones.push({ ticks: side === 'buy' ? rows[start]! : rows[i - 1]!, side, rows: i - start });
      start = i;
    }
  };
  walk(buyStack, 'buy');
  walk(sellStack, 'sell');
  return zones;
}
