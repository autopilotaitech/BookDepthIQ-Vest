import { describe, expect, it } from 'vitest';
import type { Book } from '../src/book/book.js';
import { BIN_MS, LiquidityTracker } from '../src/panel/liquidity.js';
import { feedHealth, needsConfirm, percentiles, tradeChecks } from '../src/panel/checks.js';
import { Blotter, describeWrite } from '../src/live/blotter.js';
import { MemStore, Player, Recorder, chunkKey, listSessions, type Rec } from '../src/panel/replay.js';
import type { DepthMsg, TradeMsg } from '../src/vest/types.js';

const book = (bids: Array<[number, number]>, asks: Array<[number, number]>): Book => ({
  bids: { ticks: bids.map((b) => b[0]), sizes: bids.map((b) => b[1]) },
  asks: { ticks: asks.map((a) => a[0]), sizes: asks.map((a) => a[1]) },
  tsMs: 0,
});

describe('liquidity: heat, pull/stack, absorb', () => {
  /** A 6-level book (bids 100..95, asks 101..106), size 10 each, with overrides. */
  const deep = (o: Record<number, number> = {}) =>
    book(
      [100, 99, 98, 97, 96, 95].map((t) => [t, o[t] ?? 10] as [number, number]),
      [101, 102, 103, 104, 105, 106].map((t) => [t, o[t] ?? 10] as [number, number]),
    );

  it('size that leaves without trading is pulled; size that arrives is stacked', () => {
    const l = new LiquidityTracker();
    l.onBook(deep(), 0);
    l.onTrade(101, 3); // 3 traded at 101
    l.onBook(deep({ 100: 14, 101: 2 }), 1000); // 101 lost 8: 3 traded, 5 pulled; 100 gained 4
    expect(l.flow(101)).toMatchObject({ pulled: 5, traded: 3, net: -5 });
    expect(l.flow(100)).toMatchObject({ stacked: 4, net: 4 });
  });

  it('the outermost levels (they flicker in and out of view) are left out', () => {
    const l = new LiquidityTracker();
    l.onBook(deep(), 0);
    l.onBook(deep({ 95: 40, 106: 0 }), 1000);
    expect(l.flow(95).net).toBe(0);
    expect(l.flow(106).net).toBe(0);
  });

  it('ABSORB bid: sellers hit 100 for more than was showing, it held and still has size', () => {
    const l = new LiquidityTracker();
    l.onBook(deep(), 0); // 10 showing at 100
    for (let k = 1; k <= 4; k++) {
      l.onTrade(100, 4, 'sell', k * 1000); // 16 sold into a bid showing 10
      l.onBook(deep(), k * 1000 + 500); // refilled each time
    }
    expect(l.absorb(100, 1, 5)).toBe('bid');
  });

  it('no ABSORB when price trades through, when it traded less than was showing, or when both sides traded', () => {
    const through = new LiquidityTracker();
    through.onBook(deep(), 0);
    for (let k = 1; k <= 4; k++) through.onTrade(100, 4, 'sell', k * 1000);
    through.onTrade(99, 1, 'sell', 5000); // broke below
    expect(through.absorb(100, 1, 5)).toBeUndefined();
    const small = new LiquidityTracker();
    small.onBook(deep({ 100: 40 }), 0);
    for (let k = 1; k <= 4; k++) small.onTrade(100, 4, 'sell', k * 1000); // 16 < 1.5 x 40
    expect(small.absorb(100, 1, 5)).toBeUndefined();
    const both = new LiquidityTracker();
    both.onBook(deep(), 0);
    for (let k = 1; k <= 4; k++) both.onTrade(100, 4, k % 2 ? 'sell' : 'buy', k * 1000);
    expect(both.absorb(100, 1, 5)).toBeUndefined();
  });

  it('constant re-quoting alone never reads as ABSORB', () => {
    const l = new LiquidityTracker();
    l.onBook(deep(), 0);
    for (let k = 1; k <= 20; k++) l.onBook(deep({ 100: k % 2 ? 0 : 30 }), k * 200);
    l.onTrade(100, 6, 'sell', 4100);
    expect(l.absorb(100, 1, 5)).toBeUndefined(); // 6 sold, but 30 was showing
  });

  it('heat keeps one bin per 10 s, scaled to the largest size', () => {
    const l = new LiquidityTracker();
    l.onBook(book([[100, 5]], []), 0);
    l.onBook(book([[100, 10]], []), BIN_MS);
    l.onBook(book([[100, 0]], []), 2 * BIN_MS);
    const h = l.heat(100);
    expect(h.at(-1)).toBe(0);
    expect(Math.max(...h)).toBe(1);
  });
});

describe('fat-finger checks and health', () => {
  const base = { units: 1, normalUnits: 1, sizeMult: 2, distTicks: undefined, farTicks: 40, gate: 'cheap', spreadTicks: 4, slTicks: 40, bracketsOn: true, tick: 0.25 };
  it('all fine → no second click', () => {
    expect(needsConfirm(tradeChecks(base))).toBe(false);
  });
  it('big size, far price, wide spread warn; a stop inside the spread is bad', () => {
    expect(tradeChecks({ ...base, units: 3 }).find((c) => c.level === 'warn')?.text).toMatch(/3.0× your normal/);
    expect(tradeChecks({ ...base, distTicks: -60 }).some((c) => c.level === 'warn' && /15.00 pts from the market/.test(c.text))).toBe(true);
    expect(tradeChecks({ ...base, gate: 'wide' }).some((c) => c.level === 'warn')).toBe(true);
    expect(tradeChecks({ ...base, slTicks: 2 }).some((c) => c.level === 'bad')).toBe(true);
  });
  it('feed health', () => {
    expect(feedHealth(500, true)).toBe('live');
    expect(feedHealth(3000, true)).toBe('slow');
    expect(feedHealth(9000, true)).toBe('stale');
    expect(feedHealth(100, false)).toBe('stale');
    expect(percentiles([100, 80, 90, 300, 95])).toEqual({ p50: 95, p95: 300 });
  });
});

