import { REST_BASE } from './types.js';
import {
  addStopBody,
  cancelOrderBody,
  claimsExpMs,
  closeBody,
  decodeJwtClaims,
  moveStopBody,
  moveTargetBody,
  openLimitBody,
  openMarketBody,
  readAccountToken,
  readAccounts,
  readBalances,
  readOpenResult,
  readOrders,
  readPositions,
  redact,
  type CapitalAccount,
  type LivePosition,
  type OpenMarketInput,
  type OpenResult,
  type RestingOrder,
} from './tradingShapes.js';

// Vest PRIVATE trading client. THIS FILE CAN PLACE REAL ORDERS. Shapes live in tradingShapes.ts. Rules it enforces (LIVE-ORDERS-SPEC §2, §5):
// - The user token is read from the caller on demand and never stored, logged or sent anywhere
//   but api-gateway. The account token lives in this object's memory only.
// - Every write carries the ACCOUNT token and a fresh Idempotency-Key.
// - Account token reused until 60 s before expiry; on a 401 it is re-minted once and the request
//   is retried once with the SAME Idempotency-Key.
// - Exits (close, stop moves, cancel) fall back to a still-valid cached token if a re-mint fails,
//   so an expiring session can always flatten.
// - Every write and token mint is logged (→ request, ← status + body), redacted.

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface TradingDeps {
  fetch: FetchLike;
  /** The captured Vest USER token, or null. Read on every mint, never cached here. */
  userToken(): string | null;
  uuid(): string;
  now(): number;
  log(line: string): void;
  base?: string;
}

export class VestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Kind = 'read' | 'write' | 'auth';
const REMINT_BEFORE_MS = 60_000;
const LOG_BODY_MAX = 4000;

interface AccountToken {
  accountId: string;
  token: string;
  expiresAtMs: number;
  canTrade: boolean;
  /** Claim and response field NAMES (never values) — shown when canTrade is not found. */
  fieldNames: string[];
}

export class VestTrading {
  accountId: string | null = null;
  /** Last `x-ratelimit-remaining` seen, if the venue sends it. */
  rateRemaining: string | null = null;
  private acct: AccountToken | null = null;
  private lastRead = new Map<string, string>();
  private readonly base: string;

  constructor(private readonly deps: TradingDeps) {
    this.base = deps.base ?? REST_BASE;
  }

  setAccount(id: string | null): void {
    if (id === this.accountId) return;
    this.accountId = id;
    this.acct = null;
    this.lastRead.clear();
  }

  /** Mints (or reuses) the account token and reports its canTrade claim. */
  async tokenStatus(): Promise<{ canTrade: boolean; expiresAtMs: number; fieldNames: string[] }> {
    await this.accountToken(false, false);
    const a = this.acct!;
    return { canTrade: a.canTrade, expiresAtMs: a.expiresAtMs, fieldNames: a.fieldNames };
  }

  // ───────────── reads ─────────────

  async activeAccounts(): Promise<CapitalAccount[]> {
    return readAccounts(await this.call('GET', '/v3/capital/accounts/active', undefined, 'user', 'read'));
  }
  async balances(): Promise<Map<string, number>> {
    return readBalances(await this.call('GET', '/v3/accounts', undefined, 'user', 'read'));
  }
  async userState(): Promise<unknown> {
    return this.call('GET', '/v3/user-state', undefined, 'user', 'read');
  }
  async positions(exit = false): Promise<LivePosition[]> {
    // Vest's own page reads these with the USER token (seen live 2026-10-08), so no account-token
    // mint stands between the panel and its position — and FLATTEN can always see what it closes.
    return readPositions(await this.call('GET', '/v3/positions/opened', undefined, 'user', 'read', exit));
  }
  async orders(exit = false): Promise<RestingOrder[]> {
    return readOrders(await this.call('GET', '/v3/positions/opened-orders', undefined, 'user', 'read', exit));
  }

  // ───────────── writes: REAL ORDERS ─────────────

  async open(i: OpenMarketInput): Promise<OpenResult> {
    return readOpenResult(await this.call('POST', '/v3/positions/open', openMarketBody(i), 'account', 'write'));
  }
  async openLimit(i: OpenMarketInput & { price: string }): Promise<OpenResult> {
    return readOpenResult(await this.call('POST', '/v3/positions/open', openLimitBody(i), 'account', 'write'));
  }
  async close(symbol: string, positionId: string, leverage: string): Promise<unknown> {
    return this.call('POST', '/v3/positions/close', closeBody(symbol, positionId, leverage), 'account', 'write', true);
  }
  async moveStop(positionId: string, triggerPrice: string, stopLossId: string): Promise<unknown> {
    return this.call('PUT', '/v3/positions/stop-loss', moveStopBody(positionId, triggerPrice, stopLossId), 'account', 'write', true);
  }
  async addStop(positionId: string, triggerPrice: string): Promise<unknown> {
    return this.call('POST', '/v3/positions/stop-loss', addStopBody(positionId, triggerPrice), 'account', 'write', true);
  }
  async moveTarget(positionId: string, triggerPrice: string, takeProfitId: string): Promise<unknown> {
    return this.call('PUT', '/v3/positions/take-profit', moveTargetBody(positionId, triggerPrice, takeProfitId), 'account', 'write', true);
  }
  async cancel(orderId: string): Promise<unknown> {
    return this.call('POST', '/v3/positions/cancel-order', cancelOrderBody(orderId), 'account', 'write', true);
  }

