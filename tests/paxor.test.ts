import { describe, expect, it } from 'vitest';
import { DEFAULT_PAXOR, PaxOr, levelFactorTicks, orLabel, orRoot, orSession } from '../src/panel/paxor.js';

// 2026-10-08 is a Thursday. 08:30 Chicago (CDT, UTC−5) = 13:30 UTC.
const T = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 8, h, m, s);

describe('PAXOR port', () => {
  it('NQ and ES families only, from the display symbol', () => {
    expect(orRoot('NQ-PERP')).toBe('NQ');
    expect(orRoot('ES-PERP')).toBe('ES');
    expect(orRoot('MNQ')).toBe('NQ');
    expect(orRoot('BTC-PERP')).toBe('');
    expect(orRoot(undefined)).toBe('');
  });

  it('EXT spacing: NQ 65 pts, ES 15 pts, in ticks', () => {
    expect(levelFactorTicks('NQ', DEFAULT_PAXOR, 0.25)).toBe(260);
    expect(levelFactorTicks('ES', DEFAULT_PAXOR, 0.25)).toBe(60);
    expect(levelFactorTicks('', DEFAULT_PAXOR, 0.25)).toBe(0);
  });

  it('session: 30 s OR from 08:30:00 Chicago, lines to 17:00, dropped after', () => {
    const s = orSession(T(15, 0), DEFAULT_PAXOR)!;
    expect(new Date(s.start).toISOString()).toBe('2026-10-08T13:30:00.000Z');
    expect(s.orbEnd - s.start).toBe(30_000);
    expect(new Date(s.end).toISOString()).toBe('2026-10-08T22:00:00.000Z');
    expect(orSession(T(22, 30), DEFAULT_PAXOR)).toBeUndefined(); // 17:30 Chicago: session over
  });

  it('OR from trades in the window; EXT ladder grows on strict breaks', () => {
    const s = orSession(T(15, 0), DEFAULT_PAXOR)!;
    const or = new PaxOr(s, 260, false); // NQ
    or.add(T(13, 29, 59), 999_999); // before the window: ignored
    or.add(T(13, 30, 5), 124_000);
    or.add(T(13, 30, 20), 124_040);
    or.add(T(13, 30, 30), 130_000); // window end is exclusive → post-OR trade (not part of OR)
    expect(or.formed).toBe(true);
    const lv = () => or.levels().map((l) => [orLabel(l), l.ticks]);
    // 130000 > first upper rung (124040 + 260 = 124300) → EXT1 at 124560
    expect(lv()).toEqual([
      ['OR H', 124_040],
      ['OR L', 124_000],
      ['OR EXT1', 124_300],
      ['OR EXT1', 123_740],
      ['OR EXT2', 124_560],
    ]);
    or.add(T(14, 0), 124_560); // equal is not a strict break
    expect(or.levels()).toHaveLength(5);
    or.add(T(14, 1), 123_739); // breaks the lower rung → EXT1 below
    expect(lv().at(-1)).toEqual(['OR EXT2', 123_480]);
  });

  it('no trade in the 30 s window → not formed, no lines', () => {
    const s = orSession(T(15, 0), DEFAULT_PAXOR)!;
    const or = new PaxOr(s, 60, false);
    or.add(T(13, 31), 100_000);
    expect(or.formed).toBe(false);
    expect(or.levels()).toEqual([]);
  });

  it('mid line when enabled', () => {
    const s = orSession(T(15, 0), DEFAULT_PAXOR)!;
    const or = new PaxOr(s, 0, true);
    or.add(T(13, 30, 1), 100);
    or.add(T(13, 30, 2), 110);
    expect(or.levels().map(orLabel)).toEqual(['OR H', 'OR L', 'OR MID']);
  });
});
