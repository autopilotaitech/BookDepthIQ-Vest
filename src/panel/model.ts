import { bestAsk, bestBid, bookFromDepth, midTicks, spreadTicks, type Book } from '../book/book.js';
import { ladderScore } from '../book/stats.js';
import { signedQty } from './profile.js';
import { DualTrend, type DualSnapshot } from './supertrend.js';
import { DEFAULT_INDICATORS, type IndicatorCfg } from './indicators.js';
import { Vwap, sessionWindow } from './vwap.js';
import { DEFAULT_PAXOR, PaxOr, levelFactorTicks, orRoot, orSession } from './paxor.js';
import { PaperBroker, type Result, type Side } from '../sim/paper.js';
import { failFloor, preTradeCheck, type AccountSpec } from '../sim/account.js';
import { BasisTracker, SpreadWindow } from './ladderMath.js';
import { fetchExchangeInfo, fetchRecentTrades, fetchTradesBefore } from '../vest/rest.js';
import { buildSymbolTable, tickSizeOf, type SymbolTable } from '../vest/symbols.js';
import type { SymbolInfo, TickerData } from '../vest/types.js';
import { VestMarketSocket, type SocketFactory } from '../vest/ws.js';
import { LiveSession, type MarketCtx } from '../live/session.js';
import type { FetchLike } from '../vest/trading.js';

// Everything the panel shows, outside React. Market data is read-only from Vest. In PAPER mode
// orders go to the local PaperBroker; in LIVE mode they go to Vest through `live` (LiveSession),
// which holds every rule about real orders.

/** CME contract multiplier ($ per point) by Vest display root, for "≈ CME contracts" sizing.
 * Vest is linear 1:1 ($1/pt per unit), so units / multiplier = CME-equivalent contracts. */
export const CME_MULTIPLIER: Record<string, { full: number; micro?: number; name: string }> = {
  NQ: { full: 20, micro: 2, name: 'NQ' },
  ES: { full: 50, micro: 5, name: 'ES' },
  RTY: { full: 50, micro: 5, name: 'RTY' },
  CL: { full: 1000, micro: 100, name: 'CL' },
  GC: { full: 100, micro: 10, name: 'GC' },
  SI: { full: 5000, micro: 1000, name: 'SI' },
  HG: { full: 25000, micro: 2500, name: 'HG' },
  NG: { full: 10000, micro: 1000, name: 'NG' },
  BZ: { full: 1000, name: 'BZ' },
  PL: { full: 50, name: 'PL' },
};

export function displayRoot(info: SymbolInfo): string {
  return (info.displaySymbol ?? info.symbol).replace(/-PERP$/, '').replace(/-USD$/, '');
}

export interface TapeRow {
  id: string;
  priceTicks: number;
  qty: number;
  side: 'buy' | 'sell';
  time: number;
}

export type Status = 'connecting' | 'live' | 'reconnecting' | 'error';

