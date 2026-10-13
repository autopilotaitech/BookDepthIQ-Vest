// Naked points of control. Each period (N minutes, wall-clock aligned) gets its own volume POC — the most
// traded price, as on one footprint/volumetric bar. When the period closes that POC becomes a naked POC
// line; it stays naked until a later print trades at that price (the auction there is finished), then it
// is gone. Feed prints in time order. Ties for the POC go to the price nearest the period's VWAP. Pure.
// Same logic as BookDepthIQ-NT src/Core/NakedPoc.cs.

export interface NakedPoc {
  ticks: number;
  periodStart: number;
  volume: number;
}

export class NakedPocTracker {
  readonly periodMs: number;
  private cur = Number.NEGATIVE_INFINITY;
  private vol = new Map<number, number>();
  levels: NakedPoc[] = [];

  constructor(periodMinutes = 15, private readonly keep = 30) {
    this.periodMs = Math.max(1, periodMinutes) * 60_000;
  }

  onPrint(timeMs: number, priceTicks: number, qty: number): void {
    if (!(qty > 0)) return;
    const period = Math.floor(timeMs / this.periodMs);
    if (period !== this.cur) {
      if (Number.isFinite(this.cur) && this.vol.size) this.close(this.cur * this.periodMs);
      this.cur = period;
      this.vol.clear();
    }
    // A print at a naked POC from an EARLIER period fills it.
    if (this.levels.length) this.levels = this.levels.filter((l) => !(l.ticks === priceTicks && l.periodStart + this.periodMs <= timeMs));
    this.vol.set(priceTicks, (this.vol.get(priceTicks) ?? 0) + qty);
  }

  private close(periodStart: number): void {
    let tot = 0;
    let pv = 0;
    let max = 0;
    for (const [t, v] of this.vol) {
      tot += v;
      pv += t * v;
      max = Math.max(max, v);
    }
    const vwap = tot > 0 ? pv / tot : 0;
    const best = [...this.vol.entries()].filter(([, v]) => v === max).sort((a, b) => Math.abs(a[0] - vwap) - Math.abs(b[0] - vwap) || a[0] - b[0])[0]!;
    this.levels.push({ ticks: best[0], periodStart, volume: best[1] });
    if (this.levels.length > this.keep) this.levels.splice(0, this.levels.length - this.keep);
  }

  reset(): void {
    this.cur = Number.NEGATIVE_INFINITY;
    this.vol.clear();
    this.levels = [];
  }
}
