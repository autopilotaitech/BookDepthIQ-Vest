// Record the market on screen (book, trades, ticker) and play it back through the panel.
// The recorder writes one chunk per symbol per minute to a Store (IndexedDB in the browser, a Map
// in tests). The player reads a session's chunks in order and hands each message back at 1–10×
// speed. Replay runs in PAPER only (the panel enforces that). No network here.

import type { DepthMsg, TickerMsg, TradeMsg } from '../vest/types.js';

export type Rec = { t: number; k: 'd'; m: DepthMsg } | { t: number; k: 't'; m: TradeMsg } | { t: number; k: 'x'; m: TickerMsg };

export interface Store {
  put(key: string, recs: Rec[]): Promise<void>;
  get(key: string): Promise<Rec[]>;
  keys(): Promise<string[]>;
  del(key: string): Promise<void>;
}

/** In-memory store (tests, and a fallback when IndexedDB is unavailable). */
export class MemStore implements Store {
  private m = new Map<string, Rec[]>();
  async put(key: string, recs: Rec[]): Promise<void> {
    this.m.set(key, [...(this.m.get(key) ?? []), ...recs]);
  }
  async get(key: string): Promise<Rec[]> {
    return this.m.get(key) ?? [];
  }
  async keys(): Promise<string[]> {
    return [...this.m.keys()];
  }
  async del(key: string): Promise<void> {
    this.m.delete(key);
  }
}

const pad = (n: number, w = 9) => String(n).padStart(w, '0');
/** Chunk key: symbol|minute (minutes since epoch, zero-padded so keys sort in time order). */
export const chunkKey = (symbol: string, minute: number) => `${symbol}|${pad(minute)}`;
export const parseKey = (key: string) => {
  const [symbol, m] = key.split('|');
  return { symbol: symbol!, minute: Number(m) };
};

export interface Session {
  symbol: string;
  /** First and last recorded minute (ms). */
  from: number;
  to: number;
  minutes: number;
}

/** Recorded sessions: runs of minutes per symbol with gaps under 30 minutes, newest first. */
export function listSessions(keys: string[]): Session[] {
  const bySym = new Map<string, number[]>();
  for (const k of keys) {
    const { symbol, minute } = parseKey(k);
    if (!Number.isFinite(minute)) continue;
    (bySym.get(symbol) ?? bySym.set(symbol, []).get(symbol)!).push(minute);
  }
  const out: Session[] = [];
  for (const [symbol, mins] of bySym) {
    mins.sort((a, b) => a - b);
    let start = mins[0]!;
    let prev = start;
    let n = 1;
    for (let i = 1; i <= mins.length; i++) {
      const m = mins[i];
      if (m === undefined || m - prev > 30) {
        out.push({ symbol, from: start * 60_000, to: (prev + 1) * 60_000, minutes: n });
        if (m === undefined) break;
        start = m;
        n = 0;
      }
      prev = m;
      n++;
    }
  }
  return out.sort((a, b) => b.from - a.from);
}

/** Buffers messages and writes one chunk per symbol per minute. Depth is kept at most every
 * `depthMs` per symbol (Vest sends full snapshots, so a thinned stream is still exact). */
export class Recorder {
  private buf = new Map<string, Rec[]>();
  private lastDepth = new Map<string, number>();
  private lastTicker = new Map<string, number>();
  enabled = true;

  constructor(
    private readonly store: Store,
    private readonly depthMs = 250,
    private readonly keepDays = 7,
  ) {}

  add(symbol: string, rec: Rec): void {
    if (!this.enabled) return;
    if (rec.k === 'd') {
      if (rec.t - (this.lastDepth.get(symbol) ?? 0) < this.depthMs) return;
      this.lastDepth.set(symbol, rec.t);
    }
    if (rec.k === 'x') {
      if (rec.t - (this.lastTicker.get(symbol) ?? 0) < 1000) return;
      this.lastTicker.set(symbol, rec.t);
    }
    const key = chunkKey(symbol, Math.floor(rec.t / 60_000));
    const arr = this.buf.get(key);
    if (arr) arr.push(rec);
    else {
      this.buf.set(key, [rec]);
      void this.flush(key);
    }
  }

  /** Write every finished minute (all but `keepOpen`); the current minute stays buffered. */
  async flush(keepOpen?: string): Promise<void> {
    for (const [k, recs] of [...this.buf]) {
      if (k === keepOpen) continue;
      this.buf.delete(k);
      try {
        await this.store.put(k, recs);
      } catch {
        /* storage full or unavailable: drop this minute */
      }
    }
  }

  /** Delete chunks older than `keepDays`. */
  async prune(now: number): Promise<void> {
    const cut = Math.floor((now - this.keepDays * 86_400_000) / 60_000);
    for (const k of await this.store.keys()) if (parseKey(k).minute < cut) await this.store.del(k);
  }
}

export interface PlayerHooks {
  emit(rec: Rec): void;
  /** Clear the panel's market state (before a seek backwards). */
  reset(): void;
  /** Virtual clock moved (for the bar). */
  tick(nowMs: number): void;
  done(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
}

/** Plays one session at `speed`× real time. Long quiet gaps are cut to 1 s. */
export class Player {
  speed = 1;
  playing = false;
  nowMs: number;
  private minute: number;
  private queue: Rec[] = [];
  private timer: unknown = null;
  private loading = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(
    private readonly store: Store,
    readonly session: Session,
    private readonly hooks: PlayerHooks,
  ) {
    this.setTimer = hooks.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = hooks.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.nowMs = session.from;
    this.minute = Math.floor(session.from / 60_000);
  }

  private async load(): Promise<boolean> {
    const last = Math.floor((this.session.to - 1) / 60_000);
    while (!this.queue.length && this.minute <= last) {
      this.queue = (await this.store.get(chunkKey(this.session.symbol, this.minute))).slice().sort((a, b) => a.t - b.t);
      this.minute++;
    }
    return this.queue.length > 0;
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    void this.step();
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async step(): Promise<void> {
    if (!this.playing || this.loading) return;
    if (!this.queue.length) {
      this.loading = true;
      const more = await this.load();
      this.loading = false;
      if (!more) {
        this.playing = false;
        this.hooks.done();
        return;
      }
    }
    const rec = this.queue.shift()!;
    const wait = Math.min(1000, Math.max(0, rec.t - this.nowMs)) / this.speed;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.playing) {
        this.queue.unshift(rec);
        return;
      }
      this.nowMs = Math.max(this.nowMs, rec.t);
      this.hooks.emit(rec);
      this.hooks.tick(this.nowMs);
      void this.step();
    }, wait);
  }

  /** Jump to `targetMs`: reset the panel and feed everything from the session start up to it at once. */
  async seek(targetMs: number): Promise<void> {
    const was = this.playing;
    this.pause();
    const target = Math.max(this.session.from, Math.min(this.session.to, targetMs));
    this.hooks.reset();
    this.queue = [];
    this.minute = Math.floor(this.session.from / 60_000);
    this.nowMs = this.session.from;
    const stop = Math.floor(target / 60_000);
    while (this.minute <= stop) {
      const recs = (await this.store.get(chunkKey(this.session.symbol, this.minute))).slice().sort((a, b) => a.t - b.t);
      this.minute++;
      for (const r of recs) {
        if (r.t > target) {
          this.queue.push(r);
          continue;
        }
        this.hooks.emit(r);
      }
    }
    this.nowMs = target;
    this.hooks.tick(target);
    if (was) this.play();
  }
}
