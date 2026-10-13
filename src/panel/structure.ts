// Price structure for the ticket and the ladder: one-minute highs/lows (swing stops, the range),
// and whether the market is trending, chopping or stretched. Pure: no I/O. Prices in ticks.

import { percentiles } from './checks.js';

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

  /**
   * How a market is moving over the last `n` one-minute bars up to `nowMs` (this minute included,
   * its close = the last trade): efficiency = net move ÷ the path it took (−1..1; ±1 = straight
   * line, ~0 = back and forth) and the net move in ATR (14-bar Wilder ATR of the 1-minute bars).
   * Undefined until there are n + 1 bars.
   */
  regime(nowMs: number, n = REGIME_BARS): { er: number; moveAtr: number } | undefined {
    const now = Math.floor(nowMs / 60_000);
    const bs = [...this.bars.entries()].filter(([k]) => k <= now).sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    if (bs.length < n + 1) return undefined;
    let atr = 0;
    bs.forEach((b, i) => {
      const tr = i ? Math.max(b.hi - b.lo, Math.abs(b.hi - bs[i - 1]!.close), Math.abs(b.lo - bs[i - 1]!.close)) : b.hi - b.lo;
      atr = i < 14 ? (atr * i + tr) / (i + 1) : atr + (tr - atr) / 14;
    });
    const last = bs.length - 1;
    let path = 0;
    for (let k = last - n + 1; k <= last; k++) path += Math.abs(bs[k]!.close - bs[k - 1]!.close);
    const net = bs[last]!.close - bs[last - n]!.close;
    return { er: path > 0 ? net / path : 0, moveAtr: atr > 0 ? net / atr : 0 };
  }
}

/** Regime window and thresholds, measured on 12 h of Vest NQ trades (2026-10-12): with these a
 * move under way (≥ 3 ATR in 10 min) read TREND 90% of the time (SuperTrend agreement: 74%) and a
 * quiet market read TREND 12% (was 39%). Neither the old nor the new read predicts the NEXT 15 min. */
export const REGIME_BARS = 15;
export const REGIME_ER = 0.3;
export const REGIME_ATR = 3;

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
  /** MinuteBars.regime(): efficiency and net move in ATR over the last 15 minutes. */
  regime: { er: number; moveAtr: number } | undefined;
  /** The state last shown, for hysteresis (a trend holds until it has clearly faded). */
  prev?: MarketState;
  st1: 'up' | 'down' | 'neutral';
  st2: 'up' | 'down' | 'neutral';
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
 * Read from price itself, not from SuperTrend flips (the fast line flips on every pullback, which
 * called CHOP in the middle of runs). TREND when the last 15 minutes went one way efficiently
 * (efficiency ≥ 0.3) and far (≥ 3 ATR); it holds until efficiency drops under half that or the
 * move under 1.5 ATR. Otherwise CHOP (trade the range edges, not breakouts). EXTENDED when price
 * is 2σ+ from VWAP or 3+ ATR from ST1 (late to chase). It describes what is happening now; it
 * does not forecast.
 */