  // ───────────── internals ─────────────

  private async accountToken(force: boolean, exit: boolean): Promise<string> {
    const id = this.accountId;
    if (!id) throw new VestApiError('no Vest account selected', 0);
    const a = this.acct;
    const now = this.deps.now();
    if (!force && a && a.accountId === id && now < a.expiresAtMs - REMINT_BEFORE_MS) return a.token;
    try {
      return await this.mint(id);
    } catch (e) {
      // Exits must not die on a failed re-mint while the old token is still accepted.
      if (exit && a && a.accountId === id && now < a.expiresAtMs) {
        this.deps.log(`! account-token re-mint failed (${(e as Error).message}); exit sent with the still-valid token`);
        return a.token;
      }
      throw e;
    }
  }

  private async mint(accountId: string): Promise<string> {
    const user = this.deps.userToken();
    if (!user) throw new VestApiError('no Vest login token — open next.vestmarkets.com and log in', 0);
    const body = await this.send('POST', '/v3/auth/account-token', { accountId }, user, 'auth', undefined);
    const t = readAccountToken(body);
    if (!t) throw new VestApiError('account-token response has no accessToken/apiKey', 200);
    const claims = decodeJwtClaims(t.token);
    const now = this.deps.now();
    // Unknown expiry: treat it as short-lived so it is re-minted soon rather than trusted long.
    const expiresAtMs = t.expiresAtMs ?? claimsExpMs(claims) ?? now + 2 * REMINT_BEFORE_MS;
    // canTrade: an explicit false (claim or body) refuses LIVE. Absent is not a refusal — the claim
    // name is unverified, and Vest's own page trades this account without it in the user token.
    const bodyCanTrade = !!body && typeof body === 'object' ? (body as Record<string, unknown>).canTrade : undefined;
    const canTrade = claims?.canTrade !== false && bodyCanTrade !== false;
    const fieldNames = [
      ...(claims ? Object.keys(claims).map((k) => `claim:${k}`) : ['token is not a JWT']),
      ...(body && typeof body === 'object' ? Object.keys(body as object).map((k) => `body:${k}`) : []),
    ];
    this.acct = { accountId, token: t.token, expiresAtMs, canTrade, fieldNames };
    return t.token;
  }

  private async call(method: string, path: string, body: unknown, auth: 'user' | 'account', kind: Kind, exit = false): Promise<unknown> {
    const idem = kind === 'write' ? this.deps.uuid() : undefined;
    if (auth === 'user') {
      const user = this.deps.userToken();
      if (!user) throw new VestApiError('no Vest login token — open next.vestmarkets.com and log in', 0);
      return this.send(method, path, body, user, kind, idem);
    }
    const token = await this.accountToken(false, exit);
    try {
      return await this.send(method, path, body, token, kind, idem);
    } catch (e) {
      if (!(e instanceof VestApiError) || e.status !== 401) throw e;
      this.deps.log(`! 401 on ${path}: re-minting the account token and retrying once`);
      const fresh = await this.accountToken(true, false);
      return this.send(method, path, body, fresh, kind, idem);
    }
  }

  private async send(method: string, path: string, body: unknown, bearer: string, kind: Kind, idem: string | undefined): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${bearer}` };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (idem) headers['Idempotency-Key'] = idem;
    const loud = kind !== 'read';
    if (loud) this.deps.log(`→ ${method} ${path}${payload ? ' ' + redact(payload) : ''}${idem ? ` [idem ${idem}]` : ''}`);
    let res: HttpResponse;
    try {
      res = await this.deps.fetch(this.base + path, { method, headers, body: payload });
    } catch (e) {
      // A write that dies here may or may not have reached Vest. Never resent automatically.
      const msg = `${method} ${path} network error: ${(e as Error).message}${kind === 'write' ? ' — check Vest before retrying' : ''}`;
      this.deps.log(`← ${msg}`);
      throw new VestApiError(msg, 0);
    }
    const rl = res.headers.get('x-ratelimit-remaining');
    if (rl !== null) this.rateRemaining = rl;
    const text = await res.text().catch(() => '');
    const shown = clip(redact(text));
    if (loud || !res.ok || this.lastRead.get(path) !== text) {
      if (!loud) this.deps.log(`→ ${method} ${path}`);
      this.deps.log(`← ${res.status} ${shown}`);
      if (!loud && res.ok) this.lastRead.set(path, text);
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new VestApiError(`${method} ${path} -> ${res.status} ${shown}`, res.status);
    // Vest reports some errors as 200 with {code,msg} (seen on public endpoints: 1121 unknown symbol).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'code' in parsed && 'msg' in parsed) {
      throw new VestApiError(`${method} ${path} -> code ${String((parsed as { code: unknown }).code)}: ${String((parsed as { msg: unknown }).msg)}`, res.status);
    }
    return parsed;
  }
}

function clip(s: string): string {
  return s.length > LOG_BODY_MAX ? `${s.slice(0, LOG_BODY_MAX)}… (${s.length} chars)` : s;
}
