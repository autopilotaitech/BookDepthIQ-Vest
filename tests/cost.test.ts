import { describe, expect, it } from 'vitest';
import { edgeRatio, roundTrip, spreadGate, walkBook } from '../src/panel/cost.js';

// NQ in 0.25 ticks: bid 31250.00 (125000), ask 31251.25 (125005) — a 5-tick Vest-like spread.
const bids = { ticks: [125000, 124999, 124998], sizes: [0.05, 0.1, 1] };
const asks = { ticks: [125005, 125006, 125007], sizes: [0.05, 0.1, 1] };

describe('walkBook', () => {
  it('size inside the best level: no slippage', () => {
    const f = walkBook(asks, 0.04)!;
    expect(f.avgTicks).toBe(125005);
    expect(f.slipTicks).toBe(0);
    expect(f.levels).toBe(1);
    expect(f.complete).toBe(true);
  });

  it('size spanning levels: average and slippage', () => {
    // 0.05 @ 125005 + 0.05 @ 125006 → avg 125005.5
    const f = walkBook(asks, 0.1)!;
    expect(f.avgTicks).toBeCloseTo(125005.5);
    expect(f.slipTicks).toBeCloseTo(0.5);
    expect(f.worstTicks).toBe(125006);
    expect(f.levels).toBe(2);
  });

  it('thin book: incomplete; empty side or zero size: undefined', () => {
    expect(walkBook(asks, 5)!.complete).toBe(false);
    expect(walkBook({ ticks: [], sizes: [] }, 1)).toBeUndefined();
    expect(walkBook(asks, 0)).toBeUndefined();
  });
});

describe('roundTrip / break-even', () => {
  it('buy 0.04: cross 5 ticks = 1.25 pts, plus fees', () => {
    const r = roundTrip(bids, asks, 'buy', 0.04, 0.25, 0.000025)!;
    expect(r.crossPts).toBeCloseTo(1.25);
    const fees = 2 * 0.04 * 31251.25 * 0.000025; // 0.0625025
    expect(r.feesUsd).toBeCloseTo(fees, 9);
    expect(r.totalUsd).toBeCloseTo(1.25 * 0.04 + fees, 9);
    expect(r.breakEvenPts).toBeCloseTo(1.25 + fees / 0.04, 9);
  });

  it('sell walks the bid to enter and the ask to exit', () => {
    const r = roundTrip(bids, asks, 'sell', 0.1, 0.25, 0)!;
    expect(r.entry.avgTicks).toBeCloseTo(124999.5);
    expect(r.exit.avgTicks).toBeCloseTo(125005.5);
    expect(r.crossPts).toBeCloseTo(1.5);
  });
});

describe('spread gate and edge ratio', () => {
  it('cheap ≤ median, normal ≤ p90, wide above; unknown without history', () => {
    expect(spreadGate(4, 5, 6)).toBe('cheap');
    expect(spreadGate(5, 5, 6)).toBe('cheap');
    expect(spreadGate(6, 5, 6)).toBe('normal');
    expect(spreadGate(7, 5, 6)).toBe('wide');
    expect(spreadGate(4, undefined, 6)).toBeUndefined();
  });

  it('edge ratio = TP pts / break-even pts', () => {
    expect(edgeRatio(5, 1.6)).toBeCloseTo(3.125);
    expect(edgeRatio(0, 1.6)).toBeUndefined();
    expect(edgeRatio(5, undefined)).toBeUndefined();
  });
});
