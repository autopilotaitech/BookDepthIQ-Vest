import type { Side } from '../sim/paper.js';
import { VestPrivateSocket, type PrivateSocketFactory } from '../vest/privateWs.js';
import { StopBook, type ArmedStop } from './stops.js';
import { VestTrading, type FetchLike } from '../vest/trading.js';
import {
  claimsExpMs,
  decimalString,
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
import { StopGuard, TrailBook } from './manage.js';
import { BeWatch, scaleOrders, splitTargets, type Piece, type SkewDir, type Target } from './targets.js';
import { DEFAULT_LIVE_SIZE_CAP, bracketTicks, breakevenTicks, liveEntryCheck, reanchorPlan, resolveLeverage, type Check } from './rules.js';

// The LIVE side of the panel: Vest account state, push + polling, and the actions (LIVE-ORDERS-SPEC §4).
// Vest's position is the truth — nothing here derives a position locally.
//
// Safety (spec §5):
// - Mode starts PAPER on every launch and is never persisted.
// - Entries go through liveEntryCheck. FLATTEN and CANCEL ALL go through NOTHING: not the mode, not
//   the guard, not a failed read, not an expiring token.
// - No order is sent except from a user action (click or armed hotkey), plus the one spec-mandated
//   follow-up (re-anchoring the legs of the entry the user just sent) and the owner-approved
//   exceptions: panel-held stop entries (stops.ts, 2026-10-09), B/E after TP1 (targets.ts,
//   2026-10-11), trailing stop and stop recovery (manage.ts, 2026-10-12).

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
  /** TP1..TP3 with the size split. Two or more on = partial targets (TP1 is tpTicks). */
  targets?: Target[];
  /** With 2+ targets: move the stop to entry ± beOffset once TP1 fills (owner-approved 2026-10-11). */
  beAfterTp1?: boolean;
  beOffset?: number;
  /** Trailing stop: start once price is this many × risk in your favour (0/absent = off). */
  trailStartR?: number;
}

