import { describe, expect, it } from 'vitest';
import { LiveSession, type MarketCtx } from '../src/live/session.js';
import { bracketTicks, breakevenTicks, liveEntryCheck, reanchorPlan, resolveLeverage, type LiveEntryInput } from '../src/live/rules.js';
import { VestTrading, type FetchLike } from '../src/vest/trading.js';
import {
  decimalString,
  decodeJwtClaims,
  isUserTokenClaims,
  openLimitBody,
  openMarketBody,
  priceString,
  qtyString,
  readOrders,
  readPositions,
  redact,
} from '../src/vest/tradingShapes.js';
import type { SymbolInfo } from '../src/vest/types.js';

// Offline tests for the LIVE order path (LIVE-ORDERS-SPEC §6.1). Nothing here touches the network:
// every request goes to a fake fetch that records it.
//
// The expected request bodies are the UNVERIFIED shapes from LIVE-ORDERS-SPEC §3. No HAR was
// captured; the owner checks them on §6.2 / §6.3 against the panel's request log. When the real shapes
// are known, update tradingShapes.ts and these expectations together.

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;

const NOW = 1_791_000_000_000;
const USER = jwt({ userId: 42, exp: NOW / 1000 + 3600 });
const ACCT = jwt({ userId: 42, accountId: 'A1', canTrade: true, exp: NOW / 1000 + 900 });

const NQ: SymbolInfo = {
  symbol: 'NDX-USD-PERP',
  displaySymbol: 'NQ-PERP',
  sizeDecimals: 4,
  priceDecimals: 2,
  minTickSize: '0.25',
  initMarginRatio: '0.02',
};

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c: Call = {
      method: init.method,
      path: url.replace('https://api-gateway.hz.vestmarkets.com', ''),
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(c);
    const r = handler(c) ?? {};
    const status = r.status ?? 200;
    const h = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return { fetch, calls };
}

/** A Vest that answers the read endpoints with one $506 account and the given positions. */
function vest(opts: { positions?: unknown[]; orders?: unknown[]; canTrade?: boolean; failPositions?: boolean } = {}): Handler {
  return (c) => {
    switch (`${c.method} ${c.path}`) {
      case 'POST /v3/auth/account-token':
        return { body: { accessToken: opts.canTrade === false ? jwt({ accountId: 'A1', canTrade: false }) : ACCT, accessExpiresAtMs: NOW + 900_000 } };
      case 'GET /v3/capital/accounts/active':
        return { body: [{ id: 'A1', initial_capital: '500', max_drawdown_limit: '496.37', max_leverage: '25' }] };
      case 'GET /v3/accounts':
        return { body: [{ account_id: 'A1', amount: '506.37' }] };
      case 'GET /v3/user-state':
        return { body: { accounts: [{ accountId: 'A1', leverages: [{ symbol: 'NDX-USD-PERP', leverage: '25' }] }] } };
      case 'GET /v3/positions/opened':
        return opts.failPositions ? { status: 503, body: { msg: 'down' } } : { body: opts.positions ?? [] };
      case 'GET /v3/positions/opened-orders':
        return { body: opts.orders ?? [] };
      case 'POST /v3/positions/open':
        return { body: { positionId: 'P1', orderId: 'O1', takeProfitIds: ['T1'], stopLossIds: ['S1'] } };
      default:
        return { body: { ok: true } };
    }
  };
}

let uuidN = 0;
function session(handler: Handler) {
  const f = fakeFetch(handler);
  let now = NOW;
  const s = new LiveSession({
    fetch: f.fetch,
    uuid: () => `uuid-${++uuidN}`,
    now: () => now,
    onChange: () => {},
    setTimer: () => null, // tests drive poll() by hand
    clearTimer: () => {},
  });
  s.setUserToken(USER);
  return { s, calls: f.calls, advance: (ms: number) => (now += ms) };
}

async function liveSession(handler: Handler) {
  const x = session(handler);
  expect((await x.s.connect()).ok).toBe(true);
  expect((await x.s.prepare()).ok).toBe(true);
  x.s.goLive();
  await x.s.poll();
  return x;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && c.path !== '/v3/auth/account-token');
