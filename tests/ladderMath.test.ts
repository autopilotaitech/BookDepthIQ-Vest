import { describe, expect, it } from 'vitest';
import {
  BasisTracker,
  SpreadWindow,
  bracketPreview,
  offscreen,
  roundTripCost,
  rowPnlUsd,
} from '../src/panel/ladderMath.js';

describe('row P&L', () => {
  it('long gains above entry, loses below', () => {
    expect(rowPnlUsd(0.4, 100, 104, 0.25)).toBeCloseTo(0.4);
    expect(rowPnlUsd(0.4, 100, 96, 0.25)).toBeCloseTo(-0.4);
  });
  it('short is the mirror', () => {
    expect(rowPnlUsd(-0.4, 100, 96, 0.25)).toBeCloseTo(0.4);
  });
});

describe('round-trip cost', () => {
  it('spread plus two taker fees — the cost of every scalp on Vest', () => {
    // 0.4u, 5-tick spread, $31,455, 0.25 bps taker
    const c = roundTripCost(0.4, 5, 0.25, 31455, 0.000025);
    expect(c.spreadUsd).toBeCloseTo(0.5);
    expect(c.feesUsd).toBeCloseTo(0.629, 3);
    expect(c.totalUsd).toBeCloseTo(1.129, 3);
  });
});

describe('bracket preview', () => {
  it('buy: TP above, SL below, $ per leg', () => {
    expect(bracketPreview('buy', 1000, 0.4, 16, 8, 0.25)).toEqual({ tpTicks: 1016, tpUsd: 1.6, slTicks: 992, slUsd: -0.8 });
  });
  it('sell mirrors; a 0 leg is omitted', () => {
    expect(bracketPreview('sell', 1000, 0.4, 0, 8, 0.25)).toEqual({ slTicks: 1008, slUsd: -0.8 });
  });
});

describe('spread window', () => {
  it('judges "wide" against the market\'s own recent p90, not a constant', () => {
    const w = new SpreadWindow(60_000);
    for (let i = 0; i < 100; i++) w.push(i < 90 ? 5 : 6, i * 100);
    expect(w.quantile(0.9)).toBe(6);
    expect(w.isWide(6)).toBe(false);
    expect(w.isWide(8)).toBe(true);
  });

  it('refuses to judge with too little history', () => {
    const w = new SpreadWindow();
    w.push(5, 0);
    expect(w.isWide(50)).toBe(false);
  });

  it('drops samples older than the window', () => {
    const w = new SpreadWindow(1000);
    w.push(5, 0);
    w.push(5, 2000);
    expect(w.size).toBe(1);
  });
});

describe('basis tracker', () => {
  it('first sample sets the basis; implied mid = index + basis', () => {
    const b = new BasisTracker(1000);
    expect(b.implied(100)).toBeUndefined();
    b.update(130, 100, 0);
    expect(b.implied(104)).toBe(134);
  });

  it('moves halfway toward a new gap after one half-life', () => {
    const b = new BasisTracker(1000);
    b.update(130, 100, 0); // gap 30
    b.update(150, 100, 1000); // gap 50
    expect(b.implied(100)).toBeCloseTo(140);
  });
});

describe('offscreen markers', () => {
  it('pins markers outside the visible rows to the nearer edge', () => {
    const o = offscreen(
      [
        { label: 'TP', ticks: 130 },
        { label: 'SL', ticks: 95 },
        { label: 'in view', ticks: 110 },
      ],
      100,
      120,
    );
    expect(o).toEqual([
      { label: 'TP', ticks: 130, above: true, distance: 10 },
      { label: 'SL', ticks: 95, above: false, distance: 5 },
    ]);
  });
});

import { GROUP_STEPS, aggregate, bucketOf, stepGroup } from '../src/panel/ladderMath.js';

describe('price grouping', () => {
  it('buckets by floor so every tick lands in exactly one row', () => {
    expect(bucketOf(125917, 4)).toBe(125916);
    expect(bucketOf(125916, 4)).toBe(125916);
    expect(bucketOf(125919, 4)).toBe(125916);
    expect(bucketOf(125920, 4)).toBe(125920);
    expect(bucketOf(-1, 4)).toBe(-4);
  });

  it('sums sizes per bucket; group 1 changes nothing', () => {
    expect([...aggregate([10, 11, 12, 13, 14], [1, 2, 3, 4, 5], 4)]).toEqual([
      [8, 3],
      [12, 12],
    ]);
    expect([...aggregate([10, 11], [1, 2], 1)]).toEqual([
      [10, 1],
      [11, 2],
    ]);
  });

  it('total size is conserved by grouping', () => {
    const ticks = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const sizes = ticks.map((t) => (t % 7) + 0.5);
    const total = sizes.reduce((a, b) => a + b, 0);
    for (const g of GROUP_STEPS) {
      const sum = [...aggregate(ticks, sizes, g).values()].reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(total);
    }
  });

  it('wheel steps through the list and clamps at both ends', () => {
    expect(stepGroup(1, 1)).toBe(2);
    expect(stepGroup(4, -1)).toBe(2);
    expect(stepGroup(1, -1)).toBe(1);
    expect(stepGroup(100, 1)).toBe(100);
    expect(stepGroup(3, 1)).toBe(2); // unknown value restarts from the finest
  });
});
