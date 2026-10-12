import type { IndicatorCfg } from '../src/panel/indicators';
import type { SkewDir } from '../src/live/targets';
// Per-viewer UI settings in localStorage. Every read/write is guarded: storage can be missing or
// throw (private window, blocked site data) and the panel must still work on defaults.

export type SizeMode = 'units' | 'usd' | 'risk';

export interface Settings {
  symbol: string;
  /** How the size box is read: Vest units, USD notional (Vest's own ticket), or $ risked at the SL. */
  sizeMode: SizeMode;
  sizeInput: number;
  bracketsOn: boolean;
  tpTicks: number; // 0 = no TP leg. The user's number; there is no built-in distance.
  slTicks: number; // 0 = no SL leg.
  beOffset: number;
  /** Show ladder sizes as USD notional (like Vest's book) instead of units. */
  ladderUsd: boolean;
  /** Show the index-implied mid marker. OFF by default: measured 2026-10-08, the index LAGS Vest's
   * mid by ~600 ms (it publishes every ~750 ms), so it is a reference, not a signal. */
  showIndexRef: boolean;
  /** Ticks per ladder row (1 = every tick). Wheel over the price column changes it. */
  groupTicks: number;
  // Paper prop account — copy these from your Vest screen.
  startEquity: number;
  maxDrawdownUsd: number;
  leverage: number;
  /** Optional LIVE hard size cap in units, 0 = off. The panel's MODE is never saved:
   * every launch starts in PAPER. */
  liveSizeCap: number;
  /** Side panel: show the PAPER/LIVE log under the tape. Off = tape only (the result bar under
   * the LIVE banner still shows every action). */
  showLog: boolean;
  /** Ladder: show the per-price delta column. */
  showDelta: boolean;
  /** Per-instrument indicator overrides (VWAP, footprint imbalances, big trades), keyed by wire symbol. */
  indicators: Record<string, Partial<IndicatorCfg>>;
  /** Dual SuperTrend lines on the ladder + header badge (BookDepthIQ's engine and defaults). */
  showTrend: boolean;
  /** Partial targets: TP2 / TP3 distances in ticks (0 = off; TP1 is tpTicks) and the size split. */
  tp2Ticks: number;
  tp3Ticks: number;
  tpSplit: string;
  /** With 2+ targets: the panel moves the stop to B/E when TP1 fills (owner-approved 2026-10-11). */
  beAfterTp1: boolean;
  /** Scale mode: a ladder click places `scaleCount` limits from the clicked price, `scaleSpanTicks`
   * further away from the market, sized by `scaleSkew` toward `scaleDir` (Vest's own Scale ticket). */
  scaleOn: boolean;
  scaleCount: number;
  scaleSpanTicks: number;
  scaleSkew: number;
  scaleDir: SkewDir;
  /** One-click $ risk buttons (size by risk at the stop, fees included). */
  riskPresets: number[];
  /** Stop distance: your points, or ATR of the panel's 60 s candles × atrMult. In ATR mode the
   * targets are R multiples of that stop (0 = off). */
  stopMode: 'pts' | 'atr' | 'swing';
  /** Swing stop: beyond the high/low of the last `swingMins` minutes, plus `swingBufTicks`. */
  swingMins: number;
  swingBufTicks: number;
  /** Swing stop never closer than this (ticks; 0 = no floor). */
  swingMinTicks: number;
  /** Stop entries fire on a trade at/through the price ('touch') or on a 1-min close ('close'). */
  stopConfirm: 'touch' | 'close';
  /** Setup tag recorded with each trade in the journal. */
  setup: string;
  /** Side panel shows the trade journal instead of the tape. */
  showJournal: boolean;
  /** Ladder: heatmap of resting size (5 min) + pull/stack column. */
  showHeat: boolean;
  /** Fat-finger: warn when a limit/stop is this many points from the market (0 = 4 × ATR), and when
   * the size is this many × your normal. A warning needs a second click; nothing is blocked. */
  ffFarPts: number;
  ffSizeMult: number;
  /** LIVE: the order blotter under the ladder. */
  showBlotter: boolean;
  atrMult: number;
  tpR: number[];
  /** Show the would-be bracket on the ladder before entry (drag the stop to change it). */
  preview: 'off' | 'long' | 'short';
  /** Trailing stop start in R (0 = off). The panel moves the stop without a click (owner OK 2026-10-12). */
  trailStartR: number;
  /** Or trail on a SuperTrend line: 1 = ST1 (60 s), 2 = ST2 (15 s); 0 = use trailStartR. */
  trailLine: 0 | 1 | 2;
  /** Stop recovery: re-place a stop that disappeared from a Vest position (owner OK 2026-10-12). */
  stopGuard: boolean;
  /** Protect my day — all 0/false = off. */
  dayLossUsd: number;
  closeAtDayLimit: boolean;
  maxTradesDay: number;
  cooldownSec: number;
  /** Close a position 5 min before Vest's weekend lock (not crypto: it has none). */
  weekendClose: boolean;
  /** Widen the rows so the whole bracket is on screen. OFF by default: coarse rows move where a
   * click places an order (v1.6.1 had it always on and stop clicks landed through the market). */
  fitBracket: boolean;
}