describe('order blotter', () => {
  it('describes each write by its path and body', () => {
    expect(describeWrite('/v3/positions/open', { orderType: 'limit', side: 'short', quantity: '0.3', price: '30911.5', symbol: 'NDX-USD-PERP' })).toMatchObject({ kind: 'LIMIT', side: 'sell', qty: '0.3', price: '30911.5' });
    expect(describeWrite('/v3/positions/append', { isBuy: true, quantity: '0.1', price: '1' }).kind).toBe('APPEND');
    expect(describeWrite('/v3/positions/stop-loss', { stopLossId: 'S1', triggerPrice: '2' }).kind).toBe('STOP MOVE');
    expect(describeWrite('/v3/positions/cancel-order', { orderId: 'X' }).kind).toBe('CANCEL');
  });
  it('SENT → ACKED → WORKING → FILLED; REJECTED keeps the reason; NO ANSWER after 3 s', () => {
    const b = new Blotter();
    const id = b.sent(0, { kind: 'LIMIT', side: 'sell' });
    b.answered(id, 84, true, { orderId: 'O1' });
    expect(b.rows[0]).toMatchObject({ status: 'ACKED', ackMs: 84 });
    b.reconcile(new Set(['O1']), false, 1000);
    expect(b.rows[0]!.status).toBe('WORKING');
    b.reconcile(new Set(), true, 2000);
    expect(b.rows[0]!.status).toBe('FILLED');
    const r = b.sent(3000, { kind: 'MARKET' });
    b.answered(r, 3100, false, { error: 'exceeds trading power' });
    expect(b.rows[0]).toMatchObject({ status: 'REJECTED', note: 'exceeds trading power' });
    b.sent(4000, { kind: 'LIMIT' });
    b.reconcile(new Set(), false, 7100);
    expect(b.rows[0]!.status).toBe('NO ANSWER');
  });
});

describe('record and replay', () => {
  const depth = (t: number): Rec => ({ t, k: 'd', m: { channel: 'X@depth', data: { bids: [], asks: [] }, tsMs: t } as DepthMsg });
  const trade = (t: number, px: string): Rec => ({ t, k: 't', m: { channel: 'X@trades', data: { id: String(t), price: px, qty: '1', quoteQty: '1', side: 'buy', time: t } } as TradeMsg });
  const T0 = 1_791_000_000_000 - (1_791_000_000_000 % 60_000);

  it('recorder keeps one chunk per minute, thins depth, and sessions group the minutes', async () => {
    const st = new MemStore();
    const r = new Recorder(st, 250);
    r.add('X', depth(T0));
    r.add('X', depth(T0 + 100)); // thinned (< 250 ms)
    r.add('X', trade(T0 + 200, '1'));
    r.add('X', trade(T0 + 61_000, '2')); // next minute
    await r.flush();
    expect((await st.get(chunkKey('X', T0 / 60_000))).length).toBe(2);
    const s = listSessions(await st.keys());
    expect(s).toEqual([{ symbol: 'X', from: T0, to: T0 + 120_000, minutes: 2 }]);
  });

  it('player emits in time order and seek replays up to the target at once', async () => {
    const st = new MemStore();
    await st.put(chunkKey('X', T0 / 60_000), [trade(T0 + 2000, '2'), trade(T0 + 1000, '1')]);
    await st.put(chunkKey('X', T0 / 60_000 + 1), [trade(T0 + 61_000, '3')]);
    const seen: string[] = [];
    let resets = 0;
    const timers: Array<() => void> = [];
    const p = new Player(st, { symbol: 'X', from: T0, to: T0 + 120_000, minutes: 2 }, {
      emit: (r) => seen.push((r.m as TradeMsg).data.price),
      reset: () => resets++,
      tick: () => {},
      done: () => seen.push('done'),
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
    });
    p.play();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 0));
      timers.shift()?.();
    }
    expect(seen).toEqual(['1', '2', '3', 'done']);
    seen.length = 0;
    await p.seek(T0 + 1500);
    expect(resets).toBe(1);
    expect(seen).toEqual(['1']);
  });
});

describe('pull/stack noise filter', () => {
  it('re-quoting churn with a small net is not a signal; a real pull is', () => {
    const b = (s100: number, s99: number) => book([[100, s100], [99, s99], [98, 10], [97, 10], [96, 10], [95, 10]], [[101, 10], [102, 10], [103, 10], [104, 10], [105, 10], [106, 10]]);
    const l = new LiquidityTracker();
    l.onBook(b(10, 10), 0);
    for (let k = 1; k <= 10; k++) l.onBook(b(k % 2 ? 0 : 10, 10), k * 200); // 100 flickers 10 ↔ 0
    expect(l.flow(100).signal).toBe(false);
    l.onBook(b(10, 0), 3000); // 99 pulled for real
    expect(l.flow(99)).toMatchObject({ net: -10, signal: true });
  });
});
