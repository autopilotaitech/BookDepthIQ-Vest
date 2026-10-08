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
  /** Footprint: diagonal imbalance ratio that lights a Sold/Bought cell (3 = 3:1). */
  imbalanceRatio: number;
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
  imbalanceRatio: 3,
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
