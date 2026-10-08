import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bookFromDepth, bestAsk, bestBid, midTicks, spreadTicks } from '../src/book/book.js';
import { dist, ladderScore } from '../src/book/stats.js';
import { buildSymbolTable, tickSizeOf } from '../src/vest/symbols.js';
import { parseChannel, type DepthMsg, type SymbolInfo } from '../src/vest/types.js';
import { VestMarketSocket } from '../src/vest/ws.js';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

// Real exchangeInfo entry for NQ, trimmed (2026-10-07).
const NQ: SymbolInfo = {
  symbol: 'NDX-USD-PERP',
  displaySymbol: 'NQ-PERP',
  sizeDecimals: 4,
  priceDecimals: 2,
  tickSizes: ['0.25', '2.5', '25'],
  defaultTickSize: '0.25',
  minTickSize: '0.25',
};

describe('symbols', () => {
  it('resolves the display name to the wire symbol the API actually accepts', () => {
    const t = buildSymbolTable([NQ]);
    expect(t.resolve('NQ-PERP')?.symbol).toBe('NDX-USD-PERP');
    expect(t.resolve('nq-perp')?.symbol).toBe('NDX-USD-PERP');
    expect(t.resolve('NDX-USD-PERP')?.symbol).toBe('NDX-USD-PERP');
    expect(t.resolve('ES-PERP')).toBeUndefined();
  });

  it('a display name never shadows another symbol with that wire name', () => {
    const real: SymbolInfo = { symbol: 'NOK-PERP', sizeDecimals: 0, priceDecimals: 2 };
    const alias: SymbolInfo = { symbol: 'NOK-USD-PERP', displaySymbol: 'NOK-PERP', sizeDecimals: 0, priceDecimals: 2 };
    expect(buildSymbolTable([real, alias]).resolve('NOK-PERP')?.symbol).toBe('NOK-PERP');
    expect(buildSymbolTable([alias, real]).resolve('NOK-PERP')?.symbol).toBe('NOK-PERP');
  });

  it('tick size comes from the venue, with priceDecimals only as a fallback', () => {
    expect(tickSizeOf(NQ)).toBe(0.25);
    expect(tickSizeOf({ symbol: 'X', sizeDecimals: 0, priceDecimals: 3 })).toBeCloseTo(0.001);
  });
});

describe('channels', () => {
  it('parses the three streams and rejects everything else', () => {
    expect(parseChannel('NDX-USD-PERP@depth')).toEqual({ symbol: 'NDX-USD-PERP', kind: 'depth' });
    expect(parseChannel('NDX-USD-PERP@trades')?.kind).toBe('trades');
    expect(parseChannel('NDX-USD-PERP@kline_1m')).toBeNull();
    expect(parseChannel('@depth')).toBeNull();
  });
});

describe('book from a real depth snapshot', () => {
  const msg = JSON.parse(fixture('depth-nq.json')) as DepthMsg;
  const b = bookFromDepth(msg, 0.25);

  it('orders both sides best-first in integer ticks', () => {
    expect(bestBid(b)).toBe(Math.round(31478.75 / 0.25));
    expect(bestAsk(b)).toBe(Math.round(31480.0 / 0.25));
    for (let i = 1; i < b.bids.ticks.length; i++) expect(b.bids.ticks[i]!).toBeLessThan(b.bids.ticks[i - 1]!);
    for (let i = 1; i < b.asks.ticks.length; i++) expect(b.asks.ticks[i]!).toBeGreaterThan(b.asks.ticks[i - 1]!);
  });

  it('spread and mid are in ticks', () => {
    expect(spreadTicks(b)).toBe(5);
    expect(midTicks(b)).toBe((Math.round(31478.75 / 0.25) + Math.round(31480 / 0.25)) / 2);
  });

  it('flags the real NQ book as a quote ladder', () => {
    expect(ladderScore([...b.bids.sizes, ...b.asks.sizes]).score).toBeGreaterThan(0.9);
  });

  it('drops zero and malformed levels', () => {
    const bad = bookFromDepth({ channel: 'X@depth', data: { bids: [['1', '0'], ['x', '1'], ['2', '3']], asks: [] } }, 1);
    expect(bad.bids.ticks).toEqual([2]);
    expect(spreadTicks(bad)).toBeUndefined();
  });
});

describe('stats', () => {
  it('ladder score is low for organic-looking sizes', () => {
    expect(ladderScore([4, 7, 13, 2.3, 9.1, 5.7]).score).toBeLessThan(0.5);
  });

  it('dist reports order statistics', () => {
    expect(dist([3, 1, 2])).toMatchObject({ n: 3, min: 1, p50: 2, max: 3 });
    expect(dist([]).n).toBe(0);
  });
});

describe('socket dispatch', () => {
  it('routes frames by channel and reports rejected streams', () => {
    const seen: string[] = [];
    const s = new VestMarketSocket({
      onDepth: (sym) => seen.push(`depth:${sym}`),
      onTrade: (sym) => seen.push(`trade:${sym}`),
      onTicker: (sym) => seen.push(`ticker:${sym}`),
      onRejected: (st, r) => seen.push(`rejected:${st}:${r}`),
    });
    s.dispatch(fixture('depth-nq.json'));
    s.dispatch(fixture('trade-nq.json'));
    s.dispatch(fixture('ticker-nq.json'));
    s.dispatch(JSON.stringify({ subscription_outcomes: [{ requested: 'NDX-USD-PERP@kline_1m', status: 'rejected', reason: 'invalid_stream' }] }));
    s.dispatch('not json');
    expect(seen).toEqual([
      'depth:NDX-USD-PERP',
      'trade:NDX-USD-PERP',
      'ticker:NDX-USD-PERP',
      'rejected:NDX-USD-PERP@kline_1m:invalid_stream',
    ]);
  });
});