// A resting limit BUY as Vest's opened-orders sends it (snake_case, per its web app's mapping).
const VEST_LIMIT = { order_id: 'L1', symbol: 'NDX-USD-PERP', side: 'buy', order_type: 'limit', price: '31440', quantity: '0.1', executed_quantity: '0', leverage: '25', reduce_only: false, time_in_force: 'GTC' };
// 31450.00 bid / 31451.00 ask, in 0.25 ticks.
const MKT: MarketCtx = { info: NQ, tick: 0.25, bid: 125800, ask: 125804 };
const LONG_POS = {
  positionId: 'P1',
  symbol: 'NDX-USD-PERP',
  side: 'long',
  quantity: '0.001',
  openPrice: '31451.25',
  takeProfits: [{ id: 'T1', triggerPrice: '31461' }],
  stopLosses: [{ id: 'S1', triggerPrice: '31446' }],
};

describe('number formatting (spec §3: strings, trailing zeros trimmed)', () => {
  it('trims zeros and never emits exponent or -0', () => {
    expect(decimalString(25, 0)).toBe('25');
    expect(decimalString(0.1, 4)).toBe('0.1');
    expect(decimalString(31450.75, 2)).toBe('31450.75');
    expect(decimalString(31450, 2)).toBe('31450');
    expect(decimalString(-0.00001, 2)).toBe('0');
    expect(qtyString(0.001, 4)).toBe('0.001');
    expect(qtyString(0.00004, 4)).toBe('0');
  });

  it('prices come from integer ticks and refuse to round onto another level', () => {
    expect(priceString(125803, 0.25, 2)).toBe('31450.75');
    expect(priceString(125800, 0.25, 2)).toBe('31450');
    expect(() => priceString(125803, 0.25, 1)).toThrow(/not representable/);
  });
});

describe('request bodies (UNVERIFIED spec §3 shapes)', () => {
  it('omits a bracket leg that is not set rather than sending an empty one', () => {
    expect(openLimitBody({ symbol: 'NDX-USD-PERP', side: 'short', quantity: '0.1', leverage: '25', price: '31500.25', stopLoss: '31505.25' })).toEqual({
      orderType: 'limit',
      leverage: '25',
      quantity: '0.1',
      price: '31500.25',
      symbol: 'NDX-USD-PERP',
      timeInForce: 'GTC',
      side: 'short',
      stopLosses: [{ executionType: 'market', triggerPrice: '31505.25' }],
    });
    const b = openMarketBody({ symbol: 'NDX-USD-PERP', side: 'long', quantity: '0.001', leverage: '25' });
    expect(b).toEqual({ orderType: 'market', leverage: '25', side: 'long', symbol: 'NDX-USD-PERP', quantity: '0.001', timeInForce: 'IOC' });
  });
});

