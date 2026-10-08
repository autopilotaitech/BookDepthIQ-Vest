// Perp / prop-account maths for Vest. Pure functions, no I/O.
//
// Vest NQ-PERP is linear: 1 unit = $1 per index point (docs: 1 MNQ = 2 units, 1 NQ = 20 units),
// so PnL($) = units × Δprice. Positions are cross-margined. Vest Capital accounts additionally
// FAIL (closed permanently, no grace) the moment equity INCLUDING unrealized PnL drops below
// the drawdown floor — that, not exchange liquidation, is the binding limit on a small prop
// account, so it is what the panel calls the "fail price" (Vest's own ticket uses the same name).

export interface AccountSpec {
  /** Account value when the paper session started, $ (Vest UI: "Account Value"). */
  startEquity: number;
  /** $ the account may lose before it fails (Vest UI: "Max. Drawdown: $x / $LIMIT"). */
  maxDrawdownUsd: number;
  /** Leverage set on the order form (Vest UI: "Leverage 25x"). */
  leverage: number;
}

/** Equity at which the account fails. */
export function failFloor(a: AccountSpec): number {
  return a.startEquity - a.maxDrawdownUsd;
}

/** Notional the account can carry: equity × leverage (Vest UI: "Trading Power"). */
export function tradingPower(equity: number, leverage: number): number {
  return Math.max(0, equity) * Math.max(0, leverage);
}

/** Largest position, in units, that trading power allows at `price`. */
export function maxUnits(equity: number, leverage: number, price: number): number {
  return price > 0 ? tradingPower(equity, leverage) / price : 0;
}

/**
 * Price at which equity reaches the fail floor for a position of `qty` (signed units) at average
 * `avgPrice`, given equity measured with that position marked at `avgPrice` (i.e. excluding its
 * open PnL). Undefined when flat, or when the account is already at or below the floor.
 */
export function failPrice(qty: number, avgPrice: number, equityExOpen: number, floor: number): number | undefined {
  if (qty === 0) return undefined;
  const room = equityExOpen - floor;
  if (room <= 0) return undefined;
  return avgPrice - room / qty; // long: below avg, short: above
}

/** $ lost if the stop is hit: units × stop distance in points. */
export function riskUsd(units: number, slTicks: number, tickSize: number): number {
  return Math.abs(units) * slTicks * tickSize;
}

/** Units that risk exactly `usd` over `slTicks`, rounded DOWN to the venue's size step. */
export function unitsForRisk(usd: number, slTicks: number, tickSize: number, sizeDecimals: number): number {
  if (usd <= 0 || slTicks <= 0 || tickSize <= 0) return 0;
  return floorTo(usd / (slTicks * tickSize), sizeDecimals);
}

/** Units for a USD notional at `price`, rounded DOWN to the size step. */
export function unitsForNotional(usd: number, price: number, sizeDecimals: number): number {
  if (usd <= 0 || price <= 0) return 0;
  return floorTo(usd / price, sizeDecimals);
}

export function floorTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(v * f + 1e-9) / f;
}

export interface PreTradeInput {
  side: 'buy' | 'sell';
  units: number;
  price: number; // expected fill price
  positionQty: number; // signed, before the order
  equity: number; // current equity incl. open PnL
  leverage: number;
  failed: boolean;
}

/**
 * Refuses an ENTRY that the account could not carry. Exits (orders that only reduce the position)
 * are never refused here — flatten / cancel / reduce must always be reachable.
 */
export function preTradeCheck(i: PreTradeInput): { ok: boolean; message: string } {
  const signed = i.side === 'buy' ? i.units : -i.units;
  const after = i.positionQty + signed;
  const reduces = Math.abs(after) < Math.abs(i.positionQty) && Math.sign(after) !== -Math.sign(i.positionQty);
  if (reduces) return { ok: true, message: 'reduces position' };
  if (i.failed) return { ok: false, message: 'paper account FAILED (drawdown breached) — reset it to trade again' };
  const notional = Math.abs(after) * i.price;
  const power = tradingPower(i.equity, i.leverage);
  if (notional > power + 1e-6) {
    const max = maxUnits(i.equity, i.leverage, i.price);
    return {
      ok: false,
      message: `size ${Math.abs(after).toFixed(4)}u = $${notional.toFixed(0)} exceeds trading power $${power.toFixed(0)} (max ${max.toFixed(4)}u)`,
    };
  }
  return { ok: true, message: 'ok' };
}

/** Effective leverage in use: open notional ÷ equity (Vest's header "Leverage: Nx"). */
export function leverageUsed(notionalUsd: number, equity: number): number {
  return equity > 0 ? notionalUsd / equity : 0;
}

/** Initial margin the open position ties up at the order-form leverage: notional ÷ leverage. */
export function marginUsed(notionalUsd: number, leverage: number): number {
  return leverage > 0 ? notionalUsd / leverage : 0;
}
