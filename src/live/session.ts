import type { Side } from '../sim/paper.js';
import { VestPrivateSocket, type PrivateSocketFactory } from '../vest/privateWs.js';
import { VestTrading, type FetchLike } from '../vest/trading.js';
import {
  claimsExpMs,
  decodeJwtClaims,
  priceString,
  qtyString,
  readSavedLeverage,
  type CapitalAccount,
  type LivePosition,
  type OpenMarketInput,
  type RestingOrder,
} from '../vest/tradingShapes.js';
import type { SymbolInfo } from '../vest/types.js';
import { DEFAULT_LIVE_SIZE_CAP, bracketTicks, breakevenTicks, liveEntryCheck, reanchorPlan, resolveLeverage, type Check } from './rules.js';

// The LIVE side of the panel: Vest account state, polling, and the v1 actions (LIVE-ORDERS-SPEC §4).
// Vest's position is the truth — nothing here derives a position locally.
//
// Safety (spec §5):
// - Mode starts PAPER on every launch and is never persisted.
// - Entries go through liveEntryCheck. FLATTEN and CANCEL ALL go through NOTHING: not the mode, not
//   the guard, not a failed read, not an expiring token.
// - No order is sent except from a user action (click or armed hotkey), plus the one spec-mandated
//   follow-up: re-anchoring the legs of the entry the user just sent.

export type LiveMode = 'paper' | 'live';

export interface MarketCtx {
  info: SymbolInfo;
  tick: number;
  bid: number | undefined; // ticks
  ask: number | undefined;
}

export interface BracketCtx {
  bracketsOn: boolean;
  tpTicks: number;
  slTicks: number;
}

export interface LiveDeps {
  fetch: FetchLike;
  uuid(): string;
  now(): number;
  onChange(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** Vest's private account socket (push). Absent = REST polling only (tests, dev server). */
  privateSocket?: PrivateSocketFactory;
}

interface PendingEntry {
  symbol: string;
  tick: number;
  priceDecimals: number;
  tpTicks: number; // 0 = leg not sent
  slTicks: number;
  positionId?: string;
  respondedAt: number;
}

const POLL_MS = 1500;
/** REST safety-net cadence while the private socket is pushing account events. */
const PUSH_POLL_MS = 5000;
const ACCOUNT_POLL_MS = 10_000;
const MAX_POLL_MS = 10_000;
const FRESH_MS = 5000;
const ENTRY_CONFIRM_MS = 10_000;
const LOG_MAX = 1000;

const ok = (message: string): Check => ({ ok: true, message });
const no = (message: string): Check => ({ ok: false, message });

export class LiveSession {
  mode: LiveMode = 'paper';
  readonly api: VestTrading;
  accounts: CapitalAccount[] = [];
  account: CapitalAccount | null = null;
  balance: number | undefined;
  userState: unknown = null;
  canTrade = false;
  positions: LivePosition[] = [];
  orders: RestingOrder[] = [];
  positionsAt = 0;
  pollError = '';
  sizeCap = DEFAULT_LIVE_SIZE_CAP;
  busy = false;
  /** Request/response log: every write in full, reads on first sight and on change. Redacted. */
  log: string[] = [];

  private userToken: string | null = null;
  /** TP/SL trigger prices the panel sent with each resting limit, by Vest orderId — so a move can
   * shift them with the order, as Vest's own drag does. */
  private orderLegs = new Map<string, { tp?: number; sl?: number }>();
  private entry: PendingEntry | null = null;
  private pollTimer: unknown = null;
  private pollMs = POLL_MS;
  private lastAccountPoll = 0;
  private polling = false;
  /** An account event arrived during a poll: read again as soon as it ends. */
  private repoll = false;
  private readonly push: VestPrivateSocket | null;
  /** True while Vest's private socket is connected and pushing account events. */
  pushOpen = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly deps: LiveDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.push = deps.privateSocket
      ? new VestPrivateSocket(
          () => (this.tokenOk() ? this.userToken : null),
          {
            onAccountEvent: () => this.nudge(),
            onStatus: (open) => {
              this.pushOpen = open;
              this.write(open ? '⚡ Vest push connected — updates are instant' : '… Vest push disconnected — polling every 1.5 s');
              if (!open && (this.mode === 'live' || this.hasExposure())) this.kick(0);
            },
          },
          deps.privateSocket,
        )
      : null;
    this.api = new VestTrading({
      fetch: deps.fetch,
      userToken: () => this.userToken,
      uuid: deps.uuid,
      now: deps.now,
      log: (l) => this.write(l),
    });
  }

