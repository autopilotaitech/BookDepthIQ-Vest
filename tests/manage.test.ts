import { describe, expect, it } from 'vitest';
import { StopGuard, TrailBook, trailTarget, weekendCloseAt } from '../src/live/manage.js';
import { dayCheck, dayLimitHit, riskWithFees, tradingDay, unitsForRiskWithFees } from '../src/panel/protect.js';

describe('trailing stop', () => {
  it('waits for startR × risk, then keeps one risk behind the best price, only forward', () => {
    // long from 100, risk 10 ticks, start at 2R
    expect(trailTarget(true, 100, 10, 119, 2, 90)).toBeUndefined();
    expect(trailTarget(true, 100, 10, 120, 2, 90)).toBe(110);
    expect(trailTarget(true, 100, 10, 120, 2, 110)).toBeUndefined(); // already there
    expect(trailTarget(true, 100, 10, 125, 2, 110)).toBe(115);
    // short from 100
    expect(trailTarget(false, 100, 10, 85, 1.5, 110)).toBe(95);
    expect(trailTarget(false, 100, 10, 86, 1.5, 110)).toBeUndefined();
  });

  it('TrailBook keeps the best price; a pullback never moves the stop back', () => {
    const t = new TrailBook();
    t.arm('X', 10, 1);
    expect(t.onTrade('X', true, 100, 112, 90)).toBe(102);
    expect(t.onTrade('X', true, 100, 105, 102)).toBeUndefined();
    expect(t.onTrade('X', true, 100, 115, 102)).toBe(105);
    expect(t.onTrade('Y', true, 100, 200, 90)).toBeUndefined(); // not armed
  });
});

describe('stop recovery', () => {
  it('re-places a stop that vanished, after two reads ≥ 3 s apart; leaves never-stopped positions alone', () => {
    const g = new StopGuard(3000, 10_000);
    expect(g.check([{ positionId: 'P', stop: 31440 }, { positionId: 'Q', stop: undefined }], 0)).toEqual([]);
    expect(g.check([{ positionId: 'P', stop: undefined }, { positionId: 'Q', stop: undefined }], 1000)).toEqual([]);
    expect(g.check([{ positionId: 'P', stop: undefined }], 4500)).toEqual([{ positionId: 'P', stop: 31440 }]);
    expect(g.check([{ positionId: 'P', stop: undefined }], 6000)).toEqual([]); // retry later, not every poll
    expect(g.check([{ positionId: 'P', stop: undefined }], 15_000)).toEqual([{ positionId: 'P', stop: 31440 }]);
  });

  it('forgets closed positions', () => {
    const g = new StopGuard(0, 0);
    g.check([{ positionId: 'P', stop: 1 }], 0);
    g.check([], 1);
    expect(g.check([{ positionId: 'P', stop: undefined }], 2)).toEqual([]);
  });
});

describe('weekend close', () => {
  const H = 3600_000;
  const open = (a: number, b: number) => ({ fromMs: a, toMs: b, state: { tradingStatus: 'OPEN' } });
  const shut = (a: number, b: number) => ({ fromMs: a, toMs: b, state: { tradingStatus: 'CLOSED' } });
  it('5 min before a close that is followed by 24 h+ of no trading', () => {
    // open until hour 10, closed 49 h (weekend), open again
    expect(weekendCloseAt([open(0, 10 * H), shut(10 * H, 59 * H), open(59 * H, 80 * H)], 5 * H, 72 * H)).toBe(10 * H - 5 * 60_000);
  });
  it('nothing for the daily one-hour break, crypto, or a closed market', () => {
    expect(weekendCloseAt([open(0, 10 * H), shut(10 * H, 11 * H), open(11 * H, 34 * H)], 5 * H, 72 * H)).toBeUndefined();
    expect(weekendCloseAt([open(0, 72 * H)], 5 * H, 72 * H)).toBeUndefined();
    expect(weekendCloseAt([shut(0, 20 * H), open(20 * H, 30 * H)], 5 * H, 72 * H)).toBeUndefined();
  });
  it('merges back-to-back open rows', () => {
    expect(weekendCloseAt([open(0, 5 * H), open(5 * H, 10 * H), shut(10 * H, 60 * H)], 1 * H, 72 * H)).toBe(10 * H - 5 * 60_000);
  });
});

