// Dual SuperTrend — a line-for-line TypeScript port of BookDepthIQ's trend engine
// (BookDepthIQ crates/hmd-analytics/src/trend.rs, the owner's own code), so the Vest panel draws
// the same ST1/ST2 lines with the same rules. Pure: no I/O.
//
// Candles are built from trades: a candle completes when the first trade of a later time bucket
// arrives. ATR = EMA of true range (α = 2/(N+1)); bands = typical (H+L+C)/3 ± multiplier × ATR;
// the line ratchets (only up in an uptrend, only down in a downtrend) and flips by the switch rule.
// Keep this file in step with trend.rs — change both or neither.

export type TrendDir = 'up' | 'down' | 'neutral';
export type SwitchCond = 'close' | 'wick' | 'confirmed' | 'volume' | 'delta' | 'deltabook';
export type CombinedState = 'strongLong' | 'weakLong' | 'chop' | 'weakShort' | 'strongShort';

export interface TrendConfig {
  enabled: boolean;
  intervalSec: number;
  numCandles: number;
  multiplier: number;
  switch: SwitchCond;
  confirm: number;
  volMult: number;
  deltaMin: number;
}

/** BookDepthIQ's live defaults (web/src/shell/settings.ts): both flip on price + delta. */
export const DEFAULT_T1: TrendConfig = { enabled: true, intervalSec: 60, numCandles: 10, multiplier: 3.6, switch: 'delta', confirm: 3, volMult: 1.5, deltaMin: 0 };
export const DEFAULT_T2: TrendConfig = { enabled: true, intervalSec: 15, numCandles: 10, multiplier: 3.0, switch: 'delta', confirm: 1, volMult: 1.5, deltaMin: 0 };

export interface TrendSnapshot {
  dir: TrendDir;
  /** Line in ticks (rounded), undefined before the first candle completes. */
  lineTicks: number | undefined;
  /** True only on the snapshot of the candle that flipped. */
  switched: boolean;
}

interface Candle {
  bucket: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | undefined;
  vol: number;
  delta: number;
}

export class TrendEngine {
  private cur: Candle | null = null;
  private prevClose: number | undefined;
  private atr: number | undefined;
  private dir: TrendDir = 'neutral';
  private line: number | undefined;
  private crossStreak = 0;
  private lastSwitched = false;
  private volEma: number | undefined;
  private bookImbalance = 0;
  lastVol = 0;
  lastDelta = 0;
  private lastClose = 0;

  constructor(readonly cfg: TrendConfig) {}

  setBookImbalance(v: number): void {
    this.bookImbalance = v;
  }

  /** (close − line) / (3 × ATR), clamped to [−1, 1]; 0 without a line or ATR. */
  lineDistanceNorm(): number {
    if (this.line === undefined || this.atr === undefined || !(this.atr > 0)) return 0;
    return Math.max(-1, Math.min(1, (this.lastClose - this.line) / (3 * this.atr)));
  }

  /** Feed one trade. Returns the completed candle's snapshot when this trade starts a new bucket. */
  onTrade(tsMs: number, priceTicks: number, size: number, isBuy: boolean): TrendSnapshot | undefined {
    if (!this.cfg.enabled || this.cfg.intervalSec <= 0) return undefined;
    const bucket = Math.floor(tsMs / (this.cfg.intervalSec * 1000));
    const signed = isBuy ? size : -size;
    const c = this.cur;
    if (!c) {
      this.cur = { bucket, high: priceTicks, low: priceTicks, close: priceTicks, prevClose: this.prevClose, vol: size, delta: signed };
      return undefined;
    }
    if (c.bucket === bucket) {
      c.high = Math.max(c.high, priceTicks);
      c.low = Math.min(c.low, priceTicks);
      c.close = priceTicks;
      c.vol += size;
      c.delta += signed;
      return undefined;
    }
    // Any other bucket completes the current candle (same as trend.rs).
    const snap = this.finalize(c);
    this.prevClose = c.close;
    this.cur = { bucket, high: priceTicks, low: priceTicks, close: priceTicks, prevClose: this.prevClose, vol: size, delta: signed };
    return snap;
  }

