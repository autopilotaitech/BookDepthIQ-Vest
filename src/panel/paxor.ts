// RTH opening range — a port of BookDepthIQ's PAXOR (web/src/render/layers/paxor.ts,
// computePaxOr, RTH mode), the owner's own logic. Pure: no I/O.
//
// - The OR is the high/low of trades in [08:30:00, 08:30:30) America/Chicago (30-second window).
// - Lines run from the OR to the session end (17:00 Chicago); after that the OR is dropped.
// - EXT rungs: the first sits `levelPoints` beyond OR H / OR L (NQ 65 pts, ES 15 pts). Each time
//   price strictly breaks the outermost rung, the next rung is added one more `levelPoints` out.
// - NQ and ES families only (the owner's request for Vest). The root comes from the DISPLAY symbol
//   via the symbol table (NQ-PERP, ES-PERP) — never a hardcoded wire name.
// Keep in step with paxor.ts in BookDepthIQ.

import { sessionWindow } from './vwap.js';

export interface PaxOrCfg {
  enabled: boolean;
  timezone: string;
  startTime: string; // HH:MM[:SS]
  durationSec: number;
  endTime: string;
  showMid: boolean;
  esLevelPoints: number;
  nqLevelPoints: number;
}

/** BookDepthIQ's RTH defaults (effectivePaxOrSettings + defaultSettings.paxor). */
export const DEFAULT_PAXOR: PaxOrCfg = {
  enabled: true,
  timezone: 'America/Chicago',
  startTime: '08:30:00',
  durationSec: 30,
  endTime: '17:00:00',
  showMid: false,
  esLevelPoints: 15,
  nqLevelPoints: 65,
};

/** 'NQ' / 'ES' for the NQ and ES families (incl. micros), else '' (OR not shown). */
export function orRoot(displaySymbol: string | undefined): 'NQ' | 'ES' | '' {
  const u = (displaySymbol ?? '').toUpperCase();
  const m = /\b(MES|MNQ|ES|NQ)\b/.exec(u) ?? /^(MES|MNQ|ES|NQ)/.exec(u);
  if (!m) return '';
  return m[1] === 'NQ' || m[1] === 'MNQ' ? 'NQ' : 'ES';
}

/** EXT spacing in ticks for a root (0 = no rungs). */
export function levelFactorTicks(root: 'NQ' | 'ES' | '', cfg: PaxOrCfg, tickSize: number): number {
  const pts = root === 'NQ' ? cfg.nqLevelPoints : root === 'ES' ? cfg.esLevelPoints : 0;
  return pts > 0 && tickSize > 0 ? Math.round(pts / tickSize) : 0;
}

function hhmm(s: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  return m ? `${m[1]}:${m[2]}` : s;
}

function secs(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  return m ? Number(m[3] ?? 0) : 0;
}

/**
 * The session that applies at `now`: OR window [start, start + duration) and the line end.
 * Undefined once the session has ended (BookDepthIQ drops the OR then) or for bad times.
 */
export function orSession(now: number, cfg: PaxOrCfg): { start: number; orbEnd: number; end: number } | undefined {
  const w = sessionWindow(now, hhmm(cfg.startTime), hhmm(cfg.endTime), cfg.timezone);
  if (!w) return undefined;
  const start = w.from + secs(cfg.startTime) * 1000;
  const end = w.to + secs(cfg.endTime) * 1000;
  if (now > end) return undefined;
  return { start, orbEnd: start + Math.max(1, Math.floor(cfg.durationSec)) * 1000, end };
}

export interface OrLevel {
  kind: 'high' | 'low' | 'mid' | 'upper' | 'lower';
  ticks: number;
  /** 0 for OR H / OR L / MID; rungs are 1, 2, … = EXT1, EXT2, … (as BookDepthIQ's live engine path labels them). */
  index: number;
}

/** Builds one session's OR and EXT ladder from trades fed in time order. */
export class PaxOr {
  private high = -Infinity;
  private low = Infinity;
  private upper: number | undefined;
  private lower: number | undefined;
  private uppers: number[] = [];
  private lowers: number[] = [];

  constructor(
    readonly session: { start: number; orbEnd: number; end: number },
    private readonly factorTicks: number,
    private readonly showMid: boolean,
  ) {}

  /** An empty OR for the same session and settings (to rebuild from history). */
  blank(): PaxOr {
    return new PaxOr(this.session, this.factorTicks, this.showMid);
  }

  /** True once a trade printed inside the OR window. */
  get formed(): boolean {
    return Number.isFinite(this.high) && Number.isFinite(this.low);
  }

  add(timeMs: number, priceTicks: number): void {
    const s = this.session;
    if (!Number.isFinite(priceTicks) || priceTicks <= 0 || timeMs < s.start || timeMs > s.end) return;
    if (timeMs < s.orbEnd) {
      this.high = Math.max(this.high, priceTicks);
      this.low = Math.min(this.low, priceTicks);
      return;
    }
    if (!this.formed || this.factorTicks <= 0) return;
    if (this.upper === undefined || this.lower === undefined) {
      this.upper = Math.round(this.high + this.factorTicks);
      this.lower = Math.round(this.low - this.factorTicks);
    }
    // Strict break of the outermost rung adds the next one (computePaxOr's growth rule).
    if (priceTicks > this.upper) {
      this.upper = Math.round(this.upper + this.factorTicks);
      this.uppers.push(this.upper);
    }
    if (priceTicks < this.lower) {
      this.lower = Math.round(this.lower - this.factorTicks);
      this.lowers.push(this.lower);
    }
  }

  /** Lines to draw: OR H, OR L, [MID], the first rung each side, then EXT1, EXT2, … */
  levels(): OrLevel[] {
    if (!this.formed) return [];
    const out: OrLevel[] = [
      { kind: 'high', ticks: this.high, index: 0 },
      { kind: 'low', ticks: this.low, index: 0 },
    ];
    if (this.showMid) out.push({ kind: 'mid', ticks: Math.round(this.low + (this.high - this.low) * 0.5), index: 0 });
    if (this.factorTicks > 0) {
      out.push({ kind: 'upper', ticks: Math.round(this.high + this.factorTicks), index: 1 });
      out.push({ kind: 'lower', ticks: Math.round(this.low - this.factorTicks), index: 1 });
      this.uppers.forEach((t, i) => out.push({ kind: 'upper', ticks: t, index: i + 2 }));
      this.lowers.forEach((t, i) => out.push({ kind: 'lower', ticks: t, index: i + 2 }));
    }
    return out;
  }

  /** The OR window is still open (lines are provisional). */
  forming(now: number): boolean {
    return now >= this.session.start && now < this.session.orbEnd;
  }
}

/** Chart label, as BookDepthIQ draws it: "OR H", "OR L", "OR MID", "OR EXT1" … (price is the row). */
export function orLabel(l: OrLevel): string {
  if (l.kind === 'mid') return 'OR MID';
  if (l.kind === 'upper' || l.kind === 'lower') return `OR EXT${l.index}`;
  return l.kind === 'high' ? 'OR H' : 'OR L';
}
