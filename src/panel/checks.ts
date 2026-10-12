// Pre-trade ("fat-finger") checks shown in the ticket, and connection health. Pure: no I/O.
// Checks never block on their own: an amber check asks for a second click on the same order; only
// the user's own limits (Protect my day) and a stale feed refuse an entry.

export type CheckLevel = 'ok' | 'warn' | 'bad';

export interface TradeCheck {
  level: CheckLevel;
  text: string;
}

export interface CheckInput {
  units: number;
  /** Average size of the last trades (journal); undefined with too few. */
  normalUnits: number | undefined;
  /** Size at or above this × normal warns. */
  sizeMult: number;
  /** Distance of a limit/stop from the mid, in ticks (undefined for a market order). */
  distTicks: number | undefined;
  /** Distance at or above this many ticks warns (0 = off). */
  farTicks: number;
  /** The spread gate: 'cheap' | 'normal' | 'wide' | undefined (learning). */
  gate: string | undefined;
  spreadTicks: number | undefined;
  slTicks: number;
  bracketsOn: boolean;
  tick: number;
}

export function tradeChecks(i: CheckInput): TradeCheck[] {
  const out: TradeCheck[] = [];
  const pts = (t: number) => (t * i.tick).toFixed(2);
  if (i.normalUnits !== undefined && i.normalUnits > 0) {
    const x = i.units / i.normalUnits;
    out.push(x >= i.sizeMult ? { level: 'warn', text: `size ${x.toFixed(1)}× your normal (${i.normalUnits.toFixed(2)}u)` } : { level: 'ok', text: 'size normal' });
  }
  if (i.gate === 'wide') out.push({ level: 'warn', text: `spread ${i.spreadTicks !== undefined ? pts(i.spreadTicks) : '?'} — wide right now` });
  else if (i.gate) out.push({ level: 'ok', text: `spread ${i.spreadTicks !== undefined ? pts(i.spreadTicks) : '?'} ${i.gate}` });
  if (i.distTicks !== undefined && i.farTicks > 0 && Math.abs(i.distTicks) >= i.farTicks) out.push({ level: 'warn', text: `${pts(Math.abs(i.distTicks))} pts from the market — is the price right?` });
  if (i.bracketsOn && i.slTicks > 0 && i.spreadTicks !== undefined && i.slTicks <= i.spreadTicks) out.push({ level: 'bad', text: `stop ${pts(i.slTicks)} pts — inside the spread, fills at once` });
  return out;
}

/** True when an order with these checks needs a second click. */
export function needsConfirm(checks: TradeCheck[]): boolean {
  return checks.some((c) => c.level !== 'ok');
}

export type Health = 'live' | 'slow' | 'stale';

/** Market feed: live under 2 s since the last message, slow under 6 s, else stale (or socket down). */
export function feedHealth(ageMs: number | undefined, socketOpen: boolean): Health {
  if (!socketOpen || ageMs === undefined) return 'stale';
  return ageMs < 2000 ? 'live' : ageMs < 6000 ? 'slow' : 'stale';
}

/** Median and 95th percentile of a list of ms (undefined when empty). */
export function percentiles(ms: number[]): { p50: number; p95: number } | undefined {
  if (!ms.length) return undefined;
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
  return { p50: at(0.5), p95: at(0.95) };
}
