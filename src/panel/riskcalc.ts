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

/** Vest Instant funding (no evaluation): start size and static drawdown — the floor is start −
 * drawdown and never moves (docs.vestmarkets.com/vest-capital/account-tiers, 2026-10; $500 / $10
 * matches the owner's account). Account max leverage 25x as seen on the owner's account. Every
 * number stays editable. */
export const INSTANT_PACKAGES = [
  { kind: 'instant', label: '$500', start: 500, dd: 10 },
  { kind: 'instant', label: '$5K', start: 5000, dd: 200 },
  { kind: 'instant', label: '$10K', start: 10000, dd: 400 },
  { kind: 'instant', label: '$25K', start: 25000, dd: 1000 },
] as const;
export const INSTANT_MAX_LEV = 25;

/** Vest Capital evaluation tiers (1-Step / 2-Step, and the funded account you get on passing):
 * max drawdown 6% of the start, static floor; daily loss limit 3%, 4% or none (2-Step: 3%); 1-Step
 * target 10% or 20%, 2-Step 10% then 5% (docs.vestmarkets.com/vest-capital/account-tiers, 2026-10). */
export const EVAL_PACKAGES = [
  { kind: 'eval', label: 'Silver $5K', start: 5000, dd: 300 },
  { kind: 'eval', label: 'Gold $10K', start: 10000, dd: 600 },
  { kind: 'eval', label: 'Platinum $25K', start: 25000, dd: 1500 },
] as const;
/** Daily loss limit choices, fraction of the start (0 = none). */
export const EVAL_DAILY = [0.03, 0.04, 0] as const;

export type InstantPackage = (typeof INSTANT_PACKAGES)[number];
export type EvalPackage = (typeof EVAL_PACKAGES)[number];
export type Package = InstantPackage | EvalPackage;

/** The package (Instant or evaluation tier) an account's start value and fail floor match, if any. */
export function packageMatch(start: number | undefined, floor: number | undefined): Package | undefined {
  if (!(start! > 0) || floor === undefined) return undefined;
  return [...INSTANT_PACKAGES, ...EVAL_PACKAGES].find((p) => Math.abs(p.start - start!) < 0.01 && Math.abs(p.start - p.dd - floor) < 0.01);
}
/** The Instant package an account matches, if any. */
export function instantMatch(start: number | undefined, floor: number | undefined): InstantPackage | undefined {
  const p = packageMatch(start, floor);
  return p?.kind === 'instant' ? p : undefined;
}

/** Room on a package account: the floor is static, so profit adds to the room 1:1. With a daily
 * loss limit (fraction of the start), today's room is also capped at that limit (fresh day). */
export function instantRoom(pkg: Package, balance: number, dailyFrac = 0): number {
  const room = Math.max(0, balance - (pkg.start - pkg.dd));
  return dailyFrac > 0 ? Math.min(room, pkg.start * dailyFrac) : room;
}
