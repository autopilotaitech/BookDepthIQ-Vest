import { describe, expect, it } from 'vitest';
import { DEFAULT_T1, DEFAULT_T2, DualTrend, TrendEngine, combinedState, confidenceScore, type SwitchCond, type TrendConfig } from '../src/panel/supertrend.js';

// Mirrors BookDepthIQ crates/hmd-analytics/src/trend.rs tests (ns → ms timestamps).
const cfg = (intervalSec: number, n: number, mult: number, sw: SwitchCond): TrendConfig => ({ enabled: true, intervalSec, numCandles: n, multiplier: mult, switch: sw, confirm: 2, volMult: 1.5, deltaMin: 0 });
const s = (i: number) => i * 1000;

describe('TrendEngine (port of trend.rs)', () => {
  it('rising market goes up and the line trails (never drops)', () => {
    const e = new TrendEngine(cfg(1, 3, 2.0, 'close'));
    let last: number | undefined;
    for (let i = 0; i < 30; i++) {
      const snap = e.onTrade(s(i), 1000 + i * 5, 1, true);
      if (snap && snap.dir === 'up' && snap.lineTicks !== undefined) {
        if (last !== undefined) expect(snap.lineTicks).toBeGreaterThanOrEqual(last);
        last = snap.lineTicks;
      }
    }
    expect(e.snapshot().dir).toBe('up');
  });

  it('cold start is neutral with no line', () => {
    const snap = new TrendEngine(cfg(1, 10, 2.0, 'close')).snapshot();
    expect(snap.dir).toBe('neutral');
    expect(snap.lineTicks).toBeUndefined();
  });

  it('close cross flips down when close is below the line', () => {
    const e = new TrendEngine(cfg(1, 3, 1.0, 'close'));
    for (let i = 0; i < 20; i++) e.onTrade(s(i), 1000 + i * 10, 1, true);
    expect(e.snapshot().dir).toBe('up');
    for (let i = 20; i < 40; i++) e.onTrade(s(i), 1200 - (i - 19) * 40, 1, true);
    expect(e.snapshot().dir).toBe('down');
  });

  it('confirmed close needs N consecutive crosses', () => {
    const e = new TrendEngine(cfg(1, 3, 1.0, 'confirmed'));
    for (let i = 0; i < 20; i++) e.onTrade(s(i), 1000 + i * 10, 1, true);
    expect(e.snapshot().dir).toBe('up');
    e.onTrade(s(20), 900, 1, true);
    e.onTrade(s(21), 1000, 1, true);
    expect(e.snapshot().dir).toBe('up');
  });

  it("'delta' switch: a close through the line flips only when that candle's delta agrees", () => {
    const up = () => {
      const e = new TrendEngine(cfg(1, 3, 1.0, 'delta'));
      for (let i = 0; i < 20; i++) e.onTrade(s(i), 1000 + i * 10, 1, true);
      return e;
    };
    // crash candle made of BUYS (delta > 0): price breaks but flow disagrees → stays up
    const a = up();
    a.onTrade(s(20), 700, 1, true);
    a.onTrade(s(21), 700, 1, true); // completes the crash candle
    expect(a.snapshot().dir).toBe('up');
    // same crash made of SELLS (delta < 0): flips down
    const b = up();
    b.onTrade(s(20), 700, 1, false);
    const snap = b.onTrade(s(21), 700, 1, false)!;
    expect(snap.dir).toBe('down');
    expect(snap.switched).toBe(true);
  });

  it('fractional Vest sizes work (no integer assumptions)', () => {
    const e = new TrendEngine(cfg(1, 3, 1.0, 'delta'));
    for (let i = 0; i < 20; i++) e.onTrade(s(i), 1000 + i * 10, 0.0008, true);
    expect(e.snapshot().dir).toBe('up');
  });
});

describe('DualTrend', () => {
  it('combined state table', () => {
    expect(combinedState('up', 'up')).toBe('strongLong');
    expect(combinedState('up', 'down')).toBe('weakLong');
    expect(combinedState('up', 'neutral')).toBe('weakLong');
    expect(combinedState('down', 'down')).toBe('strongShort');
    expect(combinedState('down', 'up')).toBe('weakShort');
    expect(combinedState('neutral', 'up')).toBe('chop');
  });

  it('reports switched only on the flip candle', () => {
    const d = new DualTrend(cfg(1, 3, 1.0, 'close'), cfg(100, 3, 1.0, 'close'));
    for (let i = 0; i < 20; i++) d.onTrade(s(i), 1000 + i * 10, 1, true);
    const flags: boolean[] = [];
    for (let i = 20; i < 40; i++) {
      const snap = d.onTrade(s(i), 1200 - (i - 19) * 40, 1, true);
      if (snap) flags.push(snap.t1.switched);
    }
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(d.snapshot().t1.dir).toBe('down');
  });

  it('cold start: confidence 0; reset keeps configs', () => {
    const d = new DualTrend();
    expect(d.snapshot().confidence).toBe(0);
    for (let i = 0; i < 2000; i += 5) d.onTrade(s(i), 1000 + i, 1, true);
    d.reset();
    expect(d.snapshot().t1.lineTicks).toBeUndefined();
    expect(d.t1.cfg).toEqual(DEFAULT_T1);
    expect(d.t2.cfg).toEqual(DEFAULT_T2);
  });

  it('confidence weights match trend.rs', () => {
    expect(confidenceScore(1, 1, 1, 1, 0)).toBe(90); // .35+.25+.2+.1
    expect(confidenceScore(1, 0, 0, 0, 1)).toBe(25); // .35-.1
    expect(confidenceScore(-1, -1, -1, -1, 0)).toBe(-90);
  });

  it('defaults are BookDepthIQ live settings', () => {
    expect(DEFAULT_T1).toMatchObject({ intervalSec: 60, numCandles: 10, multiplier: 3.6, switch: 'delta' });
    expect(DEFAULT_T2).toMatchObject({ intervalSec: 15, numCandles: 10, multiplier: 3.0, switch: 'delta' });
  });
});
