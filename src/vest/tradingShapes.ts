// Request bodies and response readers for Vest's PRIVATE trading API. Pure: no I/O.
//
// UNVERIFIED. Vest publishes no trading API docs. Every shape here is taken as-is from
// docs/LIVE-ORDERS-SPEC.md §2–§3 (Vest's own web-app traffic as used by the public
// xAmped/Vest-Copier script — facts only, none of its code). No HAR was captured. The owner verifies
// the shapes on the read-only LIVE check (§6.2) and the first 0.001-unit order (§6.3), against
// the panel's request/response log. Change a shape HERE and in tests/trading.test.ts, nowhere else.

export type PositionSide = 'long' | 'short';

// ───────────── number formatting ─────────────

/** Fixed to `decimals`, trailing zeros trimmed: 25 -> "25", 0.10 -> "0.1", 31450.750 -> "31450.75". */
export function decimalString(v: number, decimals: number): string {
  if (!Number.isFinite(v)) throw new Error(`not a number: ${v}`);
  let s = v.toFixed(Math.max(0, decimals));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** A price on the tick grid, formatted with the venue's priceDecimals. Throws rather than round a
 * price onto a different level (a stop must never move silently). */
export function priceString(ticks: number, tickSize: number, priceDecimals: number): string {
  const px = ticks * tickSize;
  const s = decimalString(px, priceDecimals);
  if (Math.abs(Number(s) - px) > 1e-9) throw new Error(`price ${px} is not representable with ${priceDecimals} decimals`);
  return s;
}

/** Quantity rounded to the venue's size step. */
export function qtyString(units: number, sizeDecimals: number): string {
  return decimalString(units, sizeDecimals);
}

// ───────────── request bodies (UNVERIFIED, spec §3) ─────────────

export interface OpenMarketInput {
  symbol: string; // WIRE symbol, e.g. "NDX-USD-PERP"
  side: PositionSide;
  quantity: string;
  leverage: string;
  /** Absent = no leg. The user's numbers only; nothing here picks a distance. */
  takeProfit?: string;
  stopLoss?: string;
}

/** POST /v3/positions/open — market entry with optional brackets. */
export function openMarketBody(i: OpenMarketInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    orderType: 'market',
    leverage: i.leverage,
    side: i.side,
    symbol: i.symbol,
    quantity: i.quantity,
    timeInForce: 'IOC',
  };
  if (i.takeProfit !== undefined) body.takeProfits = [{ executionType: 'market', triggerPrice: i.takeProfit }];
  if (i.stopLoss !== undefined) body.stopLosses = [{ executionType: 'market', triggerPrice: i.stopLoss }];
  return body;
}

/**
 * POST /v3/positions/open — resting LIMIT entry. Shape read from Vest's own web app (2026-10-08,
 * its order ticket: {orderType:"limit", leverage, quantity, price, symbol, timeInForce, side}; its
 * drag-to-move path re-places the same body with takeProfits/stopLosses legs). The account id goes
 * in the account token, not the body. GTC is Vest's default limit TIF (user-state
 * limitOrderTimeInForce). Vest has NO stop entry type: market and limit only.
 */
export function openLimitBody(i: OpenMarketInput & { price: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    orderType: 'limit',
    leverage: i.leverage,
    quantity: i.quantity,
    price: i.price,
    symbol: i.symbol,
    timeInForce: 'GTC',
    side: i.side,
  };
  if (i.takeProfit !== undefined) body.takeProfits = [{ executionType: 'market', triggerPrice: i.takeProfit }];
  if (i.stopLoss !== undefined) body.stopLosses = [{ executionType: 'market', triggerPrice: i.stopLoss }];
  return body;
}

/** POST /v3/positions/close — leverage is required by the venue. */
export function closeBody(symbol: string, positionId: string, leverage: string): Record<string, unknown> {
  return { symbol, positionId, orderType: 'market', leverage };
}

/** PUT /v3/positions/stop-loss — move an existing stop (B/E). */
export function moveStopBody(positionId: string, triggerPrice: string, stopLossId: string): Record<string, unknown> {
  return { positionId, executionType: 'market', triggerPrice, stopLossId };
}

