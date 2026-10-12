import { describe, expect, it } from 'vitest';
import { BeWatch, parseSplit, scaleOrders, splitTargets } from '../src/live/targets.js';
import type { LivePosition } from '../src/vest/tradingShapes.js';

describe('partial targets', () => {
  it('splits the size by the user\'s percentages, last target takes the rounding', () => {
    const r = splitTargets(0.15, 4, [
      { ticks: 20, pct: 50 },
      { ticks: 40, pct: 30 },
      { ticks: 60, pct: 20 },
    ]);
    expect(r).toEqual({ ok: true, legs: [{ ticks: 20, qty: 0.075 }, { ticks: 40, qty: 0.045 }, { ticks: 60, qty: 0.03 }] });
    const odd = splitTargets(0.001, 4, [{ ticks: 20, pct: 1 }, { ticks: 40, pct: 1 }, { ticks: 60, pct: 1 }]);
    expect(odd.ok && odd.legs.map((l) => l.qty)).toEqual([0.0003, 0.0003, 0.0004]);
  });

  it('targets that are off are skipped; one target gets the whole size', () => {
    expect(splitTargets(0.1, 4, [{ ticks: 20, pct: 50 }, { ticks: 0, pct: 30 }, { ticks: 0, pct: 20 }])).toEqual({ ok: true, legs: [{ ticks: 20, qty: 0.1 }] });
    expect(splitTargets(0.1, 4, [{ ticks: 0, pct: 50 }])).toEqual({ ok: true, legs: [] });
  });

  it('refuses targets out of order or a size too small to split', () => {
    expect(splitTargets(0.1, 4, [{ ticks: 40, pct: 50 }, { ticks: 20, pct: 50 }]).ok).toBe(false);
    expect(splitTargets(0.0001, 4, [{ ticks: 20, pct: 50 }, { ticks: 40, pct: 50 }]).ok).toBe(false);
  });

  it('reads "50/30/20" and friends', () => {
    expect(parseSplit('50/30/20')).toEqual([50, 30, 20]);
    expect(parseSplit(' 60, 40 ')).toEqual([60, 40]);
  });
});

describe('scale orders (Vest Scale ticket)', () => {
  it('even: count limits evenly spaced, equal sizes summing to the total', () => {
    const r = scaleOrders(0.3, 4, 1000, 960, 3, 1, 'even');
    expect(r).toEqual({ ok: true, legs: [{ ticks: 1000, qty: 0.1 }, { ticks: 980, qty: 0.1 }, { ticks: 960, qty: 0.1 }] });
  });

  it('skew 2 toward the end: sizes grow as skew^(i/(n−1)), total exact', () => {
    const r = scaleOrders(0.7, 4, 1000, 990, 3, 4, 'end');
    // weights 1, 2, 4 → 0.1, 0.2, 0.4
    expect(r.ok && r.legs.map((l) => l.qty)).toEqual([0.1, 0.2, 0.4]);
    const s = scaleOrders(0.7, 4, 1000, 990, 3, 4, 'start');
    expect(s.ok && s.legs.map((l) => l.qty)).toEqual([0.4, 0.2, 0.1]);
  });

  it('refuses what Vest refuses: count outside 2–10, and ranges too narrow', () => {
    expect(scaleOrders(1, 4, 1000, 900, 1, 1, 'even').ok).toBe(false);
    expect(scaleOrders(1, 4, 1000, 900, 11, 1, 'even').ok).toBe(false);
    expect(scaleOrders(1, 4, 1000, 999, 3, 1, 'even').ok).toBe(false);
    expect(scaleOrders(0.0002, 4, 1000, 990, 3, 1, 'even').ok).toBe(false);
  });
});

const pos = (qty: number, tps: number): LivePosition => ({
  positionId: 'P1',
  symbol: 'NDX-USD-PERP',
  side: 'long',
  qty,
  openPrice: 31450,
  takeProfits: Array.from({ length: tps }, (_, i) => ({ id: `T${i}`, triggerPrice: 31460 + i * 10 })),
  stopLosses: [{ id: 'S1', triggerPrice: 31440 }],
});

describe('B/E after TP1 watch', () => {
  it('fires once when the position shrinks AND loses a target leg', () => {
    const w = new BeWatch();
    w.arm('NDX-USD-PERP', 1);
    expect(w.check(undefined)).toBe('idle'); // limit entry not filled yet
    expect(w.check(pos(0.3, 0))).toBe('idle'); // legs not attached yet
    expect(w.check(pos(0.3, 3))).toBe('idle');
    expect(w.check(pos(0.15, 2))).toBe('fire');
    expect(w.symbol).toBeUndefined();
    expect(w.check(pos(0.05, 1))).toBe('idle');
  });

  it('a manual partial close keeps every leg and does not fire', () => {
    const w = new BeWatch();
    w.arm('NDX-USD-PERP', 1);
    w.check(pos(0.3, 3));
    expect(w.check(pos(0.2, 3))).toBe('idle');
  });

  it('ends when the watched position is gone', () => {
    const w = new BeWatch();
    w.arm('NDX-USD-PERP', 1);
    w.check(pos(0.3, 3));
    expect(w.check(undefined)).toBe('gone');
    expect(w.symbol).toBeUndefined();
  });
});
