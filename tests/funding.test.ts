import { describe, expect, it } from 'vitest';
import { PremiumWindow, fundingClass, fundingUsdPerHour, hourlyRate, nextSettlement, premiumSample } from '../src/panel/funding.js';

describe('funding (Vest docs formula)', () => {
  it('classes from the market-hours key', () => {
    expect(fundingClass({ exchange: 'CME', assetType: 'INDEX' })).toBe('cmeIndex');
    expect(fundingClass({ exchange: 'CME', assetType: 'COMMODITY' })).toBe('cmeOther');
    expect(fundingClass({ exchange: 'CRYPTO', assetType: 'CRYPTO' })).toBe('crypto');
    expect(fundingClass({ exchange: 'NASDAQ', assetType: 'EQUITY' })).toBe('other');
    expect(fundingClass(undefined)).toBe('other');
  });

  it('CME index futures: rate = P / 48 (no interest part)', () => {
    expect(hourlyRate(0.0025, 'cmeIndex')).toBeCloseTo(0.0025 / 48, 12); // +25 bps premium
    expect(hourlyRate(-0.001, 'cmeIndex')).toBeCloseTo(-0.001 / 48, 12);
  });

  it("matches Vest's BTC worked example: P 0.12%, clamp ±0.003% → 0.004875%/hr", () => {
    // I = 10.95% × 24 / 8760 = 0.03%; I − P = −0.09% → clamped to −0.003%
    expect(hourlyRate(0.0012, 'crypto')).toBeCloseTo(0.00004875, 12);
    // $1M position pays $48.75 an hour
    expect(fundingUsdPerHour(1, 1_000_000, hourlyRate(0.0012, 'crypto'))).toBeCloseTo(48.75, 6);
  });

  it('premium sample from impact prices; none when a side cannot fill', () => {
    // index 100.00, tick 0.25; impact notional = 100 / 0.02 = $5,000
    const bids = { ticks: [400, 399], sizes: [100, 100] }; // 100.00, 99.75
    const asks = { ticks: [404, 405], sizes: [100, 100] }; // 101.00, 101.25
    const p = premiumSample(bids, asks, 0.25, 100, 0.02)!;
    expect(p).toBeCloseTo(0.01, 6); // buy impact 101.00 → +1% (sell impact = index → 0)
    expect(premiumSample({ ticks: [400], sizes: [1] }, asks, 0.25, 100, 0.02)).toBeUndefined();
  });

  it('window average and settlement timing', () => {
    const w = new PremiumWindow();
    w.push(0, 0.001);
    w.push(30_000, 0.003);
    expect(w.avgSince(0)).toBeCloseTo(0.002);
    expect(w.avgSince(10_000)).toBeCloseTo(0.003);
    expect(nextSettlement(Date.UTC(2026, 9, 10, 14, 25))).toBe(Date.UTC(2026, 9, 10, 15, 0));
  });

  it('long pays when the rate is positive, short receives', () => {
    expect(fundingUsdPerHour(0.1, 31_000, 0.00005)).toBeCloseTo(0.155);
    expect(fundingUsdPerHour(-0.1, 31_000, 0.00005)).toBeCloseTo(-0.155);
  });
});