/** POST /v3/positions/stop-loss — add a stop to a position that has none. */
export function addStopBody(positionId: string, triggerPrice: string): Record<string, unknown> {
  return { positionId, executionType: 'market', triggerPrice };
}

/** PUT /v3/positions/take-profit — move an existing target. */
export function moveTargetBody(positionId: string, triggerPrice: string, takeProfitId: string): Record<string, unknown> {
  return { positionId, executionType: 'market', triggerPrice, takeProfitId };
}

/** POST /v3/positions/cancel-order */
export function cancelOrderBody(orderId: string): Record<string, unknown> {
  return { orderId };
}

// ───────────── JWT claims (never logged) ─────────────

export type Claims = Record<string, unknown>;

/** Decodes a JWT payload without verifying it (the venue verifies). Null for anything else. */
export function decodeJwtClaims(token: string): Claims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const c = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return c && typeof c === 'object' && !Array.isArray(c) ? (c as Claims) : null;
  } catch {
    return null;
  }
}

/** A Vest USER token: has userId, has no accountId, and carries an exp (spec §1). */
export function isUserTokenClaims(c: Claims | null): boolean {
  return !!c && c.userId !== undefined && c.userId !== null && !('accountId' in c) && typeof c.exp === 'number';
}

/** Expiry in ms, or undefined. */
export function claimsExpMs(c: Claims | null): number | undefined {
  return c && typeof c.exp === 'number' ? c.exp * 1000 : undefined;
}

// ───────────── log redaction ─────────────

const SECRET_KEY = /token|apikey|api_key|secret|authorization|password|signature/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Text safe for the panel log: secret-looking keys and anything JWT-shaped are blanked. */
export function redact(text: string): string {
  let out = text;
  try {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && typeof x === 'string' ? '<redacted>' : walk(x);
        return o;
      }
      return v;
    };
    out = JSON.stringify(walk(JSON.parse(text)));
  } catch {
    /* not JSON — fall through to the pattern pass */
  }
  return out.replace(JWT_RE, '<jwt redacted>');
}

// ───────────── response readers (UNVERIFIED field names, spec §3) ─────────────

/** Vest may answer with a bare array or wrap it ({positions:[…]}, {data:[…]}). */
export function listOf(body: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isObj);
  if (!isObj(body)) return [];
  for (const k of [...keys, 'data', 'items', 'result', 'results']) {
    const v = body[k];
    if (Array.isArray(v)) return v.filter(isObj);
  }
  for (const v of Object.values(body)) if (Array.isArray(v)) return v.filter(isObj);
  return [];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export interface CapitalAccount {
  id: string;
  label: string;
  initialCapital?: number;
  /** Equity at which the account fails (spec: max_drawdown_limit = fail floor). */
  floor?: number;
  maxLeverage?: number;
}

/** GET /v3/capital/accounts/active */
export function readAccounts(body: unknown): CapitalAccount[] {
  return listOf(body, 'accounts').flatMap((a) => {
    const id = str(a.id ?? a.accountId ?? a.account_id);
    if (!id) return [];
    const initialCapital = num(a.initial_capital);
    const label = str(a.name ?? a.label ?? a.nickname) ?? `${initialCapital !== undefined ? `$${initialCapital} ` : ''}account ${id}`;
    return [{ id, label, initialCapital, floor: num(a.max_drawdown_limit), maxLeverage: num(a.max_leverage) }];
  });
}

/** GET /v3/accounts -> account id -> balance ($). */
export function readBalances(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of listOf(body, 'accounts', 'balances')) {
    const id = str(b.account_id ?? b.accountId);
    const amt = num(b.amount);
    if (id && amt !== undefined) out.set(id, amt);
  }
  return out;
}

/** GET /v3/user-state -> saved leverage for (account, wire symbol). */
export function readSavedLeverage(body: unknown, accountId: string, symbol: string): number | undefined {
  if (!isObj(body)) return undefined;
  const acct = listOf(body.accounts).find((a) => str(a.accountId ?? a.account_id) === accountId);
  const lv = acct ? listOf(acct.leverages).find((l) => str(l.symbol) === symbol) : undefined;
  return lv ? num(lv.leverage) : undefined;
}

export interface Leg {
  id: string;
  triggerPrice: number;
}