const KEY = 'bdiqvest.settings.v3';
/** v2 stored USD ladder sizes as the default; v3 flips that default to units (USD sizes all read
 * "$101.0K" on Vest's quote ladder — no information). Everything else carries over. */
const OLD_KEY = 'bdiqvest.settings.v2';

export const DEFAULTS: Settings = {
  symbol: 'NQ-PERP',
  sizeMode: 'units',
  sizeInput: 0.1, // 0.1 unit = $0.10/pt; a $500 / 25x account tops out near 0.40 units on NQ
  bracketsOn: true,
  tpTicks: 0,
  slTicks: 0,
  beOffset: 1,
  ladderUsd: false,
  showIndexRef: false,
  groupTicks: 1,
  // A $500 Instant account. Copy your own numbers from Vest into the panel's Account row.
  startEquity: 500,
  maxDrawdownUsd: 10,
  leverage: 25,
  liveSizeCap: 0, // 0 = off: trading power is the limit, as on Vest's own ticket
  showLog: false,
  showDelta: true,
  indicators: {},
  showTrend: true,
  tp2Ticks: 0,
  tp3Ticks: 0,
  tpSplit: '50/30/20',
  beAfterTp1: false,
  scaleOn: false,
  scaleCount: 3,
  scaleSpanTicks: 0,
  scaleSkew: 1,
  scaleDir: 'even',
  riskPresets: [25, 50, 100, 200],
  stopMode: 'pts',
  swingMins: 15,
  swingBufTicks: 4,
  swingMinTicks: 0,
  stopConfirm: 'touch',
  setup: '',
  showJournal: false,
  showHeat: true,
  ffFarPts: 0,
  ffSizeMult: 2,
  showBlotter: true,
  atrMult: 1.5,
  tpR: [1, 2, 0],
  preview: 'off',
  trailStartR: 0,
  trailLine: 0,
  stopGuard: false,
  dayLossUsd: 0,
  closeAtDayLimit: false,
  maxTradesDay: 0,
  cooldownSec: 0,
  weekendClose: false,
  fitBracket: false,
};

/** The old 0.01 default was a first-release cap the owner turned off (2026-10-08). */
function migrate(s: Settings): Settings {
  return s.liveSizeCap === 0.01 ? { ...s, liveSizeCap: 0 } : s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const old = localStorage.getItem(OLD_KEY);
      return old ? migrate({ ...DEFAULTS, ...(JSON.parse(old) as Partial<Settings>), ladderUsd: false }) : { ...DEFAULTS };
    }
    return migrate({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}
