// "Protect my day": optional limits on NEW entries, all off by default (0 = off). They never touch
// FLATTEN, CANCEL or any exit. The day is the trading day, which starts 17:00 Chicago (CME). Pure.

let fmt: Intl.DateTimeFormat | undefined;
const cache = new Map<number, string>();

/** Trading-day label for `t`: the Chicago date, rolled forward from 17:00. */
export function tradingDay(t: number): string {
  const hourKey = Math.floor(t / 3600_000);
  const hit = cache.get(hourKey);
  if (hit) return hit;
  fmt ??= new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  let label = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 17) {
    const d = new Date(`${label}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    label = d.toISOString().slice(0, 10);
  }
  if (cache.size > 500) cache.clear();
  cache.set(hourKey, label);
  return label;
}

export interface DayLimits {
  /** Stop new entries once the day is down this many $. 0 = off. */
  lossUsd: number;
  /** Most entries per day. 0 = off. */
  maxTrades: number;
  /** Seconds to wait after a losing trade. 0 = off. */
  cooldownSec: number;
}

export interface DayState {
  day: string;
  startEquity: number;
  trades: number;
  lastLossAt?: number;
}

export interface DayVerdict {
  ok: boolean;
  message: string;
  /** $ the next trade may still risk before the daily loss limit (when the limit is on). */
  roomUsd?: number;
}

/**
 * May a NEW entry go now? `nextRiskUsd` = what the next trade loses at its stop (fees included),
 * undefined when it has no stop.
 */
export function dayCheck(lim: DayLimits, st: DayState, equity: number, now: number, nextRiskUsd: number | undefined): DayVerdict {
  const pnl = equity - st.startEquity;
  const room = lim.lossUsd > 0 ? lim.lossUsd + pnl : undefined;
  if (room !== undefined && room <= 0) return { ok: false, message: `daily loss limit reached ($${(-pnl).toFixed(2)} down today) — new entries locked until 17:00 Chicago`, roomUsd: 0 };
  if (lim.maxTrades > 0 && st.trades >= lim.maxTrades) return { ok: false, message: `${st.trades}/${lim.maxTrades} trades today — new entries locked until 17:00 Chicago`, roomUsd: room };
  if (lim.cooldownSec > 0 && st.lastLossAt !== undefined) {
    const left = st.lastLossAt + lim.cooldownSec * 1000 - now;
    if (left > 0) return { ok: false, message: `cooldown after a loss: ${Math.ceil(left / 1000)} s left`, roomUsd: room };
  }
  if (room !== undefined) {
    if (nextRiskUsd === undefined) return { ok: false, message: `set a stop: the daily loss limit needs to know this trade's risk ($${room.toFixed(2)} left today)`, roomUsd: room };
    if (nextRiskUsd > room + 1e-9) return { ok: false, message: `this trade risks $${nextRiskUsd.toFixed(2)} but only $${room.toFixed(2)} is left today — use the smaller size offered`, roomUsd: room };
  }
  return { ok: true, message: 'ok', roomUsd: room };
}

/** True when the day has hit its loss limit (for the optional close-at-limit). */
export function dayLimitHit(lim: DayLimits, st: DayState, equity: number): boolean {
  return lim.lossUsd > 0 && equity - st.startEquity <= -lim.lossUsd;
}

/**
 * Units to risk `riskUsd` with a stop `slTicks` away, counting the taker fee both ways at `price`:
 * loss at the stop = units × (stop distance + 2 × fee × price). Rounded DOWN to the size step.
 */
export function unitsForRiskWithFees(riskUsd: number, slTicks: number, tick: number, price: number, takerFee: number, sizeDecimals: number): number {
  const perUnit = slTicks * tick + 2 * takerFee * price;
  if (!(riskUsd > 0) || !(slTicks > 0) || !(perUnit > 0)) return 0;
  const f = 10 ** sizeDecimals;
  return Math.floor((riskUsd / perUnit) * f + 1e-9) / f;
}

/** $ lost at the stop for `units`, fees both ways included. */
export function riskWithFees(units: number, slTicks: number, tick: number, price: number, takerFee: number): number {
  return units * (slTicks * tick + 2 * takerFee * price);
}
