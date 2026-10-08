import { describe, expect, it } from 'vitest';
import { buildProfile, signedQty } from '../src/panel/profile.js';

describe('volume profile', () => {
  it('POC is the heaviest row; value area grows toward the heavier side until 70%', () => {
    // total 100: 100:5 101:10 102:40 103:25 104:20
    const vol = new Map([
      [100, 5],
      [101, 10],
      [102, 40],
      [103, 25],
      [104, 20],
    ]);
    const p = buildProfile(vol, new Map());
    expect(p.poc).toBe(102);
    expect(p.totalVol).toBe(100);
    expect(p.maxVol).toBe(40);
    // 40 → +25 (103, heavier than 101) = 65 → +20 (104 vs 101:10) = 85 ≥ 70
    expect(p.val).toBe(102);
    expect(p.vah).toBe(104);
  });

  it('empty → no POC, delta max still computed', () => {
    const p = buildProfile(new Map(), new Map([[5, -3]]));
    expect(p.poc).toBeUndefined();
    expect(p.maxAbsDelta).toBe(3);
  });

  it('delta: buys positive, sells negative', () => {
    expect(signedQty('buy', 0.25)).toBe(0.25);
    expect(signedQty('sell', 0.25)).toBe(-0.25);
    const p = buildProfile(new Map([[1, 1]]), new Map([[1, -0.5], [2, 0.75]]));
    expect(p.maxAbsDelta).toBe(0.75);
  });
});