describe('VestTrading HTTP client', () => {
  it('mints the account token with the USER token, then trades with the ACCOUNT token and a fresh Idempotency-Key', async () => {
    const f = fakeFetch(vest());
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => `k${++uuidN}`, now: () => NOW, log: () => {} });
    api.setAccount('A1');
    await api.cancel('X1');
    await api.cancel('X2');
    const [mint, c1, c2] = f.calls;
    expect(mint).toMatchObject({ method: 'POST', path: '/v3/auth/account-token', body: { accountId: 'A1' } });
    expect(mint!.headers.Authorization).toBe(`Bearer ${USER}`);
    expect(mint!.headers['Idempotency-Key']).toBeUndefined();
    for (const c of [c1!, c2!]) {
      expect(c.headers.Authorization).toBe(`Bearer ${ACCT}`);
      expect(c.headers['Content-Type']).toBe('application/json');
      expect(c.headers['Idempotency-Key']).toMatch(/^k\d+$/);
    }
    expect(c1!.headers['Idempotency-Key']).not.toBe(c2!.headers['Idempotency-Key']);
    expect(f.calls.filter((c) => c.path === '/v3/auth/account-token')).toHaveLength(1); // cached
  });

  it('re-mints within 60 s of expiry', async () => {
    let now = NOW;
    const f = fakeFetch(vest());
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => 'k', now: () => now, log: () => {} });
    api.setAccount('A1');
    await api.tokenStatus();
    now = NOW + 900_000 - 59_000;
    await api.tokenStatus();
    expect(f.calls.filter((c) => c.path === '/v3/auth/account-token')).toHaveLength(2);
  });

  it('reads positions and orders with the USER token, as the Vest page does', async () => {
    const f = fakeFetch(vest());
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => 'k', now: () => NOW, log: () => {} });
    api.setAccount('A1');
    await api.positions();
    await api.orders();
    expect(f.calls.filter((c) => c.path === '/v3/auth/account-token')).toHaveLength(0);
    for (const c of f.calls) expect(c.headers.Authorization).toBe(`Bearer ${USER}`);
  });

  it('canTrade: missing is allowed, explicit false refuses', async () => {
    const noClaim = fakeFetch((c) => (c.path === '/v3/auth/account-token' ? { body: { accessToken: jwt({ accountId: 'A1', exp: NOW / 1000 + 900 }) } } : vest()(c)));
    const api = new VestTrading({ fetch: noClaim.fetch, userToken: () => USER, uuid: () => 'k', now: () => NOW, log: () => {} });
    api.setAccount('A1');
    expect((await api.tokenStatus()).canTrade).toBe(true);
    const no = fakeFetch(vest({ canTrade: false }));
    const api2 = new VestTrading({ fetch: no.fetch, userToken: () => USER, uuid: () => 'k', now: () => NOW, log: () => {} });
    api2.setAccount('A1');
    expect((await api2.tokenStatus()).canTrade).toBe(false);
  });

  it('leverage: the saved value wins over a stale max_leverage', () => {
    expect(resolveLeverage(25, '0.02', 5)).toBe(25);
    expect(resolveLeverage(undefined, '0.02', 5)).toBe(5);
  });

  it('on 401 re-mints once and retries with the SAME Idempotency-Key', async () => {
    let first = true;
    const f = fakeFetch((c) => {
      if (c.path === '/v3/positions/cancel-order' && first) {
        first = false;
        return { status: 401, body: { msg: 'expired' } };
      }
      return vest()(c);
    });
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => `k${++uuidN}`, now: () => NOW, log: () => {} });
    api.setAccount('A1');
    await api.cancel('X1');
    const cancels = f.calls.filter((c) => c.path === '/v3/positions/cancel-order');
    expect(cancels).toHaveLength(2);
    expect(cancels[0]!.headers['Idempotency-Key']).toBe(cancels[1]!.headers['Idempotency-Key']);
    expect(f.calls.filter((c) => c.path === '/v3/auth/account-token')).toHaveLength(2);
  });

  it('logs every write as → request / ← status + body, and never a token', async () => {
    const lines: string[] = [];
    const f = fakeFetch(vest());
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => 'k1', now: () => NOW, log: (l) => lines.push(l) });
    api.setAccount('A1');
    await api.cancel('X1');
    const text = lines.join('\n');
    expect(text).toContain('→ POST /v3/positions/cancel-order {"orderId":"X1"} [idem k1]');
    expect(text).toContain('← 200');
    expect(text).toContain('"accessToken":"<redacted>"');
    expect(text).not.toContain(USER);
    expect(text).not.toContain(ACCT);
  });

  it('treats a 200 {code,msg} body as an error', async () => {
    const f = fakeFetch(() => ({ body: { code: 1121, msg: 'unknown symbol' } }));
    const api = new VestTrading({ fetch: f.fetch, userToken: () => USER, uuid: () => 'k', now: () => NOW, log: () => {} });
    await expect(api.activeAccounts()).rejects.toThrow(/1121/);
  });
});

