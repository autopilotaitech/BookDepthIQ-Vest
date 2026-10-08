import { bestAsk, bestBid, bookFromDepth, midTicks, spreadTicks, type Book } from '../book/book.js';
import { ladderScore } from '../book/stats.js';
import { PaperBroker, type Result, type Side } from '../sim/paper.js';
import { failFloor, preTradeCheck, type AccountSpec } from '../sim/account.js';
import { BasisTracker, SpreadWindow } from './ladderMath.js';
import { fetchExchangeInfo, fetchRecentTrades } from '../vest/rest.js';
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
          this.changed();
        },
        onTrade: (sym, msg) => {
          if (sym !== this.info?.symbol) return;
          const t = Math.round(Number(msg.data.price) / this.tick);
          const q = Number(msg.data.qty);
          this.lastTradeTicks = t;
          this.volumeAt.set(t, (this.volumeAt.get(t) ?? 0) + q);
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
      if (this.lastTradeTicks === undefined && this.tape[0]) this.lastTradeTicks = this.tape[0].priceTicks;
      this.changed();
    } catch (e) {
      this.note(`recent trades unavailable: ${(e as Error).message}`);
    }
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
