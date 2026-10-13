import { describe, expect, it } from 'vitest';
import { MinuteBars, scalpRead, journalCsv, journalStats, marketState, rMultiple, swingStopTicks, type JournalTrade } from '../src/panel/structure.js';
import { StopBook } from '../src/live/stops.js';

const T0 = Date.UTC(2026, 9, 12, 14, 0);
const MIN = 60_000;

describe('minute bars and swing stops', () => {
  it('range over the last N minutes', () => {
    const b = new MinuteBars();
    b.add(T0, 100);
    b.add(T0 + 10_000, 104);
    b.add(T0 + MIN, 98);
    b.add(T0 + 5 * MIN, 101);
    expect(b.range(10, T0 + 5 * MIN)).toEqual({ hi: 104, lo: 98 });
    expect(b.range(2, T0 + 5 * MIN)).toEqual({ hi: 101, lo: 101 });
  });
  it('long stop under the low, short over the high, plus the buffer', () => {
    const r = { hi: 120, lo: 100 };
    expect(swingStopTicks(true, 110, r, 4)).toBe(14); // 110 - (100 - 4)
    expect(swingStopTicks(false, 110, r, 4)).toBe(14); // (120 + 4) - 110
    expect(swingStopTicks(true, 110, undefined, 4)).toBeUndefined();
    expect(swingStopTicks(true, 90, r, 4)).toBe(1); // already under the low: at least a tick
  });
});

describe('market state', () => {
  const base = { st1: 'up' as const, st2: 'up' as const, price: 100, vwap: 100, vwapSigma: 10, st1Line: 95, atrTicks: 4 };
  const rg = (er: number, moveAtr: number) => ({ regime: { er, moveAtr } });
  it('trend from price: efficient and far; chop when back and forth, whatever the SuperTrends say', () => {
    expect(marketState({ ...base, ...rg(0.5, 4) }).state).toBe('trend-up');
    expect(marketState({ ...base, st1: 'up', st2: 'down', ...rg(0.5, 4) }).state).toBe('trend-up'); // lines disagree: still a trend
    expect(marketState({ ...base, ...rg(-0.4, -3.5) }).state).toBe('trend-down');
    expect(marketState({ ...base, ...rg(0.1, 1) }).state).toBe('chop');
    expect(marketState({ ...base, ...rg(0.6, 2) }).state).toBe('chop'); // efficient but small
    expect(marketState({ ...base, regime: undefined }).state).toBe('warming');
  });
  it('a trend holds until it has clearly faded', () => {
    expect(marketState({ ...base, ...rg(0.2, 2), prev: 'trend-up' }).state).toBe('trend-up');
    expect(marketState({ ...base, ...rg(0.2, 2), prev: 'chop' }).state).toBe('chop');
    expect(marketState({ ...base, ...rg(0.1, 2), prev: 'trend-up' }).state).toBe('chop');
  });
  it('extended at 2σ from VWAP or 3 ATR from ST1', () => {
    expect(marketState({ ...base, ...rg(0.5, 4), price: 121 }).extended).toBe('up');
    expect(marketState({ ...base, ...rg(0.5, 4), price: 108, st1Line: 95 }).extended).toBe('up'); // 13 ticks = 3.25 ATR
    expect(marketState({ ...base, ...rg(-0.5, -4), price: 99, st1Line: 101 }).extended).toBeUndefined();
  });
  it('regime from minute bars: a straight run vs back and forth', () => {
    const run = new MinuteBars();
    for (let k = 0; k <= 20; k++) run.add(k * 60_000, 100 + k * 4);
    const r = run.regime(20 * 60_000)!;
    expect(r.er).toBeCloseTo(1);
    expect(r.moveAtr).toBeGreaterThan(3);
    const saw = new MinuteBars();
    for (let k = 0; k <= 20; k++) saw.add(k * 60_000, k % 2 ? 110 : 100);
    expect(Math.abs(saw.regime(20 * 60_000)!.er)).toBeLessThan(0.1);
    expect(new MinuteBars().regime(0)).toBeUndefined();
  });
});

describe('SuperTrend scalp read', () => {
  it('GO near the line on a pullback, NEAR while still running, STRETCHED 2+ ATR out', () => {
    expect(scalpRead('up', 104, 100, 4, { er: -0.4 })).toMatchObject({ side: 'long', zone: 'go', distAtr: 1 });
    expect(scalpRead('up', 104, 100, 4, { er: 0.5 })?.zone).toBe('near');
    expect(scalpRead('up', 110, 100, 4, { er: -0.4 })?.zone).toBe('stretched');
    expect(scalpRead('down', 96, 100, 4, { er: 0.3 })).toMatchObject({ side: 'short', zone: 'go' });
    expect(scalpRead('down', 90, 100, 4, { er: 0.3 })?.zone).toBe('stretched');
    expect(scalpRead('neutral', 100, 100, 4, { er: 0 })).toBeUndefined();
    expect(scalpRead('up', 100, 100, 4, undefined)).toBeUndefined();
  });
});

describe('journal', () => {
  const t = (pnl: number, risk: number | undefined, setup: string): JournalTrade => ({ open: T0, close: T0 + MIN, sym: 'NQ-PERP', side: 'long', qty: 1, entry: 100, pnl, riskUsd: risk, approx: false, setup, mode: 'paper', stopMode: 'swing' });
  it('totals, win rate, R and per-setup results', () => {
    const tr = [t(20, 10, 'edge fade'), t(-10, 10, 'edge fade'), t(-10, 10, 'breakout')];
    expect(rMultiple(tr[0]!)).toBe(2);
    const s = journalStats(tr);
    expect(s).toMatchObject({ n: 3, wins: 1, totalUsd: 0 });
    expect(s.avgR).toBeCloseTo(0);
    expect(s.bySetup.find((x) => x.setup === 'edge fade')).toMatchObject({ n: 2, totalUsd: 10, avgR: 0.5 });
    expect(journalCsv(tr).split('\n')).toHaveLength(4);
  });
});

describe('close-confirmed stop entries', () => {
  it('a wick through the stop does not fire it; a 1-min close through it does, on the next trade', () => {
    const b = new StopBook();
    expect(b.arm({ symbol: 'X', side: 'buy', ticks: 110, units: 1, bracketsOn: false, tpTicks: 0, slTicks: 0, armedAt: 0, confirm: 'close' }, 100, 101).ok).toBe(true);
    expect(b.onTrade('X', 112, T0 + 1000)).toHaveLength(0); // wick through
    expect(b.onTrade('X', 105, T0 + 50_000)).toHaveLength(0); // minute closes back under
    expect(b.onTrade('X', 111, T0 + MIN + 30_000)).toHaveLength(0); // first minute closed at 105: no
    expect(b.onTrade('X', 111, T0 + 2 * MIN + 1000)).toHaveLength(1); // minute closed at 111: fire
  });
  it('touch stops still fire on the first trade through', () => {
    const b = new StopBook();
    b.arm({ symbol: 'X', side: 'sell', ticks: 90, units: 1, bracketsOn: false, tpTicks: 0, slTicks: 0, armedAt: 0 }, 100, 101);
    expect(b.onTrade('X', 90, T0)).toHaveLength(1);
  });
});
