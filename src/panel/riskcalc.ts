// The Risk calculator: what a size, stop and leverage mean for a Vest prop account, on any market.
// Pure: no I/O.
//
// Every Vest perp is linear: 1 unit = $1 per 1.00 of price (confirmed on NQ: 1 NQ = 20 units), so
// $ per point = units on every market. The account FAILS when equity incl. open P&L reaches the
// drawdown floor; that, not liquidation, is the binding limit (docs/DESIGN.md).

export interface RiskInput {
  balance: number;
  /** $ the account may still lose before it fails (equity − floor). */
  room: number;
  /** Max leverage on this market for this account: min(1 / initMarginRatio, account max). */
  levCap: number;
  price: number;
  /** Taker fee, fraction of notional (both ways counted). */
  feeRate: number;
  stopPts: number;
  targetPts: number;
  /** 'risk': size from `riskUsd` at the stop. 'lev': size from `lev`. */
  mode: 'risk' | 'lev';
  riskUsd: number;
  lev: number;
  sizeDecimals: number;
}

export interface RiskOut {
  units: number;
  /** Risk sizing wanted more than the leverage cap allows; size was cut to the cap. */
  capped: boolean;
  maxUnits: number;
  notional: number;
  levUsed: number;
  /** Round-trip taker fees, $. */
  fees: number;
  /** $ lost at the stop / won at the target, fees included. */
  loss: number;
  win: number;
  rr: number;
  /** Points against the entry before the account fails, and before equity is gone (≈ liquidation). */
  failPts: number;
  liqPts: number;
  /** The account fails before the stop is reached. */
  stopPastFail: boolean;
  /** Share of the room a stop-out uses, and how many such losers fit in the room. */
  roomUsed: number;
  losersLeft: number;
  /** Leverage above which this stop distance is past the fail line (Infinity: never). */
  levStopFails: number;
}

const floorTo = (v: number, d: number) => Math.floor(v * 10 ** d + 1e-9) / 10 ** d;

export function riskCalc(i: RiskInput): RiskOut {
  const ok = i.price > 0 && i.balance > 0 && i.levCap > 0;
  const maxUnits = ok ? floorTo((i.balance * i.levCap) / i.price, i.sizeDecimals) : 0;
  const feePerUnit = 2 * i.price * Math.max(0, i.feeRate);
  let units = 0;
  let capped = false;
  if (ok && i.mode === 'risk') {
    const perUnit = i.stopPts + feePerUnit;
    units = perUnit > 0 && i.riskUsd > 0 && i.stopPts > 0 ? floorTo(i.riskUsd / perUnit, i.sizeDecimals) : 0;
    if (units > maxUnits) {
      units = maxUnits;
      capped = true;
    }
  } else if (ok) {
    units = floorTo((i.balance * Math.min(Math.max(i.lev, 0), i.levCap)) / i.price, i.sizeDecimals);
  }
  const notional = units * i.price;
  const fees = units * feePerUnit;
  const loss = units * i.stopPts + fees;
  const win = units * i.targetPts - fees;
  const failPts = units > 0 ? Math.max(0, i.room) / units : Infinity;
  const liqPts = units > 0 ? i.balance / units : Infinity;
  return {
    units,
    capped,
    maxUnits,
    notional,
    levUsed: i.balance > 0 ? notional / i.balance : 0,
    fees,
    loss,
    win,
    rr: loss > 0 ? win / loss : 0,
    failPts,
    liqPts,
    stopPastFail: units > 0 && i.stopPts > 0 && i.stopPts >= failPts,
    roomUsed: i.room > 0 ? loss / i.room : loss > 0 ? Infinity : 0,
    losersLeft: loss > 0 ? Math.floor(Math.max(0, i.room) / loss + 1e-9) : Infinity,
    levStopFails: i.stopPts > 0 && i.balance > 0 ? (Math.max(0, i.room) * i.price) / (i.balance * i.stopPts) : Infinity,
  };
}

/** Points to the fail line at leverage `lev` (the curve on the Risk page). */
export function failPtsAtLev(balance: number, room: number, price: number, lev: number): number {
  return balance > 0 && lev > 0 ? (Math.max(0, room) * price) / (balance * lev) : Infinity;
}

/** Max leverage on a market: floor(1 / initMarginRatio), capped at the account's max (if known). */
export function marketLevCap(initMarginRatio: string | number | undefined, accountMax: number | undefined): number {
  const imr = Number(initMarginRatio);
  const own = imr > 0 ? Math.floor(1 / imr + 1e-9) : 1;
  return accountMax !== undefined && accountMax > 0 ? Math.min(own, accountMax) : own;
}

export type RiskGroup = 'fut' | 'crypto' | 'all';
const FUT = new Set(['NQ', 'ES', 'YM', 'RTY', 'GC', 'SI', 'HG', 'PL', 'CL', 'BZ', 'NG']);
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'XRP']);

/** Which filter of the Risk page's market table a market root belongs to. */
export function inGroup(root: string, g: RiskGroup): boolean {
  return g === 'all' || (g === 'fut' ? FUT.has(root) : CRYPTO.has(root));
}
