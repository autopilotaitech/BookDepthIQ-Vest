import { describe, expect, it } from 'vitest';
import { failPtsAtLev, inGroup, marketLevCap, riskCalc, type RiskInput } from '../src/panel/riskcalc.js';

// $500 Instant on NQ at 32,000: fails $10 down, 25x account cap, NQ fee 0.0025%.
const base: RiskInput = { balance: 500, room: 10, levCap: 25, price: 32000, feeRate: 0, stopPts: 20, targetPts: 40, mode: 'risk', riskUsd: 5, lev: 10, sizeDecimals: 4 };

describe('riskCalc', () => {
  it('sizes from the $ risk at the stop', () => {
    const r = riskCalc(base);
    expect(r.units).toBe(0.25); // $5 / 20 pts
    expect(r.loss).toBeCloseTo(5);
    expect(r.win).toBeCloseTo(10);
    expect(r.rr).toBeCloseTo(2);
    expect(r.levUsed).toBeCloseTo(16); // 0.25 × 32,000 / 500
    expect(r.failPts).toBeCloseTo(40); // $10 room / 0.25
    expect(r.losersLeft).toBe(2);
    expect(r.roomUsed).toBeCloseTo(0.5);
    expect(r.stopPastFail).toBe(false);
    expect(r.levStopFails).toBeCloseTo(32); // above 32x a 20-pt stop is past the fail line
  });

  it('counts the taker fee both ways', () => {
    const r = riskCalc({ ...base, feeRate: 0.000025 }); // 2 × 32,000 × 0.0025% = 1.6 pts per unit
    expect(r.units).toBe(0.2314); // 5 / 21.6, rounded down
    expect(r.loss).toBeLessThanOrEqual(5);
  });

  it('caps at the leverage limit and says so', () => {
    const r = riskCalc({ ...base, stopPts: 2 }); // wants 2.5 u, max is 500 × 25 / 32,000
    expect(r.capped).toBe(true);
    expect(r.units).toBe(0.3906);
    expect(r.stopPastFail).toBe(false);
  });

  it('flags a stop past the fail line', () => {
    const r = riskCalc({ ...base, mode: 'lev', lev: 25, stopPts: 30 });
    expect(r.units).toBe(0.3906);
    expect(r.failPts).toBeCloseTo(25.6, 1);
    expect(r.stopPastFail).toBe(true);
  });

  it('leverage mode never goes over the cap', () => {
    expect(riskCalc({ ...base, mode: 'lev', lev: 100 }).units).toBe(0.3906);
  });

  it('no stop, no risk size', () => {
    expect(riskCalc({ ...base, stopPts: 0 }).units).toBe(0);
  });
});

describe('helpers', () => {
  it('fail distance shrinks with leverage', () => {
    expect(failPtsAtLev(500, 10, 32000, 1)).toBeCloseTo(640);
    expect(failPtsAtLev(500, 10, 32000, 25)).toBeCloseTo(25.6);
  });
  it('market cap = floor(1 / IMR), capped by the account', () => {
    expect(marketLevCap('0.02', undefined)).toBe(50);
    expect(marketLevCap('0.013333', undefined)).toBe(75); // ES-PERP
    expect(marketLevCap('0.1', 25)).toBe(10); // CL-PERP
    expect(marketLevCap('0.02', 25)).toBe(25);
  });
  it('groups', () => {
    expect(inGroup('GC', 'fut')).toBe(true);
    expect(inGroup('BTC', 'fut')).toBe(false);
    expect(inGroup('BTC', 'crypto')).toBe(true);
    expect(inGroup('AAPL', 'all')).toBe(true);
  });
});