  private finalize(c: Candle): TrendSnapshot {
    this.lastVol = c.vol;
    this.lastDelta = c.delta;
    this.lastClose = c.close;

    const n = Math.max(1, this.cfg.numCandles);
    const alpha = 2 / (n + 1);
    const prevVolEma = this.volEma;
    this.volEma = prevVolEma === undefined ? c.vol : prevVolEma + alpha * (c.vol - prevVolEma);

    const typical = (c.high + c.low + c.close) / 3;
    const tr = c.prevClose !== undefined ? Math.max(c.high - c.low, Math.abs(c.high - c.prevClose), Math.abs(c.low - c.prevClose)) : c.high - c.low;
    this.atr = this.atr === undefined ? tr : this.atr + alpha * (tr - this.atr);
    const atr = this.atr;
    const upper = typical + this.cfg.multiplier * atr;
    const lower = typical - this.cfg.multiplier * atr;
    const close = c.close;

    if (this.line === undefined) {
      this.dir = close >= typical ? 'up' : 'down';
      this.line = this.dir === 'up' ? lower : upper;
      this.lastSwitched = false;
      return this.snapshotInternal();
    }
    const prevLine = this.line;
    let switched = false;
    if (this.dir === 'up' || this.dir === 'down') {
      const up = this.dir === 'up';
      const newLine = up ? Math.max(prevLine, lower) : Math.min(prevLine, upper);
      const breached = up
        ? this.cfg.switch === 'wick' ? c.low < newLine : close < newLine
        : this.cfg.switch === 'wick' ? c.high > newLine : close > newLine;
      if (breached) {
        const flipTo: TrendDir = up ? 'down' : 'up';
        const flipLine = up ? upper : lower;
        const flowOk = this.computeFlowOk(!up, c, prevVolEma);
        const sw = this.cfg.switch;
        if (sw === 'confirmed') {
          this.crossStreak += 1;
          if (this.crossStreak >= Math.max(1, this.cfg.confirm)) {
            this.dir = flipTo;
            this.line = flipLine;
            switched = true;
            this.crossStreak = 0;
          } else this.line = newLine;
        } else if (sw === 'volume' || sw === 'delta' || sw === 'deltabook') {
          if (flowOk) {
            this.dir = flipTo;
            this.line = flipLine;
            switched = true;
            this.crossStreak = 0;
          } else {
            this.crossStreak = 0;
            this.line = newLine;
          }
        } else {
          this.crossStreak += 1;
          if (this.crossStreak >= 1) {
            this.dir = flipTo;
            this.line = flipLine;
            switched = true;
            this.crossStreak = 0;
          } else this.line = newLine;
        }
      } else {
        this.crossStreak = 0;
        this.line = newLine;
      }
    } else {
      this.dir = close >= typical ? 'up' : 'down';
      this.line = this.dir === 'up' ? lower : upper;
    }
    this.lastSwitched = switched;
    return this.snapshotInternal();
  }

  private computeFlowOk(newDirUp: boolean, c: Candle, prevVolEma: number | undefined): boolean {
    const volOk = prevVolEma !== undefined && prevVolEma > 0 ? c.vol >= this.cfg.volMult * prevVolEma : true;
    const deltaOk = newDirUp ? c.delta >= this.cfg.deltaMin : c.delta <= -this.cfg.deltaMin;
    const bookOk = newDirUp ? this.bookImbalance >= 0 : this.bookImbalance <= 0;
    switch (this.cfg.switch) {
      case 'volume':
        return volOk;
      case 'delta':
        return deltaOk;
      case 'deltabook':
        return deltaOk && bookOk;
      default:
        return true;
    }
  }

  private snapshotInternal(): TrendSnapshot {
    return { dir: this.dir, lineTicks: this.line === undefined ? undefined : Math.round(this.line), switched: this.lastSwitched };
  }

