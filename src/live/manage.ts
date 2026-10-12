// Position management that acts WITHOUT a click: trailing stop, stop recovery, weekend close.
// Owner's explicit OK 2026-10-12 ("1-9 do it") — exceptions to CLAUDE.md rule 2, recorded there.
// Every one of them is off until the user turns it on, only ever moves or re-places a STOP or
// closes a position (never opens one), and logs what it did. Pure: no I/O.

/**
 * Trailing stop. Once price has gone `startR` × risk in your favour (risk = entry → stop distance
 * at entry), the stop follows the best price at one risk behind it, and only ever moves your way.
 * Returns the new stop in ticks, or undefined when it should stay.
 */
export function trailTarget(long: boolean, entryTicks: number, riskTicks: number, bestTicks: number, startR: number, stopTicks: number | undefined): number | undefined {
  if (!(riskTicks > 0) || !(startR > 0)) return undefined;
  const dir = long ? 1 : -1;
  if ((bestTicks - entryTicks) * dir < startR * riskTicks) return undefined;
  const want = long ? Math.floor(bestTicks - riskTicks) : Math.ceil(bestTicks + riskTicks);
  if (stopTicks !== undefined && (want - stopTicks) * dir < 1) return undefined; // never backwards, at least a tick
  return want;
}

/** A SuperTrend line as the panel draws it: level in ticks and direction. */
export interface TrendLine {
  ticks: number;
  dir: 'up' | 'down';
}
/** The panel's two SuperTrend lines: 1 = ST1 (60 s candles), 2 = ST2 (15 s candles). */
export type TrendLines = { 1?: TrendLine; 2?: TrendLine };

/**
 * SuperTrend trail: the stop sits ON the chosen line while that line is on the trade's side (an up
 * line under a long, a down line over a short), and only ever moves your way. A flipped line is
 * ignored: the stop stays where it was.
 */
export function lineTrailTarget(long: boolean, line: TrendLine | undefined, stopTicks: number | undefined): number | undefined {
  if (!line || line.dir !== (long ? 'up' : 'down')) return undefined;
  if (stopTicks !== undefined && (line.ticks - stopTicks) * (long ? 1 : -1) < 1) return undefined;
  return line.ticks;
}

/** One trailing stop per symbol: the risk captured at entry and the best price since, or the
 * SuperTrend line it follows. */
export class TrailBook {
  private w = new Map<string, { riskTicks: number; startR: number; line?: 1 | 2; best?: number; long?: boolean }>();

  arm(symbol: string, riskTicks: number, startR: number, line?: 1 | 2): void {
    if (line) this.w.set(symbol, { riskTicks, startR: 0, line });
    else if (riskTicks > 0 && startR > 0) this.w.set(symbol, { riskTicks, startR });
  }

  clear(symbol?: string): boolean {
    if (symbol === undefined) {
      const n = this.w.size;
      this.w.clear();
      return n > 0;
    }
    return this.w.delete(symbol);
  }

  has(symbol: string): boolean {
    return this.w.has(symbol);
  }

  get size(): number {
    return this.w.size;
  }

  /** A trade printed while a position is open: the stop it should have now, if it should move. */
  onTrade(symbol: string, long: boolean, entryTicks: number, priceTicks: number, stopTicks: number | undefined, lines?: TrendLines): number | undefined {
    const s = this.w.get(symbol);
    if (!s) return undefined;
    if (s.line) return lineTrailTarget(long, lines?.[s.line], stopTicks);
    if (s.long !== long) {
      s.long = long;
      s.best = undefined;
    }
    s.best = s.best === undefined ? priceTicks : long ? Math.max(s.best, priceTicks) : Math.min(s.best, priceTicks);
    return trailTarget(long, entryTicks, s.riskTicks, s.best, s.startR, stopTicks);
  }
}

/**
 * Stop recovery: remembers the last stop seen on each position. When a position that HAD a stop
 * shows none on two reads at least `confirmMs` apart, it says which stop to put back (the last one).
 * Positions never seen with a stop are left alone (legs can attach a moment after the fill).
 */
export class StopGuard {
  private last = new Map<string, { stop: number; missingSince?: number; lastTry?: number }>();

  constructor(
    private readonly confirmMs = 3000,
    private readonly retryMs = 10_000,
  ) {}

  /** `positions`: every open position with its first stop's trigger price (undefined = none). */
  check(positions: Array<{ positionId: string; stop: number | undefined }>, now: number): Array<{ positionId: string; stop: number }> {
    const out: Array<{ positionId: string; stop: number }> = [];
    const open = new Set(positions.map((p) => p.positionId));
    for (const id of [...this.last.keys()]) if (!open.has(id)) this.last.delete(id);
    for (const p of positions) {
      const s = this.last.get(p.positionId);
      if (p.stop !== undefined) {
        this.last.set(p.positionId, { stop: p.stop });
        continue;
      }
      if (!s) continue;
      s.missingSince ??= now;
      if (now - s.missingSince < this.confirmMs) continue;
      if (s.lastTry !== undefined && now - s.lastTry < this.retryMs) continue;
      s.lastTry = now;
      out.push({ positionId: p.positionId, stop: s.stop });
    }
    return out;
  }

  clear(): void {
    this.last.clear();
  }
}

export interface HoursPeriod {
  fromMs: number;
  toMs: number;
  state: { tradingStatus: string };
}

/** A gap of at least this long between sessions is a weekend lock, not the daily break. */
export const WEEKEND_GAP_MS = 24 * 3600_000;

/**
 * When to close before Vest's weekend lock: `leadMs` before the end of the current open session,
 * if the next open session starts a day or more later. Undefined when the market is closed now,
 * trades through (crypto), or the next close is only the daily break.
 */
export function weekendCloseAt(periods: HoursPeriod[], now: number, windowEndMs: number, leadMs = 5 * 60_000): number | undefined {
  const sorted = [...periods].sort((a, b) => a.fromMs - b.fromMs);
  // Merge back-to-back OPEN periods (sessions can be split into several rows).
  const open: Array<{ from: number; to: number }> = [];
  for (const p of sorted) {
    if (p.state.tradingStatus !== 'OPEN') continue;
    const last = open.at(-1);
    if (last && p.fromMs <= last.to + 1000) last.to = Math.max(last.to, p.toMs);
    else open.push({ from: p.fromMs, to: p.toMs });
  }
  const i = open.findIndex((o) => o.from <= now && now < o.to);
  if (i < 0) return undefined;
  const cur = open[i]!;
  const next = open[i + 1];
  // No next session inside the window asked for: closed at least until the window's end.
  const gapEnd = next ? next.from : windowEndMs;
  if (gapEnd - cur.to < WEEKEND_GAP_MS) return undefined;
  return cur.to - leadMs;
}