describe('protect my day', () => {
  const lim = { lossUsd: 50, maxTrades: 3, cooldownSec: 60 };
  const st = { day: 'd', startEquity: 500, trades: 0 };
  it('passes a trade that fits the room left', () => {
    expect(dayCheck(lim, st, 480, 0, 20).ok).toBe(true);
  });
  it('locks at the daily loss, the trade cap, and during the cooldown', () => {
    expect(dayCheck(lim, st, 450, 0, 5).ok).toBe(false);
    expect(dayCheck(lim, { ...st, trades: 3 }, 500, 0, 5).message).toMatch(/3\/3 trades/);
    expect(dayCheck(lim, { ...st, lastLossAt: 0 }, 500, 30_000, 5).message).toMatch(/cooldown.*30 s/);
    expect(dayCheck(lim, { ...st, lastLossAt: 0 }, 500, 61_000, 5).ok).toBe(true);
  });
  it('a trade risking more than the room left is refused, with the room to size to', () => {
    const v = dayCheck(lim, st, 480, 0, 40);
    expect(v.ok).toBe(false);
    expect(v.roomUsd).toBeCloseTo(30);
  });
  it('everything off = always ok, even without a stop', () => {
    expect(dayCheck({ lossUsd: 0, maxTrades: 0, cooldownSec: 0 }, st, 1, 0, undefined).ok).toBe(true);
    expect(dayLimitHit(lim, st, 449)).toBe(true);
    expect(dayLimitHit(lim, st, 451)).toBe(false);
  });
  it('risk sizing counts the taker fee both ways', () => {
    // NQ: stop 20 ticks × 0.25 = 5 pts; fee 0.000025 × 31450 × 2 = 1.5725 → 6.5725 $/unit
    const u = unitsForRiskWithFees(50, 20, 0.25, 31450, 0.000025, 4);
    expect(u).toBe(7.6074);
    expect(riskWithFees(u, 20, 0.25, 31450, 0.000025)).toBeLessThanOrEqual(50);
  });
  it('the trading day rolls at 17:00 Chicago', () => {
    // 2026-10-12 21:59 UTC = 16:59 CDT → day 10-12; 22:00 UTC = 17:00 CDT → day 10-13
    expect(tradingDay(Date.UTC(2026, 9, 12, 21, 59))).toBe('2026-10-12');
    expect(tradingDay(Date.UTC(2026, 9, 12, 22, 0))).toBe('2026-10-13');
  });
});

describe('SuperTrend trail', () => {
  it('stop sits on the chosen line while it is on your side, only forward, ignores a flipped line', async () => {
    const { lineTrailTarget } = await import('../src/live/manage.js');
    expect(lineTrailTarget(true, { ticks: 95, dir: 'up' }, 90)).toBe(95);
    expect(lineTrailTarget(true, { ticks: 93, dir: 'up' }, 95)).toBeUndefined(); // never back
    expect(lineTrailTarget(true, { ticks: 99, dir: 'down' }, 95)).toBeUndefined(); // flipped
    expect(lineTrailTarget(false, { ticks: 105, dir: 'down' }, 110)).toBe(105);
    expect(lineTrailTarget(true, undefined, 90)).toBeUndefined();
  });
  it('TrailBook follows ST1 or ST2, whichever was picked', () => {
    const t = new TrailBook();
    t.arm('X', 10, 0, 2);
    const lines = { 1: { ticks: 96, dir: 'up' as const }, 2: { ticks: 98, dir: 'up' as const } };
    expect(t.onTrade('X', true, 100, 101, 90, lines)).toBe(98);
    t.arm('Y', 10, 0, 1);
    expect(t.onTrade('Y', true, 100, 101, 90, lines)).toBe(96);
  });
});