  /** Passive read: never reports a flip. */
  snapshot(): TrendSnapshot {
    return { dir: this.dir, lineTicks: this.line === undefined ? undefined : Math.round(this.line), switched: false };
  }
}

export function combinedState(t1: TrendDir, t2: TrendDir): CombinedState {
  if (t1 === 'up') return t2 === 'up' ? 'strongLong' : 'weakLong';
  if (t1 === 'down') return t2 === 'down' ? 'strongShort' : 'weakShort';
  return 'chop';
}

const W_SLOPE = 0.35;
const W_DIST = 0.25;
const W_VOLDELTA = 0.2;
const W_BOOK = 0.1;
const W_CHOP = 0.1;

/** Confidence −100..100 from inputs already in the ST1 direction frame, each ~[−1, 1]. */
export function confidenceScore(dirSlope: number, lineDistance: number, volDelta: number, book: number, chop: number): number {
  const c = Math.max(-1, Math.min(1, W_SLOPE * dirSlope + W_DIST * lineDistance + W_VOLDELTA * volDelta + W_BOOK * book - W_CHOP * chop));
  return Math.max(-100, Math.min(100, Math.round(c * 100)));
}

export interface DualSnapshot {
  t1: TrendSnapshot;
  t2: TrendSnapshot;
  state: CombinedState;
  confidence: number;
}

export class DualTrend {
  t1: TrendEngine;
  t2: TrendEngine;
  private bookImbalance = 0;

  constructor(c1: TrendConfig = DEFAULT_T1, c2: TrendConfig = DEFAULT_T2) {
    this.t1 = new TrendEngine(c1);
    this.t2 = new TrendEngine(c2);
  }

  /** Wipe candle/ATR/line state but keep the configs (symbol change; trend.rs DualTrend::reset). */
  reset(): void {
    this.t1 = new TrendEngine(this.t1.cfg);
    this.t2 = new TrendEngine(this.t2.cfg);
    this.bookImbalance = 0;
  }

  /** Book pressure in [−1, 1]: (bid − ask) / (bid + ask). Only used by 'deltabook' and confidence. */
  setBookImbalance(v: number): void {
    this.bookImbalance = v;
    this.t1.setBookImbalance(v);
    this.t2.setBookImbalance(v);
  }

  /** Feed one trade; returns a snapshot when either line's candle completed (flip flags kept). */
  onTrade(tsMs: number, priceTicks: number, size: number, isBuy: boolean): DualSnapshot | undefined {
    const s1 = this.t1.onTrade(tsMs, priceTicks, size, isBuy);
    const s2 = this.t2.onTrade(tsMs, priceTicks, size, isBuy);
    if (!s1 && !s2) return undefined;
    const snap = this.snapshot();
    if (s1) snap.t1.switched = s1.switched;
    if (s2) snap.t2.switched = s2.switched;
    return snap;
  }

  snapshot(): DualSnapshot {
    const a = this.t1.snapshot();
    const b = this.t2.snapshot();
    const state = combinedState(a.dir, b.dir);
    if (a.lineTicks === undefined) return { t1: a, t2: b, state, confidence: 0 };
    const sign = a.dir === 'up' ? 1 : a.dir === 'down' ? -1 : 0;
    const lineDistance = this.t1.lineDistanceNorm();
    // trend.rs divides by last_vol.max(1) — a zero guard for whole CME contracts. Vest sizes are
    // fractional units, so guard with a tiny epsilon instead to keep the same delta/volume ratio.
    const volDelta = Math.tanh(this.t1.lastDelta / Math.max(this.t1.lastVol, 1e-9));
    const book = Math.max(-1, Math.min(1, this.bookImbalance));
    const chop = a.dir === 'neutral' || a.dir !== b.dir ? 1 : 0;
    return { t1: a, t2: b, state, confidence: confidenceScore(sign, lineDistance, volDelta, book, chop) };
  }
}
