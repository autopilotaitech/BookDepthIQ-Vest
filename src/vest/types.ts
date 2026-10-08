// Wire shapes for Vest's PUBLIC market-data API, as observed live on 2026-10-07.
// Vest has not published API docs ("API Documentation — Coming soon" on docs.vestmarkets.com),
// so every field here was read off a real response, not a spec. Numbers arrive as strings.

export const REST_BASE = 'https://api-gateway.hz.vestmarkets.com';
export const WS_URL = 'wss://ws.hz.vestmarkets.com/ws?version=1.0';

/** One entry of GET /v3/exchangeInfo. Only the fields this project reads are typed. */
export interface SymbolInfo {
  symbol: string; // wire symbol, e.g. "NDX-USD-PERP"
  displaySymbol?: string; // what the UI shows, e.g. "NQ-PERP"
  displayName?: string;
  sizeDecimals: number;
  priceDecimals: number;
  tickSizes?: string[];
  minTickSize?: string;
  defaultTickSize?: string;
  takerFee?: string;
  makerFee?: string;
  initMarginRatio?: string;
  maintMarginRatio?: string;
  tradingStatus?: string;
}

/** [price, qty] — both decimal strings. */
export type Level = [string, string];

/** `<symbol>@depth`. Each message is a FULL snapshot of the top of book, not a diff. */
export interface DepthMsg {
  channel: string;
  data: { bids: Level[]; asks: Level[] };
  tsMs?: number;
}

export interface TradeData {
  id: string;
  price: string;
  qty: string;
  quoteQty: string;
  side: 'buy' | 'sell';
  time: number;
}

export interface TradeMsg {
  channel: string;
  data: TradeData;
  tsMs?: number;
}

export interface TickerData {
  symbol: string;
  indexPrice: string;
  markPrice: string;
  marginMarkPrice?: string;
  oneHrFundingRate?: string;
  imbalance?: string;
  status?: string;
}

export interface TickerMsg {
  channel: string;
  data: TickerData;
  tsMs?: number;
}

export type StreamKind = 'depth' | 'trades' | 'ticker';

export function streamName(symbol: string, kind: StreamKind): string {
  return `${symbol}@${kind}`;
}

/** Splits "NDX-USD-PERP@depth" into its parts; null for anything else. */
export function parseChannel(channel: string): { symbol: string; kind: StreamKind } | null {
  const at = channel.lastIndexOf('@');
  if (at <= 0) return null;
  const kind = channel.slice(at + 1);
  if (kind !== 'depth' && kind !== 'trades' && kind !== 'ticker') return null;
  return { symbol: channel.slice(0, at), kind };
}