export class PanelModel {
  table: SymbolTable | null = null;
  info: SymbolInfo | null = null;
  tick = 0.25;
  status: Status = 'connecting';
  statusDetail = '';
  book: Book | null = null;
  ticker: TickerData | null = null;
  tape: TapeRow[] = [];
  /** Volume printed at each price since the panel opened (ticks -> units). */
  volumeAt = new Map<number, number>();
  /** Aggressive buys − aggressive sells per price (ticks), since the panel opened. Vest's trade
   * `side` is the taker's side. */
  deltaAt = new Map<number, number>();
  /** Session cumulative delta. */
  cumDelta = 0;
  /** Footprint: volume that lifted the ask / hit the bid at each price (ticks). */
  boughtAt = new Map<number, number>();
  soldAt = new Map<number, number>();
  /** Cumulative delta after each trade, newest last (for the header sparkline). */
  cumDeltaHist: number[] = [];
  /** Dual SuperTrend (BookDepthIQ's engine and defaults), fed by Vest trades. */
  trend = new DualTrend();
  trendSnap: DualSnapshot = this.trend.snapshot();
  /** Most recent flip: which line, new direction, when (ms). */
  lastFlip: { line: 1 | 2; dir: 'up' | 'down'; at: number } | null = null;
  /** Live trades fed to the trend; REST seeding only runs before the first one. */
  private trendLive = 0;
  /** Indicator settings for the symbol on screen (set by the panel). */
  ind: IndicatorCfg = DEFAULT_INDICATORS;
  /** Session VWAP over `vwapWin` (trade prices in ticks). */
  vwap = new Vwap();
  vwapWin: { from: number; to: number } | undefined;
  /** True while older session trades are still being paged in from Vest. */
  vwapLoading = false;
  /** RTH opening range + EXT ladder (BookDepthIQ PAXOR), NQ/ES only; undefined when off/none. */
  or: PaxOr | undefined;
  orLoading = false;
  private orKey = '';
  /** True when the trades since the bell were too many to page in fully (EXT ladder may be short). */
  orPartial = false;
  /** Live trades that arrive while OR history is loading, replayed after the rebuild. */
  private orPending: Array<{ time: number; ticks: number }> = [];
  private vwapKey = '';
  private vwapCheckAt = 0;

  lastTradeTicks: number | undefined;
  ladder = 0;
  broker: PaperBroker | null = null;
  /** One paper account per symbol. A symbol with a position or working orders stays subscribed
   * after you switch away, so its stops and brackets keep working. */
  brokers = new Map<string, PaperBroker>();
  log: string[] = [];
  /** Paper prop account. Cross-margined across every symbol's paper broker, like Vest. */
  account: AccountSpec = { startEquity: 500, maxDrawdownUsd: 10, leverage: 25 };
  /** Set the moment equity touches the fail floor. Mirrors Vest closing the account. */
  failed = false;
  /** This market's own recent spread distribution — "wide" is judged against it. */
  spreadWin = new SpreadWindow();
  /** Slow (mid − index) gap; index + basis = where the index says Vest's mid should be. */
  basisTracker = new BasisTracker();
  /** Index-implied Vest mid, in ticks. */
  impliedTicks: number | undefined;

  /** The real-Vest side. Starts in PAPER on every launch. */
  live: LiveSession;

