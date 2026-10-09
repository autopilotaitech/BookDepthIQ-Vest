import { describe, expect, it } from 'vitest';
import { DEFAULT_INDICATORS, indicatorsFor, liveBigPrints, parseBands, stackZones } from '../src/panel/indicators.js';
import { Vwap, parseHhmm, sessionWindow } from '../src/panel/vwap.js';

describe('VWAP', () => {
  it('volume-weighted mean and σ', () => {
    const v = new Vwap();
    v.add(100, 1);
    v.add(110, 3);
    expect(v.value()).toBeCloseTo(107.5);
    // E[p²] = (10000 + 3×12100)/4 = 11575; σ² = 11575 − 107.5² = 18.75
    expect(v.sigma()).toBeCloseTo(Math.sqrt(18.75));
    const b = v.bands([1, 2]);
    expect(b[1]!.hi).toBeCloseTo(107.5 + 2 * Math.sqrt(18.75));
  });

  it('empty → undefined; zero/NaN sizes ignored', () => {
    const v = new Vwap();
    v.add(100, 0);
    v.add(NaN, 1);
    expect(v.value()).toBeUndefined();
    expect(v.bands([1])).toEqual([]);
  });

  it('parses HH:MM', () => {
    expect(parseHhmm('09:30')).toBe(570);
    expect(parseHhmm('9:30')).toBe(570);
    expect(parseHhmm('24:00')).toBeUndefined();
    expect(parseHhmm('x')).toBeUndefined();
  });

  it('session window in New York time, incl. one that crosses midnight', () => {
    // 2026-10-08 14:00 ET = 18:00 UTC
    const now = Date.UTC(2026, 9, 8, 18, 0);
    const w = sessionWindow(now, '09:30', '16:00')!;
    expect(new Date(w.from).toISOString()).toBe('2026-10-08T13:30:00.000Z');
    expect(new Date(w.to).toISOString()).toBe('2026-10-08T20:00:00.000Z');
    // before today's start → the previous day's session (finished, frozen)
    const early = sessionWindow(Date.UTC(2026, 9, 8, 12, 0), '09:30', '16:00')!;
    expect(new Date(early.from).toISOString()).toBe('2026-10-07T13:30:00.000Z');
    // Globex-style 18:00 → 17:00 crosses midnight
    const gx = sessionWindow(now, '18:00', '17:00')!;
    expect(new Date(gx.from).toISOString()).toBe('2026-10-07T22:00:00.000Z');
    expect(gx.to - gx.from).toBe(23 * 3600_000);
  });
});

describe('indicator settings', () => {
  it('per-instrument overrides on top of defaults', () => {
    const all = { 'NDX-USD-PERP': { bigMin: 5, fpRatio: 2.5 } };
    expect(indicatorsFor(all, 'NDX-USD-PERP')).toMatchObject({ bigMin: 5, fpRatio: 2.5, vwapStart: '09:30' });
    expect(indicatorsFor(all, 'SPX-USD-PERP')).toEqual(DEFAULT_INDICATORS);
    expect(indicatorsFor(undefined, undefined)).toEqual(DEFAULT_INDICATORS);
  });

  it('band list parsing', () => {
    expect(parseBands('1, 2')).toEqual([1, 2]);
    expect(parseBands('0.5 1 2 3')).toEqual([0.5, 1, 2]);
    expect(parseBands('')).toEqual([]);
  });
});

describe('big prints', () => {
  it('keeps the largest per price+side inside the lifetime, newest first', () => {
    const now = 1_000_000;
    const out = liveBigPrints(
      [
        { priceTicks: 10, qty: 4, side: 'buy', time: now - 60_000 },
        { priceTicks: 10, qty: 6, side: 'buy', time: now - 120_000 },
        { priceTicks: 10, qty: 5, side: 'sell', time: now - 30_000 },
        { priceTicks: 12, qty: 9, side: 'buy', time: now - 20 * 60_000 }, // expired
      ],
      now,
      15,
    );
    expect(out.map((p) => [p.side, p.qty])).toEqual([
      ['sell', 5],
      ['buy', 6],
    ]);
  });
});

describe('stacked zones', () => {
  it('support at the bottom of a buy run, resistance at the top of a sell run', () => {
    const z = stackZones(new Set([100, 101, 102]), new Set([110, 111, 112, 120, 121, 122]), 1);
    expect(z).toEqual([
      { ticks: 100, side: 'buy', rows: 3 },
      { ticks: 112, side: 'sell', rows: 3 },
      { ticks: 122, side: 'sell', rows: 3 },
    ]);
  });
});