  // ───────────── token & account ─────────────

  /** Latest report from the Vest-tab hook (counts and claim names only). */
  hookStatus: { apiCalls: number; bearer: number; accepted: number; rejectedKeys: string[]; reason: string } | null = null;

  setHookStatus(s: LiveSession['hookStatus']): void {
    this.hookStatus = s;
    this.deps.onChange();
  }

  /** What the panel's direct read of open Vest tabs found (null until the first read). */
  vestTabs: { tabs: number; hooked: number; error?: string } | null = null;

  setVestTabs(v: LiveSession['vestTabs']): void {
    this.vestTabs = v;
    this.deps.onChange();
  }

  /** Why there is no usable Vest login, in words the user can act on. */
  loginProblem(): string {
    const h = this.hookStatus;
    const v = this.vestTabs;
    if (this.userToken && !this.tokenOk()) return 'the captured Vest login has expired — reload the Vest tab';
    if (v && v.tabs === 0 && v.error) return `LIVE needs the Chrome extension (${v.error})`;
    if (v && v.tabs === 0) return 'no next.vestmarkets.com tab is open in THIS Chrome window set — open Vest and log in here (the panel and Vest must be in the same Chrome profile)';
    if (v && v.hooked === 0) return `the panel could not reach the Vest tab (${v.error ?? 'no hook answer'}) — reload the Vest tab`;
    if (h && h.bearer === 0 && v) return 'Vest has not sent a logged-in request since the hook loaded — reload the Vest tab (it sends its login on load)';
    if (!h) return 'no report from the Vest tab — reload the extension, then reload next.vestmarkets.com (the hook only loads on a fresh page)';
    if (h.bearer === 0) return `the Vest tab made ${h.apiCalls} api-gateway call(s) but none carried "Authorization: Bearer" — Vest may authenticate another way (spec §1 unverified)`;
    if (h.accepted === 0) return `Vest's token was seen but not accepted as a USER token: ${h.reason}. Its claim names: [${h.rejectedKeys.join(', ')}] — the spec expects userId, no accountId, exp`;
    return 'a Vest login was captured but has not reached the panel yet — try again in a second';
  }

  setUserToken(t: string | null): void {
    if (t === this.userToken) return;
    this.userToken = t;
    this.deps.onChange();
  }

  /** Expiry of the captured user token (ms), or undefined. The token itself never leaves here. */
  userTokenExpMs(): number | undefined {
    return this.userToken ? claimsExpMs(decodeJwtClaims(this.userToken)) : undefined;
  }

  tokenOk(): boolean {
    const exp = this.userTokenExpMs();
    return exp !== undefined && exp > this.deps.now();
  }

  /** Reads the account list, balances and saved leverage. No writes. */
  async connect(): Promise<Check> {
    if (!this.tokenOk()) return no(`no Vest login: ${this.loginProblem()}`);
    try {
      this.accounts = await this.api.activeAccounts();
      await this.refreshBalances();
      this.userState = await this.api.userState();
    } catch (e) {
      return no(`Vest account read failed: ${(e as Error).message}`);
    }
    if (this.accounts.length === 0) return no('Vest returned no active accounts');
    if (this.account) this.account = this.accounts.find((a) => a.id === this.account!.id) ?? null;
    if (!this.account && this.accounts.length === 1) this.selectAccount(this.accounts[0]!.id);
    this.deps.onChange();
    return ok(`${this.accounts.length} Vest account(s) read`);
  }

