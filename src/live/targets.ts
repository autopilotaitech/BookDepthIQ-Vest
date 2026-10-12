// Multiple take-profit targets, scale orders and "B/E after TP1". Pure: no I/O.
//
// Sizes are split in whole size steps (10^-sizeDecimals) so every piece is a quantity Vest accepts
// and the pieces add up to exactly what the user typed. The distances, the split and the scale
// range are the user's numbers (CLAUDE.md rule 4); nothing here picks one.

import type { LivePosition } from '../vest/tradingShapes.js';

export interface Target {
  /** Distance from the entry in ticks. 0 = this target is off. */
  ticks: number;
  /** Share of the size, in percent. Normalised over the targets that are on. */
  pct: number;
}

export interface Piece {
  ticks: number;
  qty: number;
}

export type Split = { ok: true; legs: Piece[] } | { ok: false; message: string };

const steps = (units: number, sizeDecimals: number) => Math.round(units * 10 ** sizeDecimals);
const toUnits = (n: number, sizeDecimals: number) => n / 10 ** sizeDecimals;

/** "50/30/20" → [50, 30, 20]. Blank or bad parts read as 0. */
export function parseSplit(text: string): number[] {
  return text.split(/[\s/,]+/).filter(Boolean).map((x) => Math.max(0, Number(x) || 0));
}

/**
 * The take-profit legs for `units`: one per target that is on, in order. Each must be further from
 * the entry than the one before. The last leg takes whatever rounding left over, so the legs add up
 * to the full size. A single target gets the whole size.
 */
export function splitTargets(units: number, sizeDecimals: number, targets: Target[]): Split {
  const on = targets.filter((t) => t.ticks > 0);
  if (on.length === 0) return { ok: true, legs: [] };
  for (let i = 1; i < on.length; i++) if (on[i]!.ticks <= on[i - 1]!.ticks) return { ok: false, message: `TP${i + 1} must be further than TP${i}` };
  const total = steps(units, sizeDecimals);
  if (on.length === 1) return { ok: true, legs: [{ ticks: on[0]!.ticks, qty: toUnits(total, sizeDecimals) }] };
  const sum = on.reduce((a, t) => a + t.pct, 0);
  const share = (t: Target) => (sum > 0 ? t.pct / sum : 1 / on.length);
  const n = on.map((t, i) => (i < on.length - 1 ? Math.floor(total * share(t)) : 0));
  n[n.length - 1] = total - n.reduce((a, b) => a + b, 0);
  if (n.some((x) => x <= 0)) return { ok: false, message: `size ${toUnits(total, sizeDecimals)} is too small to split into ${on.length} targets at this split` };
  return { ok: true, legs: on.map((t, i) => ({ ticks: t.ticks, qty: toUnits(n[i]!, sizeDecimals) })) };
}

export type SkewDir = 'start' | 'even' | 'end';
/** Vest's own Scale ticket: 2 to 10 orders (read from its web app, 2026-10-11). */
export const SCALE_MIN = 2;
export const SCALE_MAX = 10;

/**
 * A scale order the way Vest's own Scale ticket builds one (read from its web app, 2026-10-11):
 * `count` limits evenly spaced from `startTicks` to `endTicks`; sizes even, or weighted by
 * skew^(i/(count−1)) so the largest sits at the start or the end. Vest truncates each size; here
 * the rounding remainder goes to the largest order so the total is exactly `units`.
 * Returned in start → end order.
 */
export function scaleOrders(units: number, sizeDecimals: number, startTicks: number, endTicks: number, count: number, skew: number, dir: SkewDir): Split {
  if (!Number.isInteger(count) || count < SCALE_MIN || count > SCALE_MAX) return { ok: false, message: `scale count must be ${SCALE_MIN}–${SCALE_MAX}` };
  if (!(skew >= 1)) return { ok: false, message: 'size skew must be 1 or more (1 = even)' };
  if (Math.abs(endTicks - startTicks) < count - 1) return { ok: false, message: `the scale range is too narrow for ${count} orders on different prices` };
  const w = Array.from({ length: count }, (_, i) => (dir === 'even' ? 1 : skew ** (i / (count - 1))));
  if (dir === 'start') w.reverse();
  const sum = w.reduce((a, b) => a + b, 0);
  const total = steps(units, sizeDecimals);
  const n = w.map((x) => Math.floor((total * x) / sum));
  const big = w.indexOf(Math.max(...w));
  n[big]! += total - n.reduce((a, b) => a + b, 0);
  if (n.some((x) => x <= 0)) return { ok: false, message: `size ${toUnits(total, sizeDecimals)} is too small for ${count} scale orders` };
  return {
    ok: true,
    legs: n.map((q, i) => ({ ticks: startTicks + Math.round(((endTicks - startTicks) * i) / (count - 1)), qty: toUnits(q, sizeDecimals) })),
  };
}

/**
 * B/E after TP1 (owner's explicit OK, 2026-10-11 — the second sanctioned exception to CLAUDE.md
 * rule 2). Armed by the user's own entry with 2+ targets and the box ticked. It watches that
 * symbol's Vest position and says FIRE once, the first time the position has shrunk AND lost a
 * take-profit leg (TP1 filled). A manual partial close keeps every leg, so it does not count.
 * One-shot; cleared when the position is gone.
 */
export class BeWatch {
  private w: { symbol: string; offsetTicks: number; maxQty: number; maxTps: number; seen: boolean } | null = null;

  arm(symbol: string, offsetTicks: number): void {
    this.w = { symbol, offsetTicks, maxQty: 0, maxTps: 0, seen: false };
  }

  clear(symbol?: string): boolean {
    if (!this.w || (symbol !== undefined && this.w.symbol !== symbol)) return false;
    this.w = null;
    return true;
  }

  get symbol(): string | undefined {
    return this.w?.symbol;
  }

  get offsetTicks(): number {
    return this.w?.offsetTicks ?? 0;
  }

  /** 'fire' once when TP1 has filled; 'gone' when the watched position closed; else 'idle'. */
  check(pos: LivePosition | undefined): 'fire' | 'gone' | 'idle' {
    const w = this.w;
    if (!w) return 'idle';
    if (!pos) {
      if (!w.seen) return 'idle'; // a resting limit entry has not filled yet
      this.w = null;
      return 'gone';
    }
    w.seen = true;
    const q = Math.abs(pos.qty);
    const tps = pos.takeProfits.length;
    if (w.maxTps > 0 && q < w.maxQty - 1e-12 && tps < w.maxTps) {
      this.w = null;
      return 'fire';
    }
    w.maxQty = Math.max(w.maxQty, q);
    w.maxTps = Math.max(w.maxTps, tps);
    return 'idle';
  }
}
