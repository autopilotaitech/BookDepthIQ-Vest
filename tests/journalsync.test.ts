import { describe, expect, it } from 'vitest';
import { readPositionHistory } from '../src/vest/tradingShapes.js';
import { journalStats, syncJournalWithVest, type JournalTrade, type VestClosed } from '../src/panel/structure.js';

const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);
const row = (o: Partial<JournalTrade>): JournalTrade => ({ open: T0, close: T0 + 60_000, sym: 'NQ-PERP', side: 'long', qty: 1, entry: 30000, exit: 30010, pnl: 9.5, approx: true, setup: 'pb', mode: 'live', stopMode: 'pts', feeUsd: 0.75, ...o });
const vest = (o: Partial<VestClosed>): VestClosed => ({ positionId: 'P1', sym: 'NQ-PERP', side: 'long', qty: 1, openPrice: 30000.25, closePrice: 30008, pnl: 7.75, funding: -0.02, openMs: T0 + 200, closeMs: T0 + 61_000, ...o });

describe("Vest position history", () => {
  it('reads Vest history rows (strings, ISO or ms dates)', () => {
    const r = readPositionHistory({ positions: [{ positionId: 'P1', symbol: 'NDX-USD-PERP', side: 'LONG', quantity: '0.5', openPrice: '30000.25', closePrice: '30008', pnl: '3.875', funding: '-0.01', openDate: '2026-10-13T14:00:00Z', closeDate: 1791900000000, closeReason: 'TAKE_PROFIT' }], total: 1 });
    expect(r).toEqual([{ positionId: 'P1', symbol: 'NDX-USD-PERP', side: 'long', qty: 0.5, openPrice: 30000.25, closePrice: 30008, pnl: 3.875, funding: -0.01, openMs: Date.parse('2026-10-13T14:00:00Z'), closeMs: 1791900000000, closeReason: 'TAKE_PROFIT' }]);
  });
});

describe('journal ↔ Vest sync', () => {
  it("a LIVE row takes Vest's entry, exit, P&L and funding; fees add the exit", () => {
    const r = syncJournalWithVest([row({})], [vest({})], () => 0.000025);
    expect(r.matched).toBe(1);
    expect(r.trades[0]).toMatchObject({ vestId: 'P1', entry: 30000.25, exit: 30008, pnl: 7.75, funding: -0.02, approx: false });
    expect(r.trades[0]!.feeUsd).toBeCloseTo(0.75 + 30008 * 0.000025);
  });
  it('wrong side, other market or far in time is not matched; Vest trades the journal missed are added', () => {
    const r = syncJournalWithVest(
      [row({})],
      [vest({ positionId: 'S', side: 'short' }), vest({ positionId: 'G', sym: 'GC-PERP' }), vest({ positionId: 'OLD', closeMs: T0 - 3600_000, openMs: T0 - 3700_000 })],
      () => 0,
    );
    expect(r.matched).toBe(0);
    expect(r.added).toBe(3);
    expect(r.trades.find((t) => t.vestId === 'G')).toMatchObject({ mode: 'live', sym: 'GC-PERP', approx: false });
  });
  it('syncing twice changes nothing; PAPER rows are never touched', () => {
    const once = syncJournalWithVest([row({}), row({ mode: 'paper', open: T0 + 1 })], [vest({})], () => 0);
    const twice = syncJournalWithVest(once.trades, [vest({})], () => 0);
    expect(twice).toMatchObject({ matched: 0, added: 0 });
    expect(twice.trades.find((t) => t.mode === 'paper')!.approx).toBe(true);
    expect(journalStats(twice.trades).fundingUsd).toBeCloseTo(-0.02);
  });
});
