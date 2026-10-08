import { describe, expect, it } from 'vitest';
import { bidShare, imbalances, runs, walls } from '../src/panel/footprint.js';

const m = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe('footprint imbalances', () => {
  it('buy: bought at P vs sold one row below; sell: sold at P vs bought one row above', () => {
    // rows 1 tick apart
    const bought = m({ 100: 3, 101: 1, 102: 0.5 });
    const sold = m({ 99: 1, 100: 0.4, 101: 2 });
    const r = imbalances(bought, sold, 1, 3);
    expect([...r.buy].sort()).toEqual([100]); // 3 ≥ 3×1 (sold@99); 101: 1 vs 0.4×3=1.2 no
    expect([...r.sell].sort()).toEqual([101]); // 2 ≥ 3×0.5 (bought@102)
  });

  it('minQty stops a lone tiny print being an infinite imbalance', () => {
    const r = imbalances(m({ 100: 0.001 }), new Map(), 1, 3, 0.05);
    expect(r.buy.size).toBe(0);
    const r2 = imbalances(m({ 100: 0.2 }), new Map(), 1, 3, 0.05);
    expect(r2.buy.has(100)).toBe(true); // 0.2 ≥ 3×0.05
  });

  it('works on grouped rows (g = 4)', () => {
    const r = imbalances(m({ 104: 3 }), m({ 100: 1 }), 4, 3);
    expect(r.buy.has(104)).toBe(true);
  });

  it('stacked = 3+ consecutive rows', () => {
    expect([...runs(new Set([1, 2, 3, 5, 6]), 1, 3)].sort()).toEqual([1, 2, 3]);
    expect(runs(new Set([4, 8]), 4, 3).size).toBe(0);
    expect([...runs(new Set([4, 8, 12]), 4, 3)].sort((a, b) => a - b)).toEqual([4, 8, 12]);
  });
});

describe('liquidity', () => {
  it('walls are ≥ 3× the average level', () => {
    const w = walls(m({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 12 }));
    expect([...w]).toEqual([5]); // avg 3.2 → 12 ≥ 9.6
    expect(walls(m({ 1: 1, 2: 9 })).size).toBe(0); // too few levels
  });

  it('bid share', () => {
    expect(bidShare([3, 3], [2, 2])).toBeCloseTo(0.6);
    expect(bidShare([], [])).toBeUndefined();
  });
});
