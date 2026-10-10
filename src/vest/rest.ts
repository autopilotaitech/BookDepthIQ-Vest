import { REST_BASE, type SymbolInfo, type TickerData, type TradeData } from './types.js';

// Public, unauthenticated GETs only. Nothing in this file can place, modify or cancel an order.

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(REST_BASE + path, { headers: { Accept: 'application/json' } });
  const body = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(body)}`);
  // Vest reports some errors as 200 with {code,msg} (e.g. unknown symbol = 1121).
  if (body && typeof body === 'object' && 'code' in body && 'msg' in body) {
    const e = body as { code: unknown; msg: unknown };
    throw new Error(`GET ${path} -> code ${String(e.code)}: ${String(e.msg)}`);
  }
  return body as T;
}

export async function fetchExchangeInfo(): Promise<SymbolInfo[]> {
  // Shape: { symbols: SymbolInfo[], exchange: {...}, system: {...} }
  const r = await getJson<{ symbols: SymbolInfo[] }>('/v3/exchangeInfo');
  return r.symbols;
}

export async function fetchTicker(symbol: string): Promise<TickerData | undefined> {
  const r = await getJson<{ tickers: TickerData[] }>(
    `/v3/ticker/latest?symbols=${encodeURIComponent(symbol)}`,
  );
  return r.tickers[0];
}

/** Up to `limit` (≤ 1000) public trades at or before `endTime`, newest first. */
export function fetchTradesBefore(symbol: string, endTime: number, limit = 1000): Promise<TradeData[]> {
  return getJson<TradeData[]>(`/v3/trades?symbol=${encodeURIComponent(symbol)}&endTime=${Math.floor(endTime)}&limit=${limit}`);
}

/** POST /v4/market-hours — public; its `key` ({exchange, assetType}) sets the funding class. */
export async function fetchMarketKey(assetId: number): Promise<{ exchange?: string; assetType?: string } | undefined> {
  const now = Date.now();
  const r = await fetch(REST_BASE + '/v4/market-hours', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds: [assetId], fromMs: now, toMs: now + 3600_000 }),
  });
  if (!r.ok) throw new Error(`POST /v4/market-hours -> ${r.status}`);
  const rows = (await r.json()) as Array<{ assetId: number; key?: { exchange?: string; assetType?: string } }>;
  return rows.find((x) => x.assetId === assetId)?.key;
}

export function fetchRecentTrades(symbol: string): Promise<TradeData[]> {
  return getJson<TradeData[]>(`/v3/trades?symbol=${encodeURIComponent(symbol)}`);
}