export function marketState(i: StateInput): StateView {
  const r = i.regime;
  if (!r) return { state: 'warming', why: `needs ${REGIME_BARS + 1} minutes of trades` };
  const up = r.er >= REGIME_ER && r.moveAtr >= REGIME_ATR;
  const down = r.er <= -REGIME_ER && r.moveAtr <= -REGIME_ATR;
  const holdUp = i.prev === 'trend-up' && r.er >= REGIME_ER / 2 && r.moveAtr >= REGIME_ATR / 2;
  const holdDown = i.prev === 'trend-down' && r.er <= -REGIME_ER / 2 && r.moveAtr <= -REGIME_ATR / 2;
  const state: MarketState = up || holdUp ? 'trend-up' : down || holdDown ? 'trend-down' : 'chop';
  const fmt = `15m: ${r.moveAtr >= 0 ? '+' : ''}${r.moveAtr.toFixed(1)} ATR, efficiency ${Math.abs(r.er).toFixed(2)}`;
  let why = state === 'chop' ? `${fmt} — back and forth` : `${fmt}${up || down ? '' : ' (holding)'}`;
  if (state !== 'chop' && i.st1 !== 'neutral' && i.st1 !== (state === 'trend-up' ? 'up' : 'down')) why += ' · ST1 against';
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

// ───────────── SuperTrend scalp read ─────────────

/** Measured on 72 h of Vest NQ (2026-10-09..12), an ST1-direction scalp taken at each 1-minute
 * close, 10-pt target / 10-pt stop: within 2 ATR of the ST1 line AND the last 5 minutes pulling
 * back won 63% (+2.5 pts/trade before ~1.25 pts round-trip taker fee; 68% / 56% in each half);
 * 3+ ATR from the line won 47% (−0.7). TREND vs CHOP made no difference (51% vs 52%). */
export const SCALP_NEAR_ATR = 2;
export const SCALP_PULLBACK_BARS = 5;

export type ScalpZone = 'go' | 'near' | 'stretched';

export interface ScalpRead {
  side: 'long' | 'short';
  zone: ScalpZone;
  /** Price's distance past the ST1 line, in ST1 ATR (+ = on the trend side). */
  distAtr: number;
  /** Efficiency of the last 5 minutes in the ST1 direction (< 0 = pulling back). */
  pull: number;
}

/** Where an ST1 scalp stands now: GO (near the line and pulling back), NEAR (near, still running:
 * wait for the dip) or STRETCHED (2+ ATR out: don't chase). Undefined while warming up. */
export function scalpRead(st1: 'up' | 'down' | 'neutral', priceTicks: number | undefined, st1Line: number | undefined, atrTicks: number | undefined, r5: { er: number } | undefined): ScalpRead | undefined {
  if (st1 === 'neutral' || priceTicks === undefined || st1Line === undefined || !atrTicks || !(atrTicks > 0) || !r5) return undefined;
  const dir = st1 === 'up' ? 1 : -1;
  const distAtr = (dir * (priceTicks - st1Line)) / atrTicks;
  const pull = dir * r5.er;
  const zone: ScalpZone = distAtr >= SCALP_NEAR_ATR ? 'stretched' : pull < 0 ? 'go' : 'near';
  return { side: dir > 0 ? 'long' : 'short', zone, distAtr, pull };
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
  mode: 'paper' | 'live' | 'replay';
  stopMode: string;
  /** Execution: the price you expected when you clicked (ask/bid for market, your price for a
   * limit/stop), slippage in points (+ = worse than expected), entry fee, maker/taker, Vest ack ms. */
  expected?: number;
  slipPts?: number;
  feeUsd?: number;
  liquidity?: 'maker' | 'taker';
  ackMs?: number;
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
  /** Execution quality over the trades that recorded it. */
  exec: { avgSlipPts: number | undefined; slipUsd: number; feesUsd: number; maker: number; taker: number; ack: { p50: number; p95: number } | undefined };
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
    exec: {
      avgSlipPts: avg(trades.map((t) => t.slipPts).filter((x): x is number => x !== undefined)),
      slipUsd: trades.reduce((a, t) => a + (t.slipPts !== undefined ? -t.slipPts * t.qty : 0), 0),
      feesUsd: trades.reduce((a, t) => a + (t.feeUsd ?? 0), 0),
      maker: trades.filter((t) => t.liquidity === 'maker').length,
      taker: trades.filter((t) => t.liquidity === 'taker').length,
      ack: percentiles(trades.map((t) => t.ackMs).filter((x): x is number => x !== undefined)),
    },
    bySetup: tags.map((tag) => {
      const ts = trades.filter((t) => (t.setup || '—') === tag);
      return { setup: tag, n: ts.length, totalUsd: ts.reduce((a, t) => a + t.pnl, 0), avgR: avg(ts.map(rMultiple).filter((x): x is number => x !== undefined)) };
    }),
  };
}

export function journalCsv(trades: JournalTrade[]): string {
  const f = (v: number | undefined, d = 2) => (v === undefined ? '' : v.toFixed(d));
  return [
    'open,close,minutes,market,mode,side,qty,entry,exit,stop,risk_usd,pnl_usd,r,setup,stop_mode,approx,expected,slip_pts,fee_usd,liquidity,ack_ms',
    ...trades.map((t) =>
      [new Date(t.open).toISOString(), new Date(t.close).toISOString(), ((t.close - t.open) / 60_000).toFixed(1), t.sym, t.mode, t.side, t.qty, t.entry, t.exit ?? '', t.stop ?? '', f(t.riskUsd), f(t.pnl), f(rMultiple(t)), t.setup, t.stopMode, t.approx ? 'yes' : '', t.expected ?? '', f(t.slipPts), f(t.feeUsd), t.liquidity ?? '', t.ackMs ?? ''].join(','),
    ),
  ].join('\n');
}
