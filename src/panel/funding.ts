// Funding: what Vest's hourly funding costs or pays you, and a live prediction of it. Pure: no I/O.
//
// Vest docs (trading/funding-mechanism, read 2026-10-10):
//   hourly rate = [P + clamp(I − P, −K·I, +K·I)] / H, settled hourly, on notional at the INDEX price
//   P = average premium over the hour;  I = annual × H / (365 × 24);  K = 0.1 for all symbols
//   premium = [max(buyImpact − index, 0) − max(index − sellImpact, 0)] / index, where impact prices
//   are the average fills of a $100 / initial-margin-ratio order (a sample counts only if both
//   sides fully fill).  Positive rate: longs pay shorts. Negative: shorts pay longs.
//   Class            annual   H
//   crypto           10.95%   24
//   CME index futs   0%       48   (NQ, ES, RTY: rate = P / 48)
//   other CME futs   0%       120  (FX, commodities)
//   everything else  5%       120

import type { BookSide } from '../book/book.js';

export type FundingClass = 'crypto' | 'cmeIndex' | 'cmeOther' | 'other';

export const FUNDING_PARAMS: Record<FundingClass, { annual: number; H: number }> = {
  crypto: { annual: 0.1095, H: 24 },
  cmeIndex: { annual: 0, H: 48 },
  cmeOther: { annual: 0, H: 120 },
  other: { annual: 0.05, H: 120 },
};
export const FUNDING_K = 0.1;

/** Class from Vest's market-hours key (exchange + assetType), as /v4/market-hours reports it. */
export function fundingClass(key: { exchange?: string; assetType?: string } | undefined): FundingClass {
  const ex = (key?.exchange ?? '').toUpperCase();
  const at = (key?.assetType ?? '').toUpperCase();
  if (at === 'CRYPTO' || ex === 'CRYPTO') return 'crypto';
  if (ex === 'CME') return at === 'INDEX' ? 'cmeIndex' : 'cmeOther';
  return 'other';
}

/** Hourly rate (fraction, e.g. 0.00005 = 0.005%/hr) from the hour's average premium. */
export function hourlyRate(avgPremium: number, cls: FundingClass): number {
  const { annual, H } = FUNDING_PARAMS[cls];
  const I = (annual * H) / (365 * 24);
  const adj = Math.max(-FUNDING_K * I, Math.min(FUNDING_K * I, I - avgPremium));
  return (avgPremium + adj) / H;
}

/** Average fill price for `notionalUsd` walked through one side of the book (prices in `tick`s). */
function impactPrice(side: BookSide, notionalUsd: number, tick: number): number | undefined {
  let left = notionalUsd;
  let qty = 0;
  for (let i = 0; i < side.ticks.length && left > 1e-9; i++) {
    const px = side.ticks[i]! * tick;
    const levelUsd = px * side.sizes[i]!;
    const take = Math.min(left, levelUsd);
    qty += take / px;
    left -= take;
  }
  return left > 1e-9 || qty <= 0 ? undefined : notionalUsd / qty; // not fully fillable → no sample
}

/** One premium sample, Vest's way; undefined when either side cannot fill the impact size. */
export function premiumSample(bids: BookSide, asks: BookSide, tick: number, index: number, initMarginRatio: number): number | undefined {
  if (!(index > 0) || !(initMarginRatio > 0)) return undefined;
  const notional = 100 / initMarginRatio;
  const buy = impactPrice(asks, notional, tick);
  const sell = impactPrice(bids, notional, tick);
  if (buy === undefined || sell === undefined) return undefined;
  return (Math.max(buy - index, 0) - Math.max(index - sell, 0)) / index;
}

/** Rolling premium samples; average over any recent span (e.g. since the top of the hour). */
export class PremiumWindow {
  private s: Array<[number, number]> = [];
  push(t: number, p: number): void {
    this.s.push([t, p]);
    const cut = t - 2 * 3600_000;
    while (this.s.length && this.s[0]![0] < cut) this.s.shift();
  }
  avgSince(from: number): number | undefined {
    let sum = 0;
    let n = 0;
    for (const [t, p] of this.s) if (t >= from) (sum += p), n++;
    return n ? sum / n : undefined;
  }
}

/** Next funding settlement: the top of the next hour. */
export function nextSettlement(now: number): number {
  return Math.floor(now / 3600_000) * 3600_000 + 3600_000;
}

/** $ you pay (+) or receive (−) per hour for a signed position (+ long) at this rate and index price. */
export function fundingUsdPerHour(qty: number, indexPx: number, rate: number): number {
  return qty * indexPx * rate;
}