describe('LIVE entry: BUY MKT with brackets', () => {
  it('sends the spec §3 body: wire symbol, string numbers, legs priced from the ASK', async () => {
    const { s, calls } = await liveSession(vest());
    const r = await s.enter('buy', 0.001, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    expect(r.ok).toBe(true);
    const [open] = writes(calls);
    expect(open).toMatchObject({ method: 'POST', path: '/v3/positions/open' });
    expect(open!.body).toEqual({
      orderType: 'market',
      leverage: '25',
      side: 'long',
      symbol: 'NDX-USD-PERP',
      quantity: '0.001',
      timeInForce: 'IOC',
      takeProfits: [{ executionType: 'market', triggerPrice: '31461' }], // 31451 + 10 pts
      stopLosses: [{ executionType: 'market', triggerPrice: '31446' }], // 31451 − 5 pts
    });
    expect(open!.headers.Authorization).toBe(`Bearer ${ACCT}`);
    expect(open!.headers['Idempotency-Key']).toMatch(/^uuid-\d+$/);
  });

  it('a SELL prices its legs from the BID', async () => {
    const { s, calls } = await liveSession(vest());
    await s.enter('sell', 0.001, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    expect(writes(calls)[0]!.body).toMatchObject({
      side: 'short',
      takeProfits: [{ triggerPrice: '31440' }],
      stopLosses: [{ triggerPrice: '31455' }],
    });
  });

  it('re-anchors legs to openPrice ± points after the fill, only when off by more than a tick', async () => {
    let positions: unknown[] = [];
    const base = vest();
    const x = await liveSession((c) => (c.path === '/v3/positions/opened' ? { body: positions } : base(c)));
    await x.s.enter('buy', 0.001, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    // Vest filled 1.5 pts worse than the ask; the legs still sit where the ask put them.
    positions = [{ ...LONG_POS, openPrice: '31452.5' }];
    x.advance(100);
    await x.s.poll();
    const w = writes(x.calls).slice(1);
    expect(w).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/v3/positions/take-profit', body: { positionId: 'P1', executionType: 'market', triggerPrice: '31462.5', takeProfitId: 'T1' } }),
      expect.objectContaining({ method: 'PUT', path: '/v3/positions/stop-loss', body: { positionId: 'P1', executionType: 'market', triggerPrice: '31447.5', stopLossId: 'S1' } }),
    ]);
    // One shot: the next poll sends nothing more.
    x.advance(1500);
    await x.s.poll();
    expect(writes(x.calls)).toHaveLength(3);
  });

  it('waits for the sent legs to appear on the position before re-anchoring', async () => {
    let positions: unknown[] = [];
    const base = vest();
    const x = await liveSession((c) => (c.path === '/v3/positions/opened' ? { body: positions } : base(c)));
    await x.s.enter('buy', 0.001, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    positions = [{ ...LONG_POS, openPrice: '31452.5', takeProfits: [], stopLosses: [] }];
    x.advance(100);
    await x.s.poll();
    expect(writes(x.calls)).toHaveLength(1);
    expect(x.s.entryInFlight()).toBe(true);
    positions = [{ ...LONG_POS, openPrice: '31452.5' }];
    x.advance(1500);
    await x.s.poll();
    expect(writes(x.calls).map((c) => c.path)).toEqual(['/v3/positions/open', '/v3/positions/take-profit', '/v3/positions/stop-loss']);
  });

  it('does not re-anchor a fill within one tick of the reference', async () => {
    let positions: unknown[] = [];
    const base = vest();
    const x = await liveSession((c) => (c.path === '/v3/positions/opened' ? { body: positions } : base(c)));
    await x.s.enter('buy', 0.001, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    positions = [{ ...LONG_POS, openPrice: '31451.25' }];
    x.advance(100);
    await x.s.poll();
    expect(writes(x.calls)).toHaveLength(1);
  });

  it('ladder LIMIT: Vest-ticket body, account token, legs from the limit price, guard applies', async () => {
    const { s, calls } = await liveSession(vest());
    // buy limit at 31440.00 (125760 ticks), TP 40 ticks, SL 20 ticks
    const r = await s.enterLimit('buy', 0.001, 125760, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    expect(r.ok).toBe(true);
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'POST', path: '/v3/positions/open' });
    expect(w[0]!.headers.Authorization).toBe(`Bearer ${ACCT}`);
    expect(w[0]!.headers['Idempotency-Key']).toMatch(/^uuid-/);
    expect(w[0]!.body).toEqual({
      orderType: 'limit',
      leverage: '25',
      quantity: '0.001',
      price: '31440',
      symbol: 'NDX-USD-PERP',
      timeInForce: 'GTC',
      side: 'long',
      takeProfits: [{ executionType: 'market', triggerPrice: '31450' }],
      stopLosses: [{ executionType: 'market', triggerPrice: '31435' }],
    });
    expect((await s.enterLimit('buy', 0, 125760, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).ok).toBe(false);
  });

  it('drag a resting limit: cancel first, then re-place the remainder with legs shifted, as Vest does', async () => {
    const { s, calls } = await liveSession(vest({ orders: [{ ...VEST_LIMIT, executed_quantity: '0.04', take_profits: [{ id: 'T9', triggerPrice: '31450' }], stop_losses: [{ id: 'S9', triggerPrice: '31435' }] }] }));
    // 31440 -> 31442.50 (+10 ticks)
    const r = await s.moveOrder('L1', 125770, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 });
    expect(r.ok).toBe(true);
    const w = writes(calls);
    expect(w.map((c) => c.path)).toEqual(['/v3/positions/cancel-order', '/v3/positions/open']);
    expect(w[0]!.body).toEqual({ orderId: 'L1' });
    expect(w[1]!.body).toEqual({
      orderType: 'limit',
      leverage: '25',
      quantity: '0.06',
      price: '31442.5',
      symbol: 'NDX-USD-PERP',
      timeInForce: 'GTC',
      side: 'long',
      takeProfits: [{ executionType: 'market', triggerPrice: '31452.5' }],
      stopLosses: [{ executionType: 'market', triggerPrice: '31437.5' }],
    });
  });

  it('drag: a failed cancel re-places nothing', async () => {
    const { s, calls } = await liveSession((c) => (c.path === '/v3/positions/cancel-order' ? { status: 400, body: { msg: 'order not found' } } : vest({ orders: [VEST_LIMIT] })(c)));
    const r = await s.moveOrder('L1', 125770, MKT, { bracketsOn: true, tpTicks: 40, slTicks: 20 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/may have filled/);
    expect(writes(calls).map((c) => c.path)).toEqual(['/v3/positions/cancel-order']);
  });

  it('drag a TP/SL leg of the open position: PUT with the leg id', async () => {
    const { s, calls } = await liveSession(vest({ positions: [LONG_POS] }));
    expect((await s.moveLeg('sl', 125790, MKT)).ok).toBe(true);
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'PUT', path: '/v3/positions/stop-loss', body: { positionId: 'P1', executionType: 'market', triggerPrice: '31447.5', stopLossId: 'S1' } });
  });

  it('refuses: zero qty, over the size cap, canTrade=false', async () => {
    const { s, calls } = await liveSession(vest());
    s.sizeCap = 0.01; // the cap is off by default; when set, it refuses
    expect((await s.enter('buy', 0, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).message).toMatch(/> 0/);
    expect((await s.enter('buy', 0.02, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).message).toMatch(/size cap/);
    expect(writes(calls)).toHaveLength(0);

    const n = session(vest({ canTrade: false }));
    await n.s.connect();
    const p = await n.s.prepare();
    expect(p.ok).toBe(false);
    expect(p.message).toMatch(/canTrade/);
    expect(p.message).toContain('claim:accountId'); // names the fields it did find…
    expect(p.message).not.toMatch(/eyJ/); // …never a token
    n.s.goLive();
    expect(n.s.mode).toBe('paper');
  });

  it('refuses an add while a position is open, and a second click before Vest confirms the first', async () => {
    const held = await liveSession(vest({ positions: [LONG_POS] }));
    expect((await held.s.enter('buy', 0.001, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).message).toMatch(/adds/);
    const { s, calls } = await liveSession(vest());
    expect((await s.enter('buy', 0.001, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).ok).toBe(true);
    expect((await s.enter('buy', 0.001, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).message).toMatch(/not confirmed/);
    expect(writes(calls)).toHaveLength(1);
  });

  it('refuses entries in PAPER mode', async () => {
    const { s, calls } = session(vest());
    await s.connect();
    expect((await s.enter('buy', 0.001, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).ok).toBe(false);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('FLATTEN / CANCEL: never gated', () => {
  it('closes with the spec body (leverage required) and cancels resting orders', async () => {
    const { s, calls } = await liveSession(vest({ positions: [LONG_POS], orders: [{ order_id: 'R1', symbol: 'NDX-USD-PERP', reduceOnly: true }] }));
    const r = await s.flatten(NQ);
    expect(r.ok).toBe(true);
    const w = writes(calls);
    expect(w[0]).toMatchObject({ method: 'POST', path: '/v3/positions/close', body: { symbol: 'NDX-USD-PERP', positionId: 'P1', orderType: 'market', leverage: '25' } });
    expect(w[1]).toMatchObject({ method: 'POST', path: '/v3/positions/cancel-order', body: { orderId: 'R1' } });
    expect(w[0]!.headers['Idempotency-Key']).not.toBe(w[1]!.headers['Idempotency-Key']);
  });

  it('flattens while the entry guard would refuse everything (tiny cap, account at floor, PAPER mode)', async () => {
    const { s, calls } = await liveSession(vest({ positions: [LONG_POS] }));
    s.sizeCap = 1e-9;
    s.balance = 1; // below the 496.37 floor
    s.canTrade = false;
    s.goPaper();
    expect((await s.enter('buy', 0.001, MKT, { bracketsOn: false, tpTicks: 0, slTicks: 0 })).ok).toBe(false);
    expect((await s.flatten(NQ)).ok).toBe(true);
    expect(writes(calls).map((c) => c.path)).toEqual(['/v3/positions/close']);
  });

  it('flattens the last known position when the positions read fails', async () => {
    let fail = false;
    const base = vest({ positions: [LONG_POS] });
    const { s, calls } = await liveSession((c) => (fail && c.path === '/v3/positions/opened' ? { status: 503, body: { msg: 'down' } } : base(c)));
    fail = true;
    await s.flatten(NQ);
    expect(writes(calls)[0]).toMatchObject({ path: '/v3/positions/close', body: { positionId: 'P1' } });
  });

  it('exits re-mint the token first, and fall back to the still-valid token if the re-mint fails', async () => {
    let mintFails = false;
    const base = vest({ positions: [LONG_POS] });
    const x = await liveSession((c) => (mintFails && c.path === '/v3/auth/account-token' ? { status: 500, body: { msg: 'no' } } : base(c)));
    x.advance(900_000 - 30_000); // inside the 60 s re-mint window, token still valid
    mintFails = true;
    const r = await x.s.flatten(NQ);
    expect(r.ok).toBe(true);
    expect(writes(x.calls)[0]!.headers.Authorization).toBe(`Bearer ${ACCT}`);
  });

  it('CANCEL ALL cancels every resting order, with any id field name', async () => {
    const { s, calls } = await liveSession(vest({ orders: [{ orderId: 'A' }, { order_id: 'B' }, { id: 'C' }] }));
    expect((await s.cancelAll()).ok).toBe(true);
    expect(writes(calls).map((c) => (c.body as { orderId: string }).orderId)).toEqual(['A', 'B', 'C']);
  });
});

describe('B/E', () => {
  it('PUTs the existing stop to entry + offset', async () => {
    const { s, calls } = await liveSession(vest({ positions: [LONG_POS] }));
    const r = await s.breakeven({ ...MKT, bid: 125820, ask: 125824 }, 1);
    expect(r.ok).toBe(true);
    expect(writes(calls)[0]).toMatchObject({
      method: 'PUT',
      path: '/v3/positions/stop-loss',
      body: { positionId: 'P1', executionType: 'market', triggerPrice: '31451.5', stopLossId: 'S1' },
    });
  });

  it('POSTs a new stop when the position has none', async () => {
    const { s, calls } = await liveSession(vest({ positions: [{ ...LONG_POS, stopLosses: [] }] }));
    await s.breakeven({ ...MKT, bid: 125820, ask: 125824 }, 1);
    expect(writes(calls)[0]).toMatchObject({ method: 'POST', path: '/v3/positions/stop-loss', body: { positionId: 'P1', executionType: 'market', triggerPrice: '31451.5' } });
  });

  it('refuses a B/E stop that is already through the bid', async () => {
    const { s, calls } = await liveSession(vest({ positions: [LONG_POS] }));
    expect((await s.breakeven(MKT, 1)).ok).toBe(false);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('rules', () => {
  const base: LiveEntryInput = {
    units: 0.001,
    sizeCap: 0.01,
    canTrade: true,
    price: 31451,
    equity: 506.37,
    floor: 496.37,
    leverage: 25,
    hasPosition: false,
    positionsFresh: true,
    entryInFlight: false,
  };
  it('passes a minimum order and refuses each failing condition', () => {
    expect(liveEntryCheck(base).ok).toBe(true);
    expect(liveEntryCheck({ ...base, units: 0 }).ok).toBe(false);
    expect(liveEntryCheck({ ...base, canTrade: false }).ok).toBe(false);
    expect(liveEntryCheck({ ...base, units: 0.5, sizeCap: 1 }).message).toMatch(/trading power/);
    expect(liveEntryCheck({ ...base, units: 0.1, sizeCap: 0 }).ok).toBe(true); // 0 = cap off
    expect(liveEntryCheck({ ...base, equity: 496.37 }).message).toMatch(/floor/);
    expect(liveEntryCheck({ ...base, equity: undefined }).ok).toBe(false);
    expect(liveEntryCheck({ ...base, positionsFresh: false }).ok).toBe(false);
  });

  it('leverage: saved, else floor(1/IMR), capped at the account max', () => {
    expect(resolveLeverage(10, '0.02', 25)).toBe(10);
    expect(resolveLeverage(undefined, '0.02', 25)).toBe(25);
    expect(resolveLeverage(undefined, '0.02', undefined)).toBe(50);
    expect(resolveLeverage(undefined, undefined, undefined)).toBe(1);
  });

  it('bracket legs round away from a fractional reference', () => {
    expect(bracketTicks(true, 100.5, 4, 2)).toEqual({ tp: 105, sl: 98 });
    expect(bracketTicks(false, 100.5, 4, 2)).toEqual({ tp: 96, sl: 103 });
    expect(bracketTicks(true, 100, 0, 0)).toEqual({});
  });

  it('re-anchor moves only legs more than one tick off openPrice ± points', () => {
    const [p] = readPositions([{ ...LONG_POS, openPrice: '31452.5' }]); // ticks 125810
    const plan = reanchorPlan(p!, 0.25, 40, 20);
    expect(plan.tp).toEqual({ leg: { id: 'T1', triggerPrice: 31461 }, ticks: 125850 });
    expect(plan.sl).toEqual({ leg: { id: 'S1', triggerPrice: 31446 }, ticks: 125790 });
    const [q] = readPositions([{ ...LONG_POS, openPrice: '31451.25' }]); // 1 tick off: leave it
    expect(reanchorPlan(q!, 0.25, 40, 20)).toEqual({});
  });

  it('B/E refuses when the book is missing', () => {
    const [p] = readPositions([LONG_POS]);
    expect(breakevenTicks(p!, 0.25, 1, undefined, undefined).ok).toBe(false);
  });
});

describe('tokens and response readers', () => {
  it('only a USER token passes: userId, no accountId, exp', () => {
    expect(isUserTokenClaims(decodeJwtClaims(USER))).toBe(true);
    expect(isUserTokenClaims(decodeJwtClaims(ACCT))).toBe(false);
    expect(isUserTokenClaims(decodeJwtClaims(jwt({ userId: 1 })))).toBe(false);
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
  });

  it('redact blanks secret keys and anything JWT-shaped', () => {
    const out = redact(JSON.stringify({ apiKey: 'abc', note: `see ${USER}`, n: 1 }));
    expect(out).not.toContain('abc');
    expect(out).not.toContain(USER);
    expect(out).toContain('"n":1');
  });

  it('positions: signed qty from side, legs read, wrapped or bare lists', () => {
    const [p] = readPositions({ positions: [{ ...LONG_POS, side: 'short' }] });
    expect(p).toMatchObject({ positionId: 'P1', qty: -0.001, openPrice: 31451.25, stopLosses: [{ id: 'S1', triggerPrice: 31446 }] });
    expect(readOrders([{ order_id: 7, reduceOnly: true }])).toMatchObject([{ orderId: '7', symbol: undefined, reduceOnly: true }]);
    expect(readOrders({ orders: [VEST_LIMIT] })).toMatchObject([
      { orderId: 'L1', symbol: 'NDX-USD-PERP', side: 'buy', orderType: 'limit', price: 31440, quantity: 0.1, executedQuantity: 0, leverage: '25', reduceOnly: false },
    ]);
  });
});

describe('LIVE refusal reasons', () => {
  it('says why there is no login, from the hook report, without any token', async () => {
    const x = session(vest());
    x.s.setUserToken(null);
    expect((await x.s.connect()).message).toMatch(/reload the extension/);
    x.s.setHookStatus({ apiCalls: 12, bearer: 0, accepted: 0, rejectedKeys: [], reason: '' });
    expect((await x.s.connect()).message).toMatch(/none carried "Authorization: Bearer"/);
    x.s.setHookStatus({ apiCalls: 12, bearer: 3, accepted: 0, rejectedKeys: ['sub', 'exp'], reason: 'no userId claim' });
    expect((await x.s.connect()).message).toMatch(/no userId claim.*\[sub, exp\]/);
    expect(writes(x.calls)).toHaveLength(0);
  });
});
