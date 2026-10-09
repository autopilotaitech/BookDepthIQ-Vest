// Session VWAP with standard-deviation bands, anchored to a start/stop time. Pure: no I/O.
//
// VWAP = Σ(price × qty) / Σqty over trades inside the session window.
// σ   = sqrt(Σ(qty × price²) / Σqty − VWAP²)  (volume-weighted standard deviation)
// Bands = VWAP ± k × σ for each k the user picks.

export class Vwap {
  private v = 0;
  private pv = 0;
  private pv2 = 0;
  /** Trades counted so far. */
  n = 0;

  add(price: number, qty: number): void {
    if (!(qty > 0) || !Number.isFinite(price)) return;
    this.v += qty;
    this.pv += price * qty;
    this.pv2 += price * price * qty;
    this.n++;
  }

  reset(): void {
    this.v = this.pv = this.pv2 = 0;
    this.n = 0;
  }

  /** VWAP, undefined before any volume. */
  value(): number | undefined {
    return this.v > 0 ? this.pv / this.v : undefined;
  }

  /** Volume-weighted standard deviation (0 with one price). */
  sigma(): number | undefined {
    const m = this.value();
    if (m === undefined) return undefined;
    return Math.sqrt(Math.max(0, this.pv2 / this.v - m * m));
  }

  /** [lower, upper] for each multiplier, in price units. */
  bands(mults: number[]): Array<{ k: number; lo: number; hi: number }> {
    const m = this.value();
    const sd = this.sigma();
    if (m === undefined || sd === undefined) return [];
    return mults.filter((k) => k > 0).map((k) => ({ k, lo: m - k * sd, hi: m + k * sd }));
  }
}

/** "HH:MM" → minutes after midnight, or undefined. */
export function parseHhmm(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : undefined;
}

/** Wall-clock minutes-after-midnight and the calendar date of `ms` in `timeZone`. */
function zoned(ms: number, timeZone: string): { y: number; mo: number; d: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), min: get('hour') * 60 + get('minute') };
}

/**
 * The session window that applies at `now`: it starts at the most recent `start` wall-clock time
 * (in `timeZone`) at or before now and ends at the next `end` after that start (an end earlier than
 * the start means the session crosses midnight). Returns epoch ms. After the end, the window is
 * the finished session, so VWAP stays frozen until the next start.
 */
export function sessionWindow(now: number, start: string, end: string, timeZone = 'America/New_York'): { from: number; to: number } | undefined {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (s === undefined || e === undefined) return undefined;
  const z = zoned(now, timeZone);
  // Minutes since the latest start (today's if already passed, else yesterday's).
  const sinceStart = (z.min - s + 1440) % 1440;
  const from = Math.floor(now / 60_000) * 60_000 - sinceStart * 60_000;
  const len = ((e - s + 1440) % 1440) || 1440;
  return { from, to: from + len * 60_000 };
}