  private sock: VestMarketSocket | null = null;
  private listeners = new Set<() => void>();
  private dirty = false;
  private raf: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly factory?: SocketFactory) {
    this.live = new LiveSession({
      fetch: ((url, init) => globalThis.fetch(url, init)) as FetchLike,
      uuid: () => crypto.randomUUID(),
      now: () => Date.now(),
      onChange: () => this.changed(),
      privateSocket: (url, protocols) => new WebSocket(url, protocols),
    });
  }

  /** Book and symbol context for a LIVE action on the symbol on screen. */
  marketCtx(): MarketCtx | null {
    if (!this.info) return null;
    return { info: this.info, tick: this.tick, bid: this.book ? bestBid(this.book) : undefined, ask: this.book ? bestAsk(this.book) : undefined };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Coalesces bursts into at most ~20 UI updates a second. */
  changed(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.raf = setTimeout(() => {
      this.dirty = false;
      for (const fn of this.listeners) fn();
    }, 50);
  }

  async start(symbol: string): Promise<void> {
    try {
      this.table = buildSymbolTable(await fetchExchangeInfo());
    } catch (e) {
      this.status = 'error';
      this.statusDetail = `exchangeInfo failed: ${(e as Error).message}`;
      this.changed();
      return;
    }
    this.sock = new VestMarketSocket(
      {
        onStatus: (s, d) => {
          this.status = s === 'open' ? 'live' : 'reconnecting';
          this.statusDetail = d ?? '';
          this.changed();
        },
        onRejected: (s, r) => this.note(`stream ${s} rejected: ${r}`),
        onDepth: (sym, msg) => {
          const info = this.table?.resolve(sym);
          if (!info) return;
          const book = bookFromDepth(msg, tickSizeOf(info));
          this.brokers.get(sym)?.onBook(book);
          this.checkBreach();
          if (sym !== this.info?.symbol) {
            this.releaseIfIdle(sym);
            return;
          }
          this.book = book;
          const sp = spreadTicks(book);
          if (sp !== undefined) this.spreadWin.push(sp, Date.now());
          this.ladder = ladderScore([...book.bids.sizes, ...book.asks.sizes]).score;
          const bidSum = book.bids.sizes.reduce((a, b) => a + b, 0);
          const askSum = book.asks.sizes.reduce((a, b) => a + b, 0);
          if (bidSum + askSum > 0) this.trend.setBookImbalance((bidSum - askSum) / (bidSum + askSum));
          this.changed();
        },
        onTrade: (sym, msg) => {
          if (sym !== this.info?.symbol) return;
          const t = Math.round(Number(msg.data.price) / this.tick);
          const q = Number(msg.data.qty);
          this.lastTradeTicks = t;
          this.volumeAt.set(t, (this.volumeAt.get(t) ?? 0) + q);
          const sq = signedQty(msg.data.side, q);
          this.deltaAt.set(t, (this.deltaAt.get(t) ?? 0) + sq);
          this.cumDelta += sq;
          this.feedTrend(msg.data.time, t, q, msg.data.side === 'buy');
          this.onIndicatorTrade(msg.data.time, t, q);
          this.trendLive++;
          const side = msg.data.side === 'buy' ? this.boughtAt : this.soldAt;
          side.set(t, (side.get(t) ?? 0) + q);
          this.cumDeltaHist.push(this.cumDelta);
          if (this.cumDeltaHist.length > 400) this.cumDeltaHist.splice(0, this.cumDeltaHist.length - 400);
          this.tape.unshift({ id: msg.data.id, priceTicks: t, qty: q, side: msg.data.side, time: msg.data.time });
          if (this.tape.length > 200) this.tape.length = 200;
          this.changed();
        },
        onTicker: (sym, msg) => {
          if (sym !== this.info?.symbol) return;
          this.ticker = msg.data;
          const idx = Number(msg.data.indexPrice) / this.tick;
          const md = this.book ? midTicks(this.book) : undefined;
          if (Number.isFinite(idx)) {
            if (md !== undefined) this.basisTracker.update(md, idx, Date.now());
            this.impliedTicks = this.basisTracker.implied(idx);
          }
          this.changed();
        },
      },
      undefined,
      this.factory,
    );
    this.sock.start();
    this.select(symbol);
  }

  select(name: string): boolean {
    const info = this.table?.resolve(name);
    if (!info || !this.sock) return false;
    const prev = this.info?.symbol;
    this.info = info;
    if (prev && prev !== info.symbol) this.releaseIfIdle(prev);
    this.tick = tickSizeOf(info);
    this.book = null;
    this.ticker = null;
    this.tape = [];
    this.volumeAt.clear();
    this.deltaAt.clear();
    this.cumDelta = 0;
    this.boughtAt.clear();
    this.soldAt.clear();
    this.cumDeltaHist = [];
    this.trend.reset();
    this.trendSnap = this.trend.snapshot();
    this.vwap.reset();
    this.vwapWin = undefined;
    this.vwapKey = '';
    this.or = undefined;
    this.orKey = '';
    this.lastFlip = null;
    this.trendLive = 0;
    this.lastTradeTicks = undefined;
    this.spreadWin = new SpreadWindow();
    this.basisTracker = new BasisTracker();
    this.impliedTicks = undefined;
    let broker = this.brokers.get(info.symbol);
    if (!broker) {
      broker = new PaperBroker({
        tickSize: this.tick,
        sizeDecimals: info.sizeDecimals,
        takerFee: Number(info.takerFee ?? 0) || 0,
        makerFee: Number(info.makerFee ?? 0) || 0,
      });
      if (this.broker) broker.bracket = { ...this.broker.bracket };
      this.brokers.set(info.symbol, broker);
    }
    this.broker = broker;
    this.sock.subscribe(info.symbol, ['depth', 'trades', 'ticker']);
    void this.seedTape(info.symbol);
    this.changed();
    return true;
  }

  /** Vest NQ can go a minute without a print; seed the tape from REST so it isn't blank. */
  private async seedTape(sym: string): Promise<void> {
    try {
      const rows = await fetchRecentTrades(sym);
      if (sym !== this.info?.symbol) return;
      const seen = new Set(this.tape.map((r) => r.id));
      const tick = this.tick;
      const older = rows
        .filter((r) => !seen.has(r.id))
        .map((r) => ({ id: r.id, priceTicks: Math.round(Number(r.price) / tick), qty: Number(r.qty), side: r.side, time: r.time }));
      this.tape = [...this.tape, ...older].sort((a, b) => b.time - a.time).slice(0, 200);
      // Warm the SuperTrend from Vest's recent trades, oldest first, if no live trade has
      // reached it yet (feeding older trades after newer ones would break the candles).
      if (this.trendLive === 0) for (const r of [...older].sort((a, b) => a.time - b.time)) this.feedTrend(r.time, r.priceTicks, r.qty, r.side === 'buy');
      if (this.lastTradeTicks === undefined && this.tape[0]) this.lastTradeTicks = this.tape[0].priceTicks;
      this.changed();
    } catch (e) {
      this.note(`recent trades unavailable: ${(e as Error).message}`);
    }
  }

  /** Panel → model: indicator settings for the symbol on screen. Re-anchors VWAP when its session changes. */
  configureIndicators(cfg: IndicatorCfg): void {
    this.ind = cfg;
    this.refreshVwapSession();
  }

  private onIndicatorTrade(timeMs: number, priceTicks: number, qty: number): void {
    if (Date.now() - this.vwapCheckAt > 30_000) this.refreshVwapSession();
    const w = this.vwapWin;
    if (this.ind.vwapOn && w && timeMs >= w.from && timeMs <= w.to) this.vwap.add(priceTicks, qty);
    this.or?.add(timeMs, priceTicks);
    if (this.orLoading) this.orPending.push({ time: timeMs, ticks: priceTicks });
  }

  /** Recompute the session window; on a new session (or settings change) reset and page in its trades. */
  private refreshVwapSession(): void {
    this.vwapCheckAt = Date.now();
    this.refreshOrSession();
    const sym = this.info?.symbol;
    const c = this.ind;
    const w = c.vwapOn && sym ? sessionWindow(Date.now(), c.vwapStart, c.vwapEnd, c.vwapTz) : undefined;
    const key = w && sym ? `${sym}|${w.from}|${w.to}` : '';
    if (key === this.vwapKey) return; // same session: keep the running VWAP
    this.vwapKey = key;
    this.vwap.reset();
    this.vwapWin = w;
    if (w && sym) void this.loadVwapHistory(sym, key, w);
    this.changed();
  }

  /** RTH opening range for NQ/ES: new session (or settings change) → rebuild from Vest's trades. */
  private refreshOrSession(): void {
    const info = this.info;
    const root = orRoot(info?.displaySymbol ?? info?.symbol);
    const cfg = { ...DEFAULT_PAXOR, showMid: this.ind.orMid };
    const s = this.ind.orOn && root && info ? orSession(Date.now(), cfg) : undefined;
    const key = s && info ? `${info.symbol}|${s.start}|${cfg.showMid}` : '';
    if (key === this.orKey) return;
    this.orKey = key;
    this.or = s && info ? new PaxOr(s, levelFactorTicks(root, cfg, this.tick), cfg.showMid) : undefined;
    if (this.or && info && Date.now() > s!.start) void this.loadOrHistory(info.symbol, key, this.or);
    this.changed();
  }

  /**
   * Rebuild the OR from Vest's public trades: first the 30 s bell window itself, then everything
   * since (≤ 120 pages of 1000), replayed oldest-first so the EXT ladder grows exactly as it would
   * have live. Live trades that arrive meanwhile are replayed after.
   */
  private async loadOrHistory(sym: string, key: string, or: PaxOr): Promise<void> {
    this.orLoading = true;
    this.orPending = [];
    this.orPartial = false;
    const s = or.session;
    const page = async (from: number, to: number, maxPages: number): Promise<Array<{ time: number; ticks: number }>> => {
      const out: Array<{ time: number; ticks: number }> = [];
      const seen = new Set<string>();
      let end = to;
      for (let i = 0; i < maxPages && end >= from; i++) {
        const batch = await fetchTradesBefore(sym, end, 1000);
        if (key !== this.orKey) return out;
        if (batch.length === 0) return out;
        for (const r of batch) {
          if (seen.has(r.id) || r.time < from || r.time > to) continue;
          seen.add(r.id);
          out.push({ time: r.time, ticks: Math.round(Number(r.price) / this.tick) });
        }
        const oldest = batch[batch.length - 1]!.time;
        if (oldest < from || oldest >= end) return out;
        end = oldest;
        if (i === maxPages - 1) this.orPartial = true; // ran out of pages before reaching `from`
      }
      return out;
    };
    try {
      const windowRows = await page(s.start, s.orbEnd - 1, 5);
      const postRows = Date.now() > s.orbEnd ? await page(s.orbEnd, Math.min(Date.now(), s.end), 120) : [];
      if (key !== this.orKey) return;
      const fresh = or.blank();
      const rows = [...windowRows, ...postRows].sort((x, y) => x.time - y.time);
      for (const r of rows) fresh.add(r.time, r.ticks);
      const last = rows.length ? rows[rows.length - 1]!.time : -Infinity;
      for (const p of this.orPending) if (p.time > last) fresh.add(p.time, p.ticks);
      this.or = fresh;
    } catch (e) {
      this.note(`opening range history unavailable: ${(e as Error).message}`);
    } finally {
      if (key === this.orKey) {
        this.orLoading = false;
        this.orPending = [];
        this.changed();
      }
    }
  }

  /** Page backwards through public trades from now to the session start (≤ 60 pages of 1000). */
  private async loadVwapHistory(sym: string, key: string, w: { from: number; to: number }): Promise<void> {
    this.vwapLoading = true;
    const edge = Math.min(Date.now(), w.to);
    let end = edge;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 60 && end >= w.from; page++) {
        const rows = await fetchTradesBefore(sym, end, 1000);
        if (key !== this.vwapKey) return; // settings or symbol changed meanwhile
        if (rows.length === 0) break;
        for (const r of rows) {
          if (seen.has(r.id) || r.time < w.from || r.time > edge) continue;
          seen.add(r.id);
          this.vwap.add(Math.round(Number(r.price) / this.tick), Number(r.qty));
        }
        const oldest = rows[rows.length - 1]!.time;
        if (oldest >= end) break;
        end = oldest; // trades sharing the oldest timestamp are de-duplicated by id
        this.changed();
      }
    } catch (e) {
      this.note(`VWAP history unavailable: ${(e as Error).message}`);
    } finally {
      if (key === this.vwapKey) {
        this.vwapLoading = false;
        this.changed();
      }
    }
  }

  private feedTrend(timeMs: number, priceTicks: number, qty: number, isBuy: boolean): void {
    const snap = this.trend.onTrade(timeMs, priceTicks, qty, isBuy);
    if (!snap) return;
    this.trendSnap = snap;
    if (snap.t1.switched && snap.t1.dir !== 'neutral') this.lastFlip = { line: 1, dir: snap.t1.dir, at: timeMs };
    else if (snap.t2.switched && snap.t2.dir !== 'neutral') this.lastFlip = { line: 2, dir: snap.t2.dir, at: timeMs };
  }

  /** Stop streaming a symbol that is not on screen and has nothing working. */
  private releaseIfIdle(sym: string): void {
    if (sym === this.info?.symbol) return;
    const b = this.brokers.get(sym);
    if (b && (b.position.qty !== 0 || b.orders.length > 0)) {
      this.sock?.unsubscribe(sym, ['trades', 'ticker']); // keep depth: it drives the fills
      return;
    }
    this.sock?.unsubscribe(sym, ['depth', 'trades', 'ticker']);
  }

  /** Symbols other than the one on screen that still hold a paper position or orders. */
  backgroundExposure(): Array<{ symbol: string; qty: number; orders: number }> {
    const out: Array<{ symbol: string; qty: number; orders: number }> = [];
    for (const [sym, b] of this.brokers) {
      if (sym === this.info?.symbol) continue;
      if (b.position.qty !== 0 || b.orders.length) out.push({ symbol: sym, qty: b.position.qty, orders: b.orders.length });
    }
    return out;
  }

  // ── paper prop account ──

  /** Equity across every paper broker, open PnL included (Vest: "Account Value"). */
  equity(): number {
    let e = this.account.startEquity;
    for (const b of this.brokers.values()) e += b.realizedUsd - b.feesUsd + b.unrealizedUsd();
    return e;
  }

  /** Open notional across every paper broker (cross margin, like Vest). */
  notionalUsd(): number {
    let n = 0;
    for (const b of this.brokers.values()) n += b.notionalUsd();
    return n;
  }

  floor(): number {
    return failFloor(this.account);
  }

  /** Vest fails the account the instant equity (incl. open PnL) goes below the floor. */
  private checkBreach(): void {
    if (this.failed || this.equity() >= this.floor()) return;
    this.failed = true;
    for (const b of this.brokers.values()) b.flatten();
    this.note(`✗ ACCOUNT FAILED — equity $${this.equity().toFixed(2)} below floor $${this.floor().toFixed(2)}. All paper positions closed.`);
  }

  /** Runs an ENTRY through the account checks first; exits are never blocked. */
  guarded(side: Side, units: number, price: number | undefined, run: () => Result): Result {
    const b = this.broker;
    if (!b) return { ok: false, message: 'no market' };
    if (price === undefined) return { ok: false, message: 'no price yet' };
    const chk = preTradeCheck({
      side,
      units,
      price: price,
      positionQty: b.position.qty,
      equity: this.equity(),
      leverage: this.account.leverage,
      failed: this.failed,
    });
    if (!chk.ok) return { ok: false, message: chk.message };
    const r = run();
    this.checkBreach();
    return r;
  }

  /** Fresh paper account: new brokers for every symbol, failure cleared. */
  resetPaper(): void {
    const bracket = this.broker?.bracket;
    this.brokers.clear();
    this.failed = false;
    if (this.info) {
      const keep = this.info.symbol;
      this.broker = null;
      this.select(keep);
      if (bracket && this.broker) (this.broker as PaperBroker).bracket = { ...bracket };
    }
    this.note('paper account reset');
  }

  stop(): void {
    this.live.stop();
    this.sock?.stop();
    if (this.raf) clearTimeout(this.raf);
  }

  note(line: string): void {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    this.log.unshift(`${t}  ${line}`);
    if (this.log.length > 50) this.log.length = 50;
    this.changed();
  }

  // ── derived values for the header ──
  spread(): number | undefined {
    return this.book ? spreadTicks(this.book) : undefined;
  }
  mid(): number | undefined {
    return this.book ? midTicks(this.book) : undefined;
  }
  basisBps(): number | undefined {
    const m = Number(this.ticker?.markPrice);
    const i = Number(this.ticker?.indexPrice);
    return Number.isFinite(m) && Number.isFinite(i) && i > 0 ? ((m - i) / i) * 1e4 : undefined;
  }
  cme(): { full: number; micro?: number; name: string } | undefined {
    return this.info ? CME_MULTIPLIER[displayRoot(this.info)] : undefined;
  }
}
