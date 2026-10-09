import { describe, expect, it } from 'vitest';
import { StopBook } from '../src/live/stops.js';

const base = { symbol: 'NDX-USD-PERP', units: 0.1, bracketsOn: true, tpTicks: 40, slTicks: 20, armedAt: 0 };
const BID = 1000;
const ASK = 1005;

describe('StopBook', () => {
  it('buy stop must be above the ask, sell stop below the bid', () => {
    const b = new StopBook();
    expect(b.arm({ ...base, side: 'buy', ticks: 1005 }, BID, ASK).ok).toBe(false);
    expect(b.arm({ ...base, side: 'sell', ticks: 1000 }, BID, ASK).ok).toBe(false);
    expect(b.arm({ ...base, side: 'buy', ticks: 1010 }, BID, ASK).ok).toBe(true);
    expect(b.arm({ ...base, side: 'sell', ticks: 990 }, BID, ASK).ok).toBe(true);
    expect(b.arm({ ...base, side: 'buy', ticks: 1010 }, undefined, ASK).ok).toBe(false);
    expect(b.size).toBe(2);
  });

  it('fires once on a trade at or through the stop, only for its symbol', () => {
    const b = new StopBook();
    b.arm({ ...base, side: 'buy', ticks: 1010 }, BID, ASK);
    b.arm({ ...base, side: 'sell', ticks: 990 }, BID, ASK);
    expect(b.onTrade('NDX-USD-PERP', 1009)).toEqual([]);
    expect(b.onTrade('SPX-USD-PERP', 1020)).toEqual([]); // other symbol
    const f = b.onTrade('NDX-USD-PERP', 1010);
    expect(f.map((s) => s.side)).toEqual(['buy']);
    expect(b.onTrade('NDX-USD-PERP', 1011)).toEqual([]); // one-shot
    expect(b.onTrade('NDX-USD-PERP', 985).map((s) => s.side)).toEqual(['sell']);
    expect(b.size).toBe(0);
  });

  it('cancel, move (refused if it would fire at once) and clear', () => {
    const b = new StopBook();
    const s = b.arm({ ...base, side: 'buy', ticks: 1010 }, BID, ASK).stop!;
    expect(b.move(s.id, 1003, BID, ASK).ok).toBe(false);
    expect(b.list()[0]!.ticks).toBe(1010);
    expect(b.move(s.id, 1020, BID, ASK).ok).toBe(true);
    expect(b.list()[0]!.ticks).toBe(1020);
    expect(b.cancel(s.id)).toBe(true);
    b.arm({ ...base, side: 'buy', ticks: 1010 }, BID, ASK);
    b.arm({ ...base, symbol: 'SPX-USD-PERP', side: 'buy', ticks: 1010 }, BID, ASK);
    expect(b.clear('NDX-USD-PERP')).toBe(1);
    expect(b.clear()).toBe(1);
  });
});
