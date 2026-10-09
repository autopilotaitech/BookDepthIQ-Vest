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
  armedAt: number;
}

export class StopBook {
  private stops: ArmedStop[] = [];
  private nextId = 1;

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

  /** A trade printed: remove and return every stop it triggers (one-shot). */
  onTrade(symbol: string, priceTicks: number): ArmedStop[] {
    const fired = this.stops.filter((s) => s.symbol === symbol && (s.side === 'buy' ? priceTicks >= s.ticks : priceTicks <= s.ticks));
    if (fired.length) this.stops = this.stops.filter((s) => !fired.includes(s));
    return fired;
  }
}
