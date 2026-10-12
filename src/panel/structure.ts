// Price structure for the ticket and the ladder: one-minute highs/lows (swing stops, the range),
// and whether the market is trending, chopping or stretched. Pure: no I/O. Prices in ticks.

export interface Bar {
  hi: number;
  lo: number;
  close: number;
}

/** One-minute bars from the trade feed, the last `keepMin` minutes. Trades must arrive in time order. */
export class MinuteBars {
  private bars = new Map<number, Bar>();

  constructor(private readonly keepMin = 240) {}

  add(timeMs: number, priceTicks: number): void {
    const m = Math.floor(timeMs / 60_000);
    const b = this.bars.get(m);
    if (b) {
      b.hi = Math.max(b.hi, priceTicks);
      b.lo = Math.min(b.lo, priceTicks);
      b.close = priceTicks;
    } else {
      this.bars.set(m, { hi: priceTicks, lo: priceTicks, close: priceTicks });
      for (const k of this.bars.keys()) if (k < m - this.keepMin) this.bars.delete(k);
    }
  }

  clear(): void {
    this.bars.clear();
  }

  /** High and low over the last `minutes` minutes up to `nowMs` (this minute included). */
  range(minutes: number, nowMs: number): { hi: number; lo: number } | undefined {
    const now = Math.floor(nowMs / 60_000);
    let hi = -Infinity;
    let lo = Infinity;
    for (const [k, b] of this.bars) {
      if (k <= now - minutes || k > now) continue;
      hi = Math.max(hi, b.hi);
      lo = Math.min(lo, b.lo);
    }
    return Number.isFinite(hi) ? { hi, lo } : undefined;
  }
}

/**
 * Swing stop distance in ticks from `refTicks`: a long's stop goes `bufTicks` under the swing low,
 * a short's over the swing high. At least one tick. Undefined without a range.
 */
export function swingStopTicks(long: boolean, refTicks: number, range: { hi: number; lo: number } | undefined, bufTicks: number): number | undefined {
  if (!range) return undefined;
  const level = long ? range.lo - bufTicks : range.hi + bufTicks;
  return Math.max(1, Math.round((refTicks - level) * (long ? 1 : -1)));
}

export type MarketState = 'trend-up' | 'trend-down' | 'chop' | 'warming';

export interface StateInput {
  st1: 'up' | 'down' | 'neutral';
  st2: 'up' | 'down' | 'neutral';
  /** SuperTrend flips (either line) in the last 15 minutes. */
  flips15: number;
  price: number | undefined;
  vwap: number | undefined;
  /** VWAP σ in ticks. */
  vwapSigma: number | undefined;
  st1Line: number | undefined;
  atrTicks: number | undefined;
}

export interface StateView {
  state: MarketState;
  /** Price stretched far from VWAP or ST1: don't chase it. */
  extended?: 'up' | 'down';
  why: string;
}

/**
 * TREND when both SuperTrends agree and haven't been flipping; CHOP when they disagree or have
 * flipped 3+ times in 15 min (trade the range edges, not breakouts). EXTENDED when price is 2σ+
 * from VWAP or 3+ ATR from ST1 (late to chase).
 */
export function marketState(i: StateInput): StateView {
  if (i.st1 === 'neutral' || i.st2 === 'neutral') return { state: 'warming', why: 'SuperTrend warming up' };
  let state: MarketState;
  let why: string;
  if (i.st1 !== i.st2) {
    state = 'chop';
    why = 'ST1 and ST2 disagree';
  } else if (i.flips15 >= 3) {
    state = 'chop';
    why = `${i.flips15} SuperTrend flips in 15 min`;
  } else {
    state = i.st1 === 'up' ? 'trend-up' : 'trend-down';
    why = `ST1 and ST2 both ${i.st1}`;
  }
  let extended: 'up' | 'down' | undefined;
  if (i.price !== undefined) {
    const vz = i.vwap !== undefined && i.vwapSigma && i.vwapSigma > 0 ? (i.price - i.vwap) / i.vwapSigma : 0;
    const sz = i.st1Line !== undefined && i.atrTicks && i.atrTicks > 0 ? (i.price - i.st1Line) / i.atrTicks : 0;
    if (vz >= 2 || sz >= 3) extended = 'up';
    else if (vz <= -2 || sz <= -3) extended = 'down';
    if (extended) why += ` · ${Math.abs(vz) >= 2 ? `${vz.toFixed(1)}σ from VWAP` : `${sz.toFixed(1)} ATR from ST1`}`;
  }
  return { state, extended, why };
}

// ───────────── trade journal ─────────────

export interface JournalTrade {
  open: number;
  close: number;
  sym: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  exit?: number;
  /** Stop at entry and the $ it risked (fees not included), when there was one. */
  stop?: number;
  riskUsd?: number;
  /** $ result, fees included in PAPER; LIVE is the last marked open P&L (≈). */
  pnl: number;
  approx: boolean;
  setup: string;
  mode: 'paper' | 'live';
  stopMode: string;
}

/** Result in R (P&L ÷ risk at entry), when the risk is known. */
export function rMultiple(t: JournalTrade): number | undefined {
  return t.riskUsd && t.riskUsd > 0 ? t.pnl / t.riskUsd : undefined;
}

export interface JournalStats {
  n: number;
  wins: number;
  winRate: number;
  totalUsd: number;
  avgR: number | undefined;
  /** Per setup tag: trades, $ total, average R. */
  bySetup: Array<{ setup: string; n: number; totalUsd: number; avgR: number | undefined }>;
}

export function journalStats(trades: JournalTrade[]): JournalStats {
  const rs = trades.map(rMultiple).filter((x): x is number => x !== undefined);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const tags = [...new Set(trades.map((t) => t.setup || '—'))];
  return {
    n: trades.length,
    wins: trades.filter((t) => t.pnl > 0).length,
    winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0,
    totalUsd: trades.reduce((a, t) => a + t.pnl, 0),
    avgR: avg(rs),
    bySetup: tags.map((tag) => {
      const ts = trades.filter((t) => (t.setup || '—') === tag);
      return { setup: tag, n: ts.length, totalUsd: ts.reduce((a, t) => a + t.pnl, 0), avgR: avg(ts.map(rMultiple).filter((x): x is number => x !== undefined)) };
    }),
  };
}

export function journalCsv(trades: JournalTrade[]): string {
  const f = (v: number | undefined, d = 2) => (v === undefined ? '' : v.toFixed(d));
  return [
    'open,close,minutes,market,mode,side,qty,entry,exit,stop,risk_usd,pnl_usd,r,setup,stop_mode,approx',
    ...trades.map((t) =>
      [new Date(t.open).toISOString(), new Date(t.close).toISOString(), ((t.close - t.open) / 60_000).toFixed(1), t.sym, t.mode, t.side, t.qty, t.entry, t.exit ?? '', t.stop ?? '', f(t.riskUsd), f(t.pnl), f(rMultiple(t)), t.setup, t.stopMode, t.approx ? 'yes' : ''].join(','),
    ),
  ].join('\n');
}
