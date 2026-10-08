import { describe, expect, it } from 'vitest';
import {
  leverageUsed,
  marginUsed,
  failFloor,
  failPrice,
  maxUnits,
  preTradeCheck,
  riskUsd,
  tradingPower,
  unitsForNotional,
  unitsForRisk,
} from '../src/sim/account.js';

// Numbers from a live Vest screen, 2026-10-07: Instant $500 account, account value $506.37,
// max drawdown $10, leverage 25x, trading power $12.64K, NQ mid $31,455.37.
const ACCT = { startEquity: 506.37, maxDrawdownUsd: 10, leverage: 25 };
const PX = 31455.37;

describe('trading power and size', () => {
  it('matches the Vest ticket: $506.37 × 25 = $12.66K', () => {
    expect(tradingPower(506.37, 25)).toBeCloseTo(12659.25);
  });

  it('max size on that account is ~0.40 units (0.02 NQ)', () => {
    expect(maxUnits(506.37, 25, PX)).toBeCloseTo(0.4025, 3);
  });

  it('size helpers round DOWN to the 4-decimal size step', () => {
    expect(unitsForNotional(12659.25, PX, 4)).toBe(0.4024);
    // $5 risk over a 10-tick (2.5 pt) stop = 2 units
    expect(unitsForRisk(5, 10, 0.25, 4)).toBe(2);
    expect(unitsForRisk(5, 0, 0.25, 4)).toBe(0);
  });

  it('risk is units × stop distance in points', () => {
    expect(riskUsd(0.4, 16, 0.25)).toBeCloseTo(1.6);
  });
});

describe('fail price (drawdown floor, not exchange liquidation)', () => {
  const floor = failFloor(ACCT);

  it('floor is start equity minus max drawdown', () => {
    expect(floor).toBeCloseTo(496.37);
  });

  it('a max-size long fails ~25 points below entry on a $10 drawdown', () => {
    // 0.4 units × 25 pts = $10
    expect(failPrice(0.4, 31455, 506.37, floor)).toBeCloseTo(31430);
  });

  it('a short fails above entry', () => {
    expect(failPrice(-0.4, 31455, 506.37, floor)).toBeCloseTo(31480);
  });

  it('undefined when flat or already at the floor', () => {
    expect(failPrice(0, 31455, 506.37, floor)).toBeUndefined();
    expect(failPrice(0.4, 31455, floor, floor)).toBeUndefined();
  });
});

describe('pre-trade check', () => {
  const base = { price: PX, equity: 506.37, leverage: 25, failed: false };

  it('refuses an entry beyond trading power, and says the max', () => {
    const r = preTradeCheck({ ...base, side: 'buy', units: 2, positionQty: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/max 0\.40\d\du/);
  });

  it('allows an entry inside trading power', () => {
    expect(preTradeCheck({ ...base, side: 'buy', units: 0.4, positionQty: 0 }).ok).toBe(true);
  });

  it('counts the existing position when adding', () => {
    expect(preTradeCheck({ ...base, side: 'buy', units: 0.2, positionQty: 0.3 }).ok).toBe(false);
  });

  it('never refuses an order that only reduces, even on a failed account', () => {
    expect(preTradeCheck({ ...base, side: 'sell', units: 0.3, positionQty: 0.4, failed: true }).ok).toBe(true);
  });

  it('a flip through zero is an entry and is checked', () => {
    expect(preTradeCheck({ ...base, side: 'sell', units: 3, positionQty: 0.4 }).ok).toBe(false);
  });

  it('a failed account refuses new entries', () => {
    expect(preTradeCheck({ ...base, side: 'buy', units: 0.1, positionQty: 0, failed: true }).ok).toBe(false);
  });
});

describe('leverage in use', () => {
  it('is notional ÷ equity, like Vest\'s header', () => {
    // 0.3u at 31,455 = $9,436.50 on $506.37 equity ≈ 18.6x of the 25x allowed
    expect(leverageUsed(0.3 * 31455, 506.37)).toBeCloseTo(18.64, 2);
    expect(leverageUsed(0, 506.37)).toBe(0);
    expect(leverageUsed(1000, 0)).toBe(0);
  });

  it('margin tied up is notional ÷ order leverage', () => {
    expect(marginUsed(9436.5, 25)).toBeCloseTo(377.46, 2);
    expect(marginUsed(9436.5, 0)).toBe(0);
  });
});
