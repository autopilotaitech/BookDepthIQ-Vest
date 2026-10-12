// Panel-held stop entries (buy stop / sell stop) for LIVE. Pure: no I/O.
//
// Vest has no stop entry type (its app offers market and limit only), so the PANEL holds the stop
// and, when a trade prints at or through it, sends a MARKET entry. This is the one sanctioned
// exception to CLAUDE.md rule 2 (owner's explicit OK, 2026-10-09): the order is still the user's —
// armed by a click, at the user's price, size and brackets — but it fires without a click.
// One-shot. The stop exists only in the panel; Vest sees nothing until it fires.

import type { Check } from './rules.js';

export type StopSide = 'buy' | 'sell';

export interface ArmedStop {
  id: number;
  symbol: string; // wire
  side: StopSide;
  /** Trigger price in ticks. Buy stops fire on a trade ≥ this; sell stops on a trade ≤ this. */
  ticks: number;
  /** Size and brackets captured when armed (the user's numbers at that moment). */
  units: number;
  bracketsOn: boolean;
  tpTicks: number;
  slTicks: number;
  /** Trailing stop start (× risk) for the position it opens; 0/absent = off. */
  trailStartR?: number;
  /** Or a SuperTrend trail: 1 = ST1, 2 = ST2. */
  trailLine?: 1 | 2;
  /** 'touch' (default): fires on the first trade at/through the stop. 'close': only when a ONE-MINUTE
   * CLOSE is at/through it (owner OK 2026-10-12), so a wick through the level does not fire it. */
  confirm?: 'touch' | 'close';
  armedAt: number;
}

export class StopBook {
  private stops: ArmedStop[] = [];
  private nextId = 1;
  /** Per symbol: the minute of the last trade and its price (that minute's close so far). */
  private tape = new Map<string, { minute: number; last: number }>();

  /** Arm a stop. Refused when it would fire at once (buy stop not above the ask, sell stop not below the bid). */
  arm(s: Omit<ArmedStop, 'id'>, bid: number | undefined, ask: number | undefined): Check & { stop?: ArmedStop } {
    if (!(s.units > 0)) return { ok: false, message: 'stop size must be > 0' };
    if (bid === undefined || ask === undefined) return { ok: false, message: 'no book yet — cannot place a stop' };
    if (s.side === 'buy' && s.ticks <= ask) return { ok: false, message: 'a buy stop must be above the ask (use BUY MKT, or a limit below)' };
    if (s.side === 'sell' && s.ticks >= bid) return { ok: false, message: 'a sell stop must be below the bid (use SELL MKT, or a limit above)' };
    const stop: ArmedStop = { ...s, id: this.nextId++ };
    this.stops.push(stop);
    return { ok: true, message: `${s.side.toUpperCase()} STOP armed`, stop };
  }

  list(symbol?: string): ArmedStop[] {
    return this.stops.filter((s) => symbol === undefined || s.symbol === symbol);
  }

  get size(): number {
    return this.stops.length;
  }

  cancel(id: number): boolean {
    const n = this.stops.length;
    this.stops = this.stops.filter((s) => s.id !== id);
    return this.stops.length < n;
  }

  /** Move a stop; refused (stays put) if the new price would fire at once. */
  move(id: number, ticks: number, bid: number | undefined, ask: number | undefined): Check {
    const s = this.stops.find((x) => x.id === id);
    if (!s) return { ok: false, message: 'stop not armed any more' };
    if (bid === undefined || ask === undefined) return { ok: false, message: 'no book yet' };
    if (s.side === 'buy' && ticks <= ask) return { ok: false, message: 'a buy stop must stay above the ask' };
    if (s.side === 'sell' && ticks >= bid) return { ok: false, message: 'a sell stop must stay below the bid' };
    s.ticks = ticks;
    return { ok: true, message: 'stop moved' };
  }

  /** Remove every stop (on `symbol`, or all). Returns how many were cleared. */
  clear(symbol?: string): number {
    const n = this.stops.length;
    this.stops = symbol === undefined ? [] : this.stops.filter((s) => s.symbol !== symbol);
    return n - this.stops.length;
  }

  /**
   * A trade printed: remove and return every stop it triggers (one-shot). Touch stops fire on this
   * trade; close stops fire on the first trade of a new minute when the PREVIOUS minute closed
   * at/through them.
   */
  onTrade(symbol: string, priceTicks: number, nowMs = Date.now()): ArmedStop[] {
    const minute = Math.floor(nowMs / 60_000);
    const prev = this.tape.get(symbol);
    const closed = prev && minute > prev.minute ? prev.last : undefined;
    this.tape.set(symbol, { minute, last: priceTicks });
    const hit = (s: ArmedStop, px: number) => (s.side === 'buy' ? px >= s.ticks : px <= s.ticks);
    const fired = this.stops.filter((s) => s.symbol === symbol && (s.confirm === 'close' ? closed !== undefined && hit(s, closed) : hit(s, priceTicks)));
    if (fired.length) this.stops = this.stops.filter((s) => !fired.includes(s));
    return fired;
  }
}
