import { describe, expect, it } from 'vitest';
import { MinuteBars, journalCsv, journalStats, marketState, rMultiple, swingStopTicks, type JournalTrade } from '../src/panel/structure.js';
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
  const base = { flips15: 0, price: 100, vwap: 100, vwapSigma: 10, st1Line: 95, atrTicks: 4 };
  it('trend when both lines agree, chop when they disagree or keep flipping', () => {
    expect(marketState({ ...base, st1: 'up', st2: 'up' }).state).toBe('trend-up');
    expect(marketState({ ...base, st1: 'up', st2: 'down' }).state).toBe('chop');
    expect(marketState({ ...base, st1: 'down', st2: 'down', flips15: 3 }).state).toBe('chop');
    expect(marketState({ ...base, st1: 'neutral', st2: 'up' }).state).toBe('warming');
  });
  it('extended at 2σ from VWAP or 3 ATR from ST1', () => {
    expect(marketState({ ...base, st1: 'up', st2: 'up', price: 121 }).extended).toBe('up');
    expect(marketState({ ...base, st1: 'up', st2: 'up', price: 108, st1Line: 95 }).extended).toBe('up'); // 13 ticks = 3.25 ATR
    expect(marketState({ ...base, st1: 'down', st2: 'down', price: 99, st1Line: 101 }).extended).toBeUndefined();
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
