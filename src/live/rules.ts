import { tradingPower } from '../sim/account.js';
import { formatPrice } from '../sim/paper.js';
import type { Leg, LivePosition } from '../vest/tradingShapes.js';

// LIVE trading rules. Pure functions, no I/O (LIVE-ORDERS-SPEC §4–§5).
// The guard here applies to ENTRIES ONLY. Flatten, cancel and stop moves never pass through it.

export interface Check {
  ok: boolean;
  message: string;
}

/** Optional hard size cap in units, a user setting. 0 = off (the default): like Vest's own ticket,
 * size is limited by trading power only. The owner turned the 0.01 first-release cap off 2026-10-08. */
export const DEFAULT_LIVE_SIZE_CAP = 0;

export interface LiveEntryInput {
  units: number;
  sizeCap: number;
  canTrade: boolean;
  /** Expected fill: ask for a buy, bid for a sell. */
  price: number | undefined;
  /** Vest balance; undefined until it has been read. */
  equity: number | undefined;
  /** max_drawdown_limit; undefined until read. */
  floor: number | undefined;
  leverage: number;
  /** A Vest position already open on this symbol (adds are out of v1). */
  hasPosition: boolean;
  /** Positions were read successfully recently, so "flat" is known, not assumed. */
  positionsFresh: boolean;
  /** An entry was sent and its position has not shown up in a poll yet. */
  entryInFlight: boolean;
}

export function liveEntryCheck(i: LiveEntryInput): Check {
  if (!(i.units > 0)) return no('quantity must be > 0');
  if (i.sizeCap > 0 && i.units > i.sizeCap + 1e-12) return no(`${i.units}u is over the LIVE size cap ${i.sizeCap}u (settings)`);
  if (!i.canTrade) return no('account token says canTrade = false');
  if (i.entryInFlight) return no('previous entry not confirmed by Vest yet');
  if (!i.positionsFresh) return no('Vest positions not read recently — position unknown');
  if (i.hasPosition) return no('already in a position on this symbol — adds are paper-only in v1');
  if (i.price === undefined || !(i.price > 0)) return no('no price yet');
  if (i.equity === undefined || i.floor === undefined) return no('Vest balance / floor not loaded yet');
  if (i.equity <= i.floor) return no(`account at its floor ($${i.equity.toFixed(2)} ≤ $${i.floor.toFixed(2)})`);
  const notional = i.units * i.price;
  const power = tradingPower(i.equity, i.leverage);
  if (notional > power + 1e-6) return no(`$${notional.toFixed(0)} notional exceeds trading power $${power.toFixed(0)}`);
  return { ok: true, message: 'ok' };
}

const no = (message: string): Check => ({ ok: false, message });

/**
 * Leverage sent with an order: the account's saved value for the symbol (what Vest's own ticket
 * uses), else floor(1 / initMarginRatio) capped at the account's max_leverage. Never below 1.
 * The saved value is NOT capped: max_leverage on capital/accounts is stale (seen 2026-10-08: "5"
 * while Vest's ticket filled NQ at the saved 25x).
 */
export function resolveLeverage(saved: number | undefined, initMarginRatio: string | undefined, maxLeverage: number | undefined): number {
  if (saved !== undefined && saved > 0) return Math.max(1, Math.floor(saved));
  const imr = Number(initMarginRatio);
  const base = imr > 0 ? Math.floor(1 / imr + 1e-9) : 1;
  const capped = maxLeverage !== undefined && maxLeverage > 0 ? Math.min(base, maxLeverage) : base;
  return Math.max(1, Math.floor(capped));
}

/**
 * Bracket legs in ticks from a reference price in ticks. Same rounding as the paper sim: away from
 * the entry on the TP side, away on the SL side, so a fractional fill never tightens either leg.
 * 0 = no leg.
 */
export function bracketTicks(long: boolean, refTicks: number, tpTicks: number, slTicks: number): { tp?: number; sl?: number } {
  const out: { tp?: number; sl?: number } = {};
  if (tpTicks > 0) out.tp = long ? Math.ceil(refTicks - 1e-9) + tpTicks : Math.floor(refTicks + 1e-9) - tpTicks;
  if (slTicks > 0) out.sl = long ? Math.floor(refTicks + 1e-9) - slTicks : Math.ceil(refTicks - 1e-9) + slTicks;
  return out;
}

export interface Reanchor {
  tp?: { leg: Leg; ticks: number };
  sl?: { leg: Leg; ticks: number };
}

/**
 * After the fill: which legs sit more than one tick from openPrice ± the user's points (spec §4).
 * The fill can differ from the ask/bid the legs were priced from.
 */
export function reanchorPlan(p: LivePosition, tick: number, tpTicks: number, slTicks: number): Reanchor {
  const want = bracketTicks(p.qty > 0, p.openPrice / tick, tpTicks, slTicks);
  const out: Reanchor = {};
  const tp = p.takeProfits[0];
  const sl = p.stopLosses[0];
  if (tp && want.tp !== undefined && Math.abs(tp.triggerPrice / tick - want.tp) > 1 + 1e-9) out.tp = { leg: tp, ticks: want.tp };
  if (sl && want.sl !== undefined && Math.abs(sl.triggerPrice / tick - want.sl) > 1 + 1e-9) out.sl = { leg: sl, ticks: want.sl };
  return out;
}

/** Break-even stop in ticks: entry ± offset, refused if it would already be through the market. */
export function breakevenTicks(p: LivePosition, tick: number, offsetTicks: number, bid: number | undefined, ask: number | undefined): { ok: true; ticks: number } | { ok: false; message: string } {
  const long = p.qty > 0;
  const avg = p.openPrice / tick;
  const stop = long ? Math.floor(avg + 1e-9) + offsetTicks : Math.ceil(avg - 1e-9) - offsetTicks;
  if (bid === undefined || ask === undefined) return { ok: false, message: 'no book yet' };
  if (long && stop >= bid) return { ok: false, message: `B/E stop ${formatPrice(stop, tick)} is not below the bid ${formatPrice(bid, tick)}` };
  if (!long && stop <= ask) return { ok: false, message: `B/E stop ${formatPrice(stop, tick)} is not above the ask ${formatPrice(ask, tick)}` };
  return { ok: true, ticks: stop };
}

/** Open P&L marked at the price the position could exit at. */
export function liveOpenPnl(p: LivePosition, tick: number, bid: number | undefined, ask: number | undefined): number {
  const exit = p.qty > 0 ? bid : ask;
  return exit === undefined ? 0 : (exit * tick - p.openPrice) * p.qty;
}
