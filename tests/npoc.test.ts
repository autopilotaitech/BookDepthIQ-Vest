import { describe, expect, it } from 'vitest';
import { NakedPocTracker } from '../src/panel/npoc.js';
import { LiquidityTracker } from '../src/panel/liquidity.js';

const M = 60_000;

describe('naked POC (same cases as BookDepthIQ-NT)', () => {
  it("each period's POC becomes naked until price trades there again", () => {
    const n = new NakedPocTracker(15);
    n.onPrint(0, 100, 5); n.onPrint(M, 101, 2); n.onPrint(2 * M, 100, 3); n.onPrint(3 * M, 102, 1);
    expect(n.levels).toEqual([]);
    n.onPrint(15 * M, 105, 4); n.onPrint(16 * M, 106, 1);
    expect(n.levels.map((l) => l.ticks)).toEqual([100]);
    n.onPrint(30 * M, 103, 1);
    expect(n.levels.map((l) => l.ticks)).toEqual([100, 105]);
    n.onPrint(31 * M, 100, 1); // price returns: auction finished, no longer naked
    expect(n.levels.map((l) => l.ticks)).toEqual([105]);
  });
  it('prints inside its own period do not fill it; ties go to the VWAP', () => {
    const n = new NakedPocTracker(5);
    n.onPrint(0, 100, 2); n.onPrint(1, 104, 2); n.onPrint(2, 102, 1); n.onPrint(3, 103, 1);
    n.onPrint(5 * M, 110, 1);
    expect(n.levels.map((l) => l.ticks)).toEqual([104]);
  });
  it('heat window options scale bins and pull/stack', () => {
    const l = new LiquidityTracker(60 * M);
    expect(l.binMs).toBe(2 * M);
    expect(l.flowMs).toBe(12 * M);
    expect(new LiquidityTracker().flowMs).toBe(M); // default 5 min: pull/stack over 1 min, as before
  });
});