export interface LivePosition {
  positionId: string;
  symbol: string; // wire
  side: PositionSide;
  /** Signed: + long, − short. */
  qty: number;
  openPrice: number;
  takeProfits: Leg[];
  stopLosses: Leg[];
}

function legs(v: unknown): Leg[] {
  return listOf(v).flatMap((l) => {
    const id = str(l.id ?? l.orderId ?? l.takeProfitId ?? l.stopLossId);
    const p = num(l.triggerPrice);
    return id && p !== undefined ? [{ id, triggerPrice: p }] : [];
  });
}

/** GET /v3/positions/opened */
export function readPositions(body: unknown): LivePosition[] {
  return listOf(body, 'positions').flatMap((p) => {
    const positionId = str(p.positionId ?? p.id);
    const symbol = str(p.symbol);
    const sideRaw = String(p.side ?? '').toLowerCase();
    const side: PositionSide | undefined = sideRaw === 'long' || sideRaw === 'buy' ? 'long' : sideRaw === 'short' || sideRaw === 'sell' ? 'short' : undefined;
    const q = num(p.quantity ?? p.qty ?? p.size);
    const openPrice = num(p.openPrice ?? p.entryPrice);
    if (!positionId || !symbol || !side || q === undefined || openPrice === undefined || q === 0) return [];
    return [{ positionId, symbol, side, qty: side === 'long' ? Math.abs(q) : -Math.abs(q), openPrice, takeProfits: legs(p.takeProfits), stopLosses: legs(p.stopLosses) }];
  });
}

export interface RestingOrder {
  orderId: string;
  symbol?: string;
  reduceOnly: boolean;
  /** Fields below come from Vest's own order mapping (order_id, side "buy"/"sell", order_type,
   * price, quantity, executed_quantity, leverage, position_id, time_in_force) — read 2026-10-08
   * from its web app. Absent when Vest does not send them. */
  side?: 'buy' | 'sell';
  orderType?: string;
  price?: number;
  quantity?: number;
  executedQuantity?: number;
  leverage?: string;
  positionId?: string;
  timeInForce?: string;
  takeProfits: Leg[];
  stopLosses: Leg[];
}

/** GET /v3/positions/opened-orders */
export function readOrders(body: unknown): RestingOrder[] {
  return listOf(body, 'orders').flatMap((o) => {
    const orderId = str(o.orderId ?? o.order_id ?? o.id);
    if (!orderId) return [];
    const sideRaw = String(o.side ?? '').toLowerCase();
    const side = sideRaw === 'buy' || sideRaw === 'long' ? 'buy' : sideRaw === 'sell' || sideRaw === 'short' ? 'sell' : undefined;
    const ro = o.reduceOnly ?? o.reduce_only;
    return [
      {
        orderId,
        symbol: str(o.symbol),
        reduceOnly: ro === true || ro === 'true',
        side,
        orderType: str(o.orderType ?? o.order_type),
        price: num(o.price),
        quantity: num(o.quantity),
        executedQuantity: num(o.executedQuantity ?? o.executed_quantity),
        leverage: str(o.leverage),
        positionId: str(o.positionId ?? o.position_id),
        timeInForce: str(o.timeInForce ?? o.time_in_force),
        takeProfits: legs(o.takeProfits ?? o.take_profits),
        stopLosses: legs(o.stopLosses ?? o.stop_losses),
      },
    ];
  });
}

export interface OpenResult {
  positionId?: string;
  orderId?: string;
  takeProfitIds: string[];
  stopLossIds: string[];
}

/** POST /v3/positions/open response. */
export function readOpenResult(body: unknown): OpenResult {
  const b = isObj(body) ? (isObj(body.data) ? body.data : body) : {};
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
  return { positionId: str(b.positionId), orderId: str(b.orderId), takeProfitIds: ids(b.takeProfitIds), stopLossIds: ids(b.stopLossIds) };
}

/** POST /v3/auth/account-token response: the token (accessToken or apiKey) and its expiry. */
export function readAccountToken(body: unknown): { token: string; expiresAtMs?: number } | null {
  if (!isObj(body)) return null;
  const b = isObj(body.data) ? body.data : body;
  const token = str(b.accessToken ?? b.apiKey);
  return token ? { token, expiresAtMs: num(b.accessExpiresAtMs) } : null;
}