  selectAccount(id: string): void {
    if (this.mode === 'live') return; // switch account only from PAPER
    this.account = this.accounts.find((a) => a.id === id) ?? null;
    this.api.setAccount(this.account?.id ?? null);
    this.canTrade = false;
    this.positions = [];
    this.orders = [];
    this.positionsAt = 0;
    this.deps.onChange();
  }

  /** Everything LIVE needs before the confirm dialog: login, account, canTrade. */
  async prepare(): Promise<Check> {
    if (!this.tokenOk()) return no(`no Vest login: ${this.loginProblem()}`);
    if (!this.account) return no('pick a Vest account first');
    let names: string[] = [];
    try {
      const st = await this.api.tokenStatus();
      this.canTrade = st.canTrade;
      names = st.fieldNames;
    } catch (e) {
      return no(`account token failed: ${(e as Error).message}`);
    }
    this.deps.onChange();
    if (!this.canTrade) return no(`account ${this.account.label}: the account token says canTrade = false — LIVE refused. Fields present: [${names.join(', ')}]`);
    return ok(this.account.label);
  }

  goLive(): void {
    if (!this.account || !this.canTrade) return;
    this.mode = 'live';
    this.write(`=== LIVE on ${this.account.label} (${this.account.id})`);
    this.pollMs = POLL_MS;
    this.lastAccountPoll = 0;
    this.push?.start();
    this.kick(0);
    this.deps.onChange();
  }

  goPaper(): void {
    if (this.mode === 'paper') return;
    this.mode = 'paper';
    this.write('=== back to PAPER');
    // Keep polling while Vest still holds something, so the panel can show it and flatten it.
    if (!this.hasExposure()) {
      this.stopPolling();
      this.push?.stop();
    }
    this.deps.onChange();
  }

  stop(): void {
    this.stopPolling();
    this.push?.stop();
  }

  /** Vest pushed an account event: read positions + orders now. */
  private nudge(): void {
    if (this.polling) this.repoll = true;
    else if (this.mode === 'live' || this.hasExposure()) this.kick(0);
  }

  // ───────────── derived ─────────────

  leverageFor(info: SymbolInfo): number {
    const saved = this.account ? readSavedLeverage(this.userState, this.account.id, info.symbol) : undefined;
    return resolveLeverage(saved, info.initMarginRatio, this.account?.maxLeverage);
  }

  equity(): number | undefined {
    return this.balance;
  }

  floor(): number | undefined {
    return this.account?.floor;
  }

  positionFor(symbol: string): LivePosition | undefined {
    return this.positions.find((p) => p.symbol === symbol);
  }

  ordersFor(symbol: string): RestingOrder[] {
    return this.orders.filter((o) => o.symbol === undefined || o.symbol === symbol);
  }

  positionsFresh(): boolean {
    // With push open, Vest tells us about every change, so the last read stays good longer than
    // the 5 s safety-net poll.
    const limit = this.pushOpen ? PUSH_POLL_MS * 2 + 1000 : FRESH_MS;
    return this.positionsAt > 0 && this.deps.now() - this.positionsAt < limit;
  }

  entryInFlight(): boolean {
    return this.busy || (this.entry !== null && this.deps.now() - this.entry.respondedAt < ENTRY_CONFIRM_MS);
  }

  hasExposure(): boolean {
    return this.positions.length > 0 || this.orders.length > 0;
  }

  // ───────────── actions ─────────────