/** Bracket legs in ticks for one entry: a stop for the whole size, then one target or several. */
type Legs = { sl?: number; tp?: number; tps?: Piece[] };

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
  private orderLegs = new Map<string, Legs>();
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
  /** Panel-held stop entries (fire a MARKET entry on a trade at/through the stop). See stops.ts. */
  readonly stops = new StopBook();
  /** Latest stop event (armed / fired / refused / disarmed), for the panel's result bar. */
  stopEvent: (Check & { at: number }) | null = null;
  /** B/E after TP1: watches the position of the entry that asked for it. See targets.ts. */
  readonly beWatch = new BeWatch();
  /** Latest market context from the trade feed (B/E after TP1 needs the bid/ask). */
  private lastMkt: { m: MarketCtx; at: number } | null = null;
  /** Trailing stops by symbol (manage.ts). */
  readonly trail = new TrailBook();
  private trailSeen = new Set<string>();
  private trailBusy = false;
  private trailAt = 0;
  private trailSent = new Map<string, number>();
  /** Stop recovery: re-place a stop that disappeared from a Vest position (setting, off by default). */
  stopGuardOn = false;
  private readonly guard = new StopGuard();
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
    if (h.bearer === 0) return `the Vest tab made ${h.apiCalls} api-gateway call(s) but none carried "Authorization: Bearer" — Vest may have changed how it authenticates`;
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
    this.disarmStops('back to PAPER');
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
    const legs = this.legsFor(long, ref!, qty, m, br);
    if ('message' in legs) return no(legs.message);
    let input: OpenMarketInput;
    try {
      input = {
        symbol: m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(qty, m.info.sizeDecimals),
        leverage: String(lev),
        ...this.legStrings(legs, m),
      };
    } catch (e) {
      return no((e as Error).message);
    }
    this.busy = true;
    this.deps.onChange();
    try {
      const r = await this.api.open(input);
      this.armBe(legs, m, br);
      this.armTrail(legs, m, br);
      // Partial targets are priced from the expected fill and not re-anchored (tpTicks 0): a PUT
      // has no quantity, so moving one could turn a partial target into a full one.
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
    const legs = this.legsFor(long, priceTicks, qty, m, br);
    if ('message' in legs) return no(legs.message);
    let input: OpenMarketInput & { price: string };
    try {
      input = {
        symbol: m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(qty, m.info.sizeDecimals),
        leverage: String(lev),
        price: priceString(priceTicks, m.tick, m.info.priceDecimals),
        ...this.legStrings(legs, m),
      };
    } catch (e) {
      return no((e as Error).message);
    }
    this.busy = true;
    this.deps.onChange();
    try {
      const r = await this.api.openLimit(input);
      this.armBe(legs, m, br);
      this.armTrail(legs, m, br);
      if (r.orderId) this.orderLegs.set(r.orderId, legs);
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
    // One order of a scale (it shares its pending position with others): re-place it the way Vest
    // added it, through /positions/append, with no legs.
    const pid = o.positionId;
    const shared = !!pid && (this.positions.some((p) => p.positionId === pid) || this.orders.some((x) => x.orderId !== orderId && x.positionId === pid));
    const known = this.orderLegs.get(orderId);
    const t = (p: number) => Math.round(p / m.tick);
    const vestTps = o.takeProfits.length > 1 && o.takeProfits.every((l) => l.quantity) ? o.takeProfits.map((l) => ({ ticks: t(l.triggerPrice), qty: l.quantity! })) : undefined;
    let legs: Legs = {};
    if (!shared) {
      const tps = vestTps ?? known?.tps;
      if (!tps && o.takeProfits.length > 1) return no('this order has several targets of unknown size — cancel it and place it again');
      const tp0 = o.takeProfits[0] ? t(o.takeProfits[0].triggerPrice) : known?.tp;
      const sl0 = o.stopLosses[0] ? t(o.stopLosses[0].triggerPrice) : known?.sl;
      legs = {
        tps: tps?.map((l) => ({ ticks: l.ticks + delta, qty: l.qty })),
        tp: tps || tp0 === undefined ? undefined : tp0 + delta,
        sl: sl0 === undefined ? undefined : sl0 + delta,
      };
      if (legs.tp === undefined && legs.sl === undefined && !legs.tps && br.bracketsOn) {
        const fresh = this.legsFor(long, toTicks, left, m, br);
        if ('message' in fresh) return no(fresh.message);
        legs = fresh;
      }
    }
    const lev = o.leverage ?? String(this.leverageFor(m.info));
    let input: OpenMarketInput & { price: string };
    try {
      input = {
        symbol: o.symbol ?? m.info.symbol,
        side: long ? 'long' : 'short',
        quantity: qtyString(left, m.info.sizeDecimals),
        leverage: lev,
        price: priceString(toTicks, m.tick, m.info.priceDecimals),
        ...this.legStrings(legs, m),
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
        const r = shared
          ? await this.api.appendLimit({ symbol: input.symbol, positionId: pid!, isBuy: long, quantity: input.quantity, price: input.price, leverage: lev })
          : await this.api.openLimit(input);
        if (r.orderId && !shared) this.orderLegs.set(r.orderId, legs);
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

  /** Drag a TP or SL leg (the `index`-th of its kind) of the open position to `toTicks` (PUT). */
  async moveLeg(kind: 'tp' | 'sl', toTicks: number, m: MarketCtx, index = 0): Promise<Check> {
    const p = this.positionFor(m.info.symbol);
    const leg = kind === 'tp' ? p?.takeProfits[index] : p?.stopLosses[index];
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
    const disarmed = this.stops.clear(sym);
    if (disarmed) out.push(`disarmed ${disarmed} stop(s)`);
    if (this.beWatch.clear(sym)) out.push('B/E after TP1 off');
    if (this.trail.clear(sym)) out.push('trailing stop off');
    const c = await this.cancelResting(sym);
    good = good && c.ok;
    out.push(c.message);
    this.entry = null;
    this.kick(0);
    return { ok: good, message: `FLATTEN ${sym}: ${out.join('; ')}` };
  }

  /** Cancel resting orders (on `symbol`, or every one when omitted). NEVER gated. */
  async cancelAll(symbol?: string): Promise<Check> {
    this.beWatch.clear(symbol);
    this.trail.clear(symbol);
    const disarmed = this.stops.clear(symbol);
    const r = await this.cancelResting(symbol);
    this.kick(0);
    return disarmed ? { ok: r.ok, message: `${r.message}; disarmed ${disarmed} stop(s)` } : r;
  }

  // ───────────── panel-held stop entries ─────────────

  /** Arm a buy stop (above the ask) or sell stop (below the bid). LIVE only, needs a fresh login. */
  armStop(side: Side, ticks: number, units: number, m: MarketCtx, br: BracketCtx): Check {
    if (this.mode !== 'live') return no('stops are LIVE only (PAPER has its own stop orders)');
    if (!this.tokenOk()) return no(`no Vest login: ${this.loginProblem()}`);
    const f = 10 ** m.info.sizeDecimals;
    const r = this.stops.arm(
      { symbol: m.info.symbol, side, ticks, units: Math.round(units * f) / f, bracketsOn: br.bracketsOn, tpTicks: br.tpTicks, slTicks: br.slTicks, trailStartR: br.trailStartR, armedAt: this.deps.now() },
      m.bid,
      m.ask,
    );
    if (r.ok) this.write(`⚡ ${side.toUpperCase()} STOP ${r.stop!.units} armed @ ${priceString(ticks, m.tick, m.info.priceDecimals)} — panel-held, fires a MARKET entry`);
    this.deps.onChange();
    return r.ok ? ok(`${side.toUpperCase()} STOP armed @ ${priceString(ticks, m.tick, m.info.priceDecimals)} (panel-held: keep this window open)`) : no(r.message);
  }

  cancelStop(id: number): Check {
    const done = this.stops.cancel(id);
    if (done) this.write('stop cancelled');
    this.deps.onChange();
    return done ? ok('stop cancelled') : no('stop not armed any more');
  }

  moveStop(id: number, ticks: number, m: MarketCtx): Check {
    const r = this.stops.move(id, ticks, m.bid, m.ask);
    if (r.ok) this.write(`stop moved to ${priceString(ticks, m.tick, m.info.priceDecimals)}`);
    this.deps.onChange();
    return r;
  }

  /** Disarm every stop (connection lost, instrument switch, PAPER, login gone). Never sends anything. */
  disarmStops(reason: string): void {
    const n = this.stops.clear();
    const be = this.beWatch.clear();
    const tr = this.trail.clear();
    if (!n && !be && !tr) return;
    const what = [n ? `${n} stop(s)` : '', be ? 'B/E after TP1' : '', tr ? 'trailing stop' : ''].filter(Boolean).join(' + ');
    this.write(`! ${what} DISARMED: ${reason}`);
    this.stopEvent = { ok: false, message: `${what} disarmed — ${reason}`, at: this.deps.now() };
    this.deps.onChange();
  }

  /**
   * A trade printed on `m.info.symbol`. Fires any stop it hits as a MARKET entry with the stop's own
   * size and brackets, through the normal entry checks. One-shot: a refused stop is gone, and says why.
   */
  async onMarketTrade(priceTicks: number, m: MarketCtx): Promise<void> {
    this.lastMkt = { m, at: this.deps.now() };
    if (this.trail.size) void this.trailOnTrade(priceTicks, m); // never holds up a stop entry
    if (this.stops.size === 0) return;
    if (this.mode !== 'live') return this.disarmStops('not in LIVE');
    if (!this.tokenOk()) return this.disarmStops('Vest login expired');
    const fired: ArmedStop[] = this.stops.onTrade(m.info.symbol, priceTicks);
    for (const s of fired) {
      const px = priceString(s.ticks, m.tick, m.info.priceDecimals);
      this.write(`⚡ ${s.side.toUpperCase()} STOP @ ${px} hit (trade ${priceString(priceTicks, m.tick, m.info.priceDecimals)}) — sending MARKET ${s.units}`);
      const r = await this.enter(s.side, s.units, m, { bracketsOn: s.bracketsOn, tpTicks: s.tpTicks, slTicks: s.slTicks, trailStartR: s.trailStartR });
      this.stopEvent = { ok: r.ok, message: `STOP @ ${px}: ${r.message}`, at: this.deps.now() };
      this.write(`${r.ok ? '✓' : '✗'} STOP @ ${px}: ${r.message}`);
      this.deps.onChange();
    }
  }

  // ───────────── partial targets, scale, B/E after TP1 ─────────────

  private legsFor(long: boolean, refTicks: number, qty: number, m: MarketCtx, br: BracketCtx): Legs | { message: string } {
    if (!br.bracketsOn) return {};
    const sl = bracketTicks(long, refTicks, 0, br.slTicks).sl;
    const on = (br.targets ?? []).filter((t) => t.ticks > 0);
    if (on.length < 2) return { sl, tp: bracketTicks(long, refTicks, br.tpTicks, 0).tp };
    const split = splitTargets(qty, m.info.sizeDecimals, on);
    if (!split.ok) return { message: split.message };
    return { sl, tps: split.legs.map((l) => ({ ticks: bracketTicks(long, refTicks, l.ticks, 0).tp!, qty: l.qty })) };
  }

  private legStrings(l: Legs, m: MarketCtx): Pick<OpenMarketInput, 'takeProfit' | 'stopLoss' | 'takeProfitLegs'> {
    const px = (t: number) => priceString(t, m.tick, m.info.priceDecimals);
    return {
      takeProfit: l.tp === undefined || l.tps ? undefined : px(l.tp),
      takeProfitLegs: l.tps?.map((x) => ({ triggerPrice: px(x.ticks), quantity: qtyString(x.qty, m.info.sizeDecimals) })),
      stopLoss: l.sl === undefined ? undefined : px(l.sl),
    };
  }

  private armBe(l: Legs, m: MarketCtx, br: BracketCtx): void {
    if (!l.tps || l.tps.length < 2 || !br.beAfterTp1) return;
    this.beWatch.arm(m.info.symbol, br.beOffset ?? 0);
    this.write(`⚡ B/E after TP1 armed on ${m.info.symbol}: the panel moves the stop to entry ± offset when TP1 fills (keep this window open)`);
  }

  /**
   * Scale order, as Vest's own Scale ticket sends it (read from its web app, 2026-10-11): `count`
   * limits from `startTicks` to `endTicks`; the first to /positions/open, the rest to
   * /positions/append with the positionId Vest returned. No TP/SL legs (Vest's scale has none):
   * press B/E once filled to add a stop. Same entry checks as a limit, at the furthest price.
   */
  async enterScale(side: Side, units: number, startTicks: number, endTicks: number, count: number, skew: number, dir: SkewDir, m: MarketCtx): Promise<Check> {
    if (this.mode !== 'live') return no('not in LIVE');
    const long = side === 'buy';
    const plan = scaleOrders(units, m.info.sizeDecimals, startTicks, endTicks, count, skew, dir);
    if (!plan.ok) return no(plan.message);
    const lev = this.leverageFor(m.info);
    const total = plan.legs.reduce((a, l) => a + l.qty, 0);
    const chk = liveEntryCheck({
      units: total,
      sizeCap: this.sizeCap,
      canTrade: this.canTrade,
      price: Math.max(startTicks, endTicks) * m.tick,
      equity: this.equity(),
      floor: this.floor(),
      leverage: lev,
      hasPosition: !!this.positionFor(m.info.symbol),
      positionsFresh: this.positionsFresh(),
      entryInFlight: this.entryInFlight(),
    });
    if (!chk.ok) return chk;
    let orders: Array<{ price: string; quantity: string }>;
    try {
      orders = plan.legs.map((l) => ({ price: priceString(l.ticks, m.tick, m.info.priceDecimals), quantity: qtyString(l.qty, m.info.sizeDecimals) }));
    } catch (e) {
      return no((e as Error).message);
    }
    const [first, ...rest] = orders;
    const symbol = m.info.symbol;
    this.busy = true;
    this.deps.onChange();
    try {
      let positionId: string | undefined;
      try {
        positionId = (await this.api.openLimit({ symbol, side: long ? 'long' : 'short', quantity: first!.quantity, leverage: String(lev), price: first!.price })).positionId;
      } catch (e) {
        return no(`scale: first order failed: ${(e as Error).message} — nothing sent`);
      }
      if (!positionId) return no(`scale: first order @ ${first!.price} sent, but Vest returned no positionId — the other ${rest.length} were NOT sent`);
      const failed: string[] = [];
      for (const o of rest) {
        try {
          await this.api.appendLimit({ symbol, positionId, isBuy: long, quantity: o.quantity, price: o.price, leverage: String(lev) });
        } catch (e) {
          failed.push(`${o.price}: ${(e as Error).message}`);
        }
      }
      const what = `SCALE ${side.toUpperCase()} ${qtyString(total, m.info.sizeDecimals)} in ${orders.length} limits ${first!.price} → ${orders.at(-1)!.price}`;
      return failed.length ? no(`${what}: ${orders.length - failed.length}/${orders.length} sent; failed ${failed.join('; ')}`) : ok(`${what} sent to Vest (no TP/SL: press B/E once filled)`);
    } finally {
      this.busy = false;
      this.kick(0);
      this.deps.onChange();
    }
  }

  /** After a poll: has TP1 of a watched position filled? If so, send the B/E stop once. */
  private async checkBeWatch(): Promise<void> {
    const sym = this.beWatch.symbol;
    if (!sym) return;
    const offset = this.beWatch.offsetTicks;
    const r = this.beWatch.check(this.positionFor(sym));
    if (r === 'gone') this.write('B/E after TP1: position closed — watch ended');
    if (r !== 'fire') return;
    const lm = this.lastMkt;
    let res: Check;
    if (this.mode !== 'live') res = no('not in LIVE');
    else if (!lm || lm.m.info.symbol !== sym || this.deps.now() - lm.at > 30_000) res = no('no fresh book for that instrument — press B/E yourself');
    else res = await this.breakeven(lm.m, offset);
    this.stopEvent = { ok: res.ok, message: `TP1 filled → ${res.message}`, at: this.deps.now() };
    this.write(`${res.ok ? '✓' : '✗'} TP1 filled → ${res.message}`);
    this.deps.onChange();
  }

  // ───────────── close half, trailing stop, stop recovery ─────────────

  /**
   * Close `fraction` of the position on `info`'s symbol at market (POST /v3/positions/reduce, the
   * request Vest's own ticket uses). An exit: NEVER gated, works in either mode.
   */
  async closePart(info: SymbolInfo, fraction: number): Promise<Check> {
    const p = this.positionFor(info.symbol);
    if (!p) return no('flat on Vest — nothing to close');
    const f = 10 ** info.sizeDecimals;
    const q = Math.floor(Math.abs(p.qty) * fraction * f + 1e-9) / f;
    if (!(q > 0) || q >= Math.abs(p.qty)) return no(`${Math.abs(p.qty)} is too small to split — use FLATTEN`);
    const qty = qtyString(q, info.sizeDecimals);
    try {
      await this.api.reduce(info.symbol, p.positionId, qty, String(this.leverageFor(info)));
      return ok(`closed ${qty} of ${Math.abs(p.qty)} at market`);
    } catch (e) {
      return no(`close ${qty} failed: ${(e as Error).message}`);
    } finally {
      this.kick(0);
    }
  }

  private armTrail(l: Legs, m: MarketCtx, br: BracketCtx): void {
    const start = br.trailStartR ?? 0;
    if (!(start > 0) || l.sl === undefined || !(br.slTicks > 0)) return;
    this.trail.arm(m.info.symbol, br.slTicks, start);
    this.trailSeen.delete(m.info.symbol);
    this.trailSent.delete(m.info.symbol);
    this.write(`⚡ trailing stop armed on ${m.info.symbol}: starts at ${start}R, keeps 1R (${br.slTicks} ticks) behind the best price (keep this window open)`);
  }

  /** A trade on the shown market: move its trailing stop if the best price has earned it. */
  private async trailOnTrade(priceTicks: number, m: MarketCtx): Promise<void> {
    const sym = m.info.symbol;
    if (!this.trail.has(sym) || this.mode !== 'live') return;
    const p = this.positionFor(sym);
    if (!p) return; // a limit entry may not have filled yet
    this.trailSeen.add(sym);
    const sl = p.stopLosses[0];
    const cur = sl ? Math.round(sl.triggerPrice / m.tick) : undefined;
    const long = p.qty > 0;
    const want = this.trail.onTrade(sym, long, p.openPrice / m.tick, priceTicks, cur);
    const now = this.deps.now();
    if (want === undefined || !sl || this.trailBusy || now - this.trailAt < 1000 || this.trailSent.get(sym) === want) return;
    // A stop must rest on the safe side of the market.
    if (long ? m.bid === undefined || want >= m.bid : m.ask === undefined || want <= m.ask) return;
    this.trailBusy = true;
    this.trailAt = now;
    const px = priceString(want, m.tick, m.info.priceDecimals);
    try {
      await this.api.moveStop(p.positionId, px, sl.id);
      this.trailSent.set(sym, want);
      this.write(`⚡ trailing stop → ${px}`);
    } catch (e) {
      this.write(`✗ trailing stop move to ${px} failed: ${(e as Error).message}`);
    } finally {
      this.trailBusy = false;
      this.kick(0);
    }
  }

  /** A trailed position that has closed ends its trail. */
  private endTrails(): void {
    for (const sym of [...this.trailSeen]) {
      if (this.positionFor(sym)) continue;
      this.trailSeen.delete(sym);
      if (this.trail.clear(sym)) this.write(`trailing stop on ${sym}: position closed — trail ended`);
    }
  }

  /** Stop recovery: a stop that vanished from a Vest position is put back at its last price. */
  private async guardStops(): Promise<void> {
    if (!this.stopGuardOn || this.mode !== 'live' || !this.tokenOk()) return;
    const redo = this.guard.check(
      this.positions.map((p) => ({ positionId: p.positionId, stop: p.stopLosses[0]?.triggerPrice })),
      this.deps.now(),
    );
    for (const r of redo) {
      const px = decimalString(r.stop, 10);
      this.write(`! STOP MISSING on position ${r.positionId} — re-placing it at ${px}`);
      let res: Check;
      try {
        await this.api.addStop(r.positionId, px);
        res = ok(`stop was missing — re-placed at ${px}`);
      } catch (e) {
        res = no(`STOP MISSING — re-place at ${px} failed: ${(e as Error).message}. Set a stop or FLATTEN`);
      }
      this.stopEvent = { ...res, at: this.deps.now() };
      this.write(`${res.ok ? '✓' : '✗'} ${res.message}`);
      this.kick(0);
    }
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
      await this.checkBeWatch();
      this.endTrails();
      await this.guardStops();
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