  /** BUY MKT / SELL MKT with the user's TP/SL points, priced from the expected fill. */
  async enter(side: Side, units: number, m: MarketCtx, br: BracketCtx): Promise<Check> {
    if (this.mode !== 'live') return no('not in LIVE');
    const long = side === 'buy';
    const ref = long ? m.ask : m.bid;
    const lev = this.leverageFor(m.info);
    const f = 10 ** m.info.sizeDecimals;
    const qty = Math.round(units * f) / f;
    const chk = liveEntryCheck({
      units: qty,
      sizeCap: this.sizeCap,
      canTrade: this.canTrade,
      price: ref === undefined ? undefined : ref * m.tick,
      equity: this.equity(),
      floor: this.floor(),
      leverage: lev,
      hasPosition: !!this.positionFor(m.info.symbol),
      positionsFresh: this.positionsFresh(),
      entryInFlight: this.entryInFlight(),
    });
    if (!chk.ok) return chk;
    const legs = br.bracketsOn ? bracketTicks(long, ref!, br.tpTicks, br.slTicks) : {};
    let input: OpenMarketInput;
    try {
      input = {
        symbol: m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(qty, m.info.sizeDecimals),
        leverage: String(lev),
        takeProfit: legs.tp === undefined ? undefined : priceString(legs.tp, m.tick, m.info.priceDecimals),
        stopLoss: legs.sl === undefined ? undefined : priceString(legs.sl, m.tick, m.info.priceDecimals),
      };
    } catch (e) {
      return no((e as Error).message);
    }
    this.busy = true;
    this.deps.onChange();
    try {
      const r = await this.api.open(input);
      this.entry = {
        symbol: m.info.symbol,
        tick: m.tick,
        priceDecimals: m.info.priceDecimals,
        tpTicks: legs.tp === undefined ? 0 : br.tpTicks,
        slTicks: legs.sl === undefined ? 0 : br.slTicks,
        positionId: r.positionId,
        respondedAt: this.deps.now(),
      };
      return ok(`${side.toUpperCase()} ${input.quantity} sent to Vest${r.positionId ? ` — position ${r.positionId}` : ''}`);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      // A network failure may still have reached Vest: hold entries until a poll shows the truth.
      if (status === 0) this.entry = { symbol: m.info.symbol, tick: m.tick, priceDecimals: m.info.priceDecimals, tpTicks: 0, slTicks: 0, respondedAt: this.deps.now() };
      return no(`entry failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.kick(0);
      this.deps.onChange();
    }
  }

  /**
   * Ladder click: resting LIMIT entry at `priceTicks`, legs at the user's points from that price.
   * Same guard as a market entry, sized at the limit price. It rests, so no position is expected
   * right away and nothing is re-anchored (the legs are already priced from the exact fill price).
   */
  async enterLimit(side: Side, units: number, priceTicks: number, m: MarketCtx, br: BracketCtx): Promise<Check> {
    if (this.mode !== 'live') return no('not in LIVE');
    const long = side === 'buy';
    const lev = this.leverageFor(m.info);
    const f = 10 ** m.info.sizeDecimals;
    const qty = Math.round(units * f) / f;
    const chk = liveEntryCheck({
      units: qty,
      sizeCap: this.sizeCap,
      canTrade: this.canTrade,
      price: priceTicks * m.tick,
      equity: this.equity(),
      floor: this.floor(),
      leverage: lev,
      hasPosition: !!this.positionFor(m.info.symbol),
      positionsFresh: this.positionsFresh(),
      entryInFlight: this.entryInFlight(),
    });
    if (!chk.ok) return chk;
    const legs = br.bracketsOn ? bracketTicks(long, priceTicks, br.tpTicks, br.slTicks) : {};
    let input: OpenMarketInput & { price: string };
    try {
      input = {
        symbol: m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(qty, m.info.sizeDecimals),
        leverage: String(lev),
        price: priceString(priceTicks, m.tick, m.info.priceDecimals),
        takeProfit: legs.tp === undefined ? undefined : priceString(legs.tp, m.tick, m.info.priceDecimals),
        stopLoss: legs.sl === undefined ? undefined : priceString(legs.sl, m.tick, m.info.priceDecimals),
      };
    } catch (e) {
      return no((e as Error).message);
    }
    this.busy = true;
    this.deps.onChange();
    try {
      const r = await this.api.openLimit(input);
      if (r.orderId) this.orderLegs.set(r.orderId, { tp: legs.tp, sl: legs.sl });
      return ok(`LIMIT ${side.toUpperCase()} ${input.quantity} @ ${input.price} sent to Vest${r.orderId ? ` — order ${r.orderId}` : ''}`);
    } catch (e) {
      return no(`limit entry failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.kick(0);
      this.deps.onChange();
    }
  }

  /** Cancel one resting Vest order (ladder chip dropped on its own row). NEVER gated. */
  async cancelOrder(orderId: string): Promise<Check> {
    try {
      await this.api.cancel(orderId);
      this.orderLegs.delete(orderId);
      return ok(`cancelled order ${orderId}`);
    } catch (e) {
      return no(`cancel ${orderId} failed: ${(e as Error).message}`);
    } finally {
      this.kick(0);
    }
  }

  /**
   * Drag a resting limit to `toTicks`. Vest has no amend: its own app cancels, then re-places the
   * unfilled remainder at the new price with the TP/SL legs shifted by the same distance. Same
   * here. If the cancel fails (filled, gone) nothing is re-placed.
   */
  async moveOrder(orderId: string, toTicks: number, m: MarketCtx, br: BracketCtx): Promise<Check> {
    const o = this.orders.find((x) => x.orderId === orderId);
    if (!o) return no('order not on Vest any more');
    if (o.reduceOnly || o.side === undefined || o.price === undefined || o.quantity === undefined) return no('only resting limit entries can be dragged');
    const fromTicks = Math.round(o.price / m.tick);
    if (fromTicks === toTicks) return ok('unchanged');
    const left = o.quantity - (o.executedQuantity ?? 0);
    if (!(left > 0)) return no('order already filled');
    const long = o.side === 'buy';
    const delta = toTicks - fromTicks;
    // Legs: Vest's own (if it sends them on the order), else the ones the panel sent, shifted by
    // the move; else the user's bracket points from the new price.
    const known = this.orderLegs.get(orderId);
    const vestTp = o.takeProfits[0] ? Math.round(o.takeProfits[0].triggerPrice / m.tick) : undefined;
    const vestSl = o.stopLosses[0] ? Math.round(o.stopLosses[0].triggerPrice / m.tick) : undefined;
    let tp = vestTp ?? known?.tp;
    let sl = vestSl ?? known?.sl;
    if (tp !== undefined) tp += delta;
    if (sl !== undefined) sl += delta;
    if (tp === undefined && sl === undefined && br.bracketsOn) ({ tp, sl } = bracketTicks(long, toTicks, br.tpTicks, br.slTicks));
    let input: OpenMarketInput & { price: string };
    try {
      input = {
        symbol: o.symbol ?? m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(left, m.info.sizeDecimals),
        leverage: o.leverage ?? String(this.leverageFor(m.info)),
        price: priceString(toTicks, m.tick, m.info.priceDecimals),
        takeProfit: tp === undefined ? undefined : priceString(tp, m.tick, m.info.priceDecimals),
        stopLoss: sl === undefined ? undefined : priceString(sl, m.tick, m.info.priceDecimals),
      };
    } catch (e) {
      return no((e as Error).message);
    }
    this.busy = true;
    this.deps.onChange();
    try {
      try {
        await this.api.cancel(orderId);
      } catch (e) {
        return no(`move refused: cancel of ${orderId} failed (${(e as Error).message}) — it may have filled`);
      }
      this.orderLegs.delete(orderId);
      try {
        const r = await this.api.openLimit(input);
        if (r.orderId) this.orderLegs.set(r.orderId, { tp, sl });
        return ok(`moved ${o.side.toUpperCase()} ${input.quantity} to ${input.price}`);
      } catch (e) {
        return no(`order ${orderId} was CANCELLED but the re-place at ${input.price} failed: ${(e as Error).message} — nothing is resting now`);
      }
    } finally {
      this.busy = false;
      this.kick(0);
      this.deps.onChange();
    }
  }

  /** Drag a TP or SL leg of the open position to `toTicks` (PUT). */
  async moveLeg(kind: 'tp' | 'sl', toTicks: number, m: MarketCtx): Promise<Check> {
    const p = this.positionFor(m.info.symbol);
    const leg = kind === 'tp' ? p?.takeProfits[0] : p?.stopLosses[0];
    if (!p || !leg) return no(`no ${kind.toUpperCase()} on Vest to move`);
    try {
      const px = priceString(toTicks, m.tick, m.info.priceDecimals);
      if (kind === 'tp') await this.api.moveTarget(p.positionId, px, leg.id);
      else await this.api.moveStop(p.positionId, px, leg.id);
      return ok(`${kind.toUpperCase()} moved to ${px}`);
    } catch (e) {
      return no(`${kind.toUpperCase()} move failed: ${(e as Error).message}`);
    } finally {
      this.kick(0);
    }
  }

  /** Moves the stop to entry ± offset (PUT), or adds one (POST) when the position has none. */
  async breakeven(m: MarketCtx, offsetTicks: number): Promise<Check> {
    const p = this.positionFor(m.info.symbol);
    if (!p) return no('flat on Vest — nothing to protect');
    const be = breakevenTicks(p, m.tick, offsetTicks, m.bid, m.ask);
    if (!be.ok) return no(be.message);
    try {
      const px = priceString(be.ticks, m.tick, m.info.priceDecimals);
      const sl = p.stopLosses[0];
      if (sl) await this.api.moveStop(p.positionId, px, sl.id);
      else await this.api.addStop(p.positionId, px);
      return ok(`B/E stop ${px} sent`);
    } catch (e) {
      return no(`B/E failed: ${(e as Error).message}`);
    } finally {
      this.kick(0);
    }
  }

  /** Close every Vest position on `info`'s symbol, then cancel its resting orders. NEVER gated. */
  async flatten(info: SymbolInfo): Promise<Check> {
    const sym = info.symbol;
    let held = this.positions.filter((p) => p.symbol === sym);
    try {
      this.positions = await this.api.positions(true);
      this.positionsAt = this.deps.now();
      held = this.positions.filter((p) => p.symbol === sym);
    } catch (e) {
      this.write(`! positions read failed (${(e as Error).message}) — flattening the last known position`);
    }
    const lev = String(this.leverageFor(info));
    const out: string[] = [];
    let good = true;
    for (const p of held) {
      try {
        await this.api.close(sym, p.positionId, lev);
        out.push(`closed ${p.qty}`);
      } catch (e) {
        good = false;
        out.push(`✗ close ${p.positionId}: ${(e as Error).message}`);
      }
    }
    if (held.length === 0) out.push('no Vest position');
    const c = await this.cancelResting(sym);
    good = good && c.ok;
    out.push(c.message);
    this.entry = null;
    this.kick(0);
    return { ok: good, message: `FLATTEN ${sym}: ${out.join('; ')}` };
  }

  /** Cancel resting orders (on `symbol`, or every one when omitted). NEVER gated. */
  async cancelAll(symbol?: string): Promise<Check> {
    const r = await this.cancelResting(symbol);
    this.kick(0);
    return r;
  }

  private async cancelResting(symbol?: string): Promise<Check> {
    let orders = this.orders;
    try {
      this.orders = await this.api.orders(true);
      orders = this.orders;
    } catch (e) {
      this.write(`! open-orders read failed (${(e as Error).message}) — cancelling the last known orders`);
    }
    const mine = symbol ? orders.filter((o) => o.symbol === undefined || o.symbol === symbol) : orders;
    let failed = 0;
    for (const o of mine) {
      try {
        await this.api.cancel(o.orderId);
      } catch (e) {
        failed++;
        this.write(`✗ cancel ${o.orderId}: ${(e as Error).message}`);
      }
    }
    return { ok: failed === 0, message: `cancelled ${mine.length - failed}/${mine.length} resting order(s)` };
  }

  // ───────────── polling ─────────────

  /** One positions + orders read (plus balances every ~10 s). Public for tests. */
  async poll(): Promise<void> {
    if (this.polling || !this.account) return;
    this.polling = true;
    const started = this.deps.now();
    try {
      const [pos, ord] = await Promise.all([this.api.positions(), this.api.orders()]);
      this.positions = pos;
      this.orders = ord;
      this.positionsAt = this.deps.now();
      this.pollError = '';
      this.pollMs = POLL_MS;
      if (started - this.lastAccountPoll >= ACCOUNT_POLL_MS) {
        this.lastAccountPoll = started;
        await this.refreshBalances().catch((e) => (this.pollError = `balance: ${(e as Error).message}`));
      }
      await this.settleEntry(started);
    } catch (e) {
      this.pollError = (e as Error).message;
      if ((e as { status?: number }).status === 429) this.pollMs = Math.min(this.pollMs * 2, MAX_POLL_MS);
    } finally {
      this.polling = false;
      this.deps.onChange();
      if (this.repoll) {
        this.repoll = false;
        this.kick(0);
      }
    }
  }

  private async refreshBalances(): Promise<void> {
    const b = await this.api.balances();
    this.balance = this.account ? b.get(this.account.id) : undefined;
    if (this.account && this.mode === 'live') {
      // max_drawdown_limit can move (trailing drawdown); keep the floor current.
      const acc = (await this.api.activeAccounts()).find((a) => a.id === this.account!.id);
      if (acc) this.account = acc;
    }
  }

  /** The entry the user sent has shown up (or not): re-anchor its legs once, then release the lock. */
  private async settleEntry(pollStarted: number): Promise<void> {
    const e = this.entry;
    if (!e || pollStarted < e.respondedAt) return;
    const p = this.positions.find((x) => (e.positionId ? x.positionId === e.positionId : x.symbol === e.symbol));
    if (!p) {
      if (this.deps.now() - e.respondedAt >= ENTRY_CONFIRM_MS) {
        this.write(`! entry on ${e.symbol} not seen as a Vest position after ${ENTRY_CONFIRM_MS / 1000} s — check Vest`);
        this.entry = null;
      }
      return;
    }
    // The legs may attach a moment after the fill: wait for the ones we sent before re-anchoring.
    const legsMissing = (e.tpTicks > 0 && p.takeProfits.length === 0) || (e.slTicks > 0 && p.stopLosses.length === 0);
    const timedOut = this.deps.now() - e.respondedAt >= ENTRY_CONFIRM_MS;
    if (legsMissing && !timedOut) return;
    this.entry = null;
    this.write(`✓ position ${p.positionId}: ${p.qty} @ ${p.openPrice}`);
    if (legsMissing) this.write('! a TP/SL leg that was sent is not on the Vest position — check Vest');
    const plan = reanchorPlan(p, e.tick, e.tpTicks, e.slTicks);
    try {
      if (plan.tp) await this.api.moveTarget(p.positionId, priceString(plan.tp.ticks, e.tick, e.priceDecimals), plan.tp.leg.id);
      if (plan.sl) await this.api.moveStop(p.positionId, priceString(plan.sl.ticks, e.tick, e.priceDecimals), plan.sl.leg.id);
    } catch (err) {
      this.write(`✗ re-anchor failed: ${(err as Error).message} — check the legs on Vest`);
    }
    if (plan.tp || plan.sl) this.kick(0);
  }

  private kick(ms: number): void {
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = this.setTimer(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.pollTimer = null;
    await this.poll();
    if (this.mode === 'live' || this.hasExposure()) this.kick(this.pushOpen ? Math.max(this.pollMs, PUSH_POLL_MS) : this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  /** Adds a line to the LIVE log (action results from the panel). */
  note(line: string): void {
    this.write(line);
  }

  private write(line: string): void {
    const t = new Date(this.deps.now()).toLocaleTimeString([], { hour12: false });
    this.log.unshift(`${t}  ${line}`);
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
    this.deps.onChange();
  }
}
