import { describe, expect, it } from 'vitest';
import { alignedLeft, lineStyle, paintLadder, type PaintFrame, type PaintRow } from '../web/ladderPaint';

/** A canvas context that records what is drawn, in order. */
function recorder() {
  const ops: string[] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', globalAlpha: 1,
    clearRect: () => ops.push('clear'),
    fillRect: (x: number, y: number, w: number, h: number) => ops.push(`rect ${x.toFixed(0)},${y.toFixed(0)},${w.toFixed(0)},${h.toFixed(0)}`),
    strokeRect: () => ops.push('strokeRect'),
    fillText: (s: string) => ops.push(`text ${s}`),
    measureText: (s: string) => ({ width: s.length * 7 }),
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => ops.push('line'),
    setLineDash: () => {}, save: () => {}, restore: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

const pal = (k: string, a = 1) => `rgba(1, 2, 3, ${a})|${k}`;

function row(t: number, extra: Partial<PaintRow> = {}): PaintRow {
  return { t, price: String(t), bestBid: false, bestAsk: false, last: false, fail: false, inside: false, va: false, poc: false, idx: false, lines: [], ...extra };
}

const frame = (rows: PaintRow[]): PaintFrame => ({
  width: 800, height: rows.length * 20, rowH: 20, failLabel: true, rows,
  cols: [
    { key: 'buy', x: 0, w: 80 }, { key: 'sold', x: 80, w: 80 }, { key: 'bid', x: 160, w: 100 }, { key: 'price', x: 260, w: 100 },
    { key: 'ask', x: 360, w: 100 }, { key: 'bought', x: 460, w: 80 }, { key: 'sell', x: 540, w: 80 }, { key: 'profile', x: 620, w: 120 }, { key: 'delta', x: 740, w: 60 },
  ],
});

describe('canvas ladder paint', () => {
  it('line styles follow the stylesheet rules', () => {
    expect(lineStyle('or-h')).toMatchObject({ color: 'or-high', width: 3, dash: [] });
    expect(lineStyle('or-h forming')).toMatchObject({ dash: [6, 4], alpha: 0.7 });
    expect(lineStyle('br-sl pv')).toMatchObject({ color: 'neg', dash: [6, 4] });
    expect(lineStyle('npoc').color).toBe('npoc');
    expect(lineStyle('unknown').color).toBe('muted');
  });

  it('aligns text in a cell', () => {
    expect(alignedLeft(100, 50, 20, 'right')).toBe(126);
    expect(alignedLeft(100, 50, 20, 'left')).toBe(104);
    expect(alignedLeft(100, 50, 20, 'center')).toBe(115);
  });

  it('strokes every line before any number, and wipes the glyph area on a line row', () => {
    const { ctx, ops } = recorder();
    paintLadder(ctx, frame([
      row(101, { bid: { text: '5.00', frac: 0.5, wall: false }, lines: [{ cls: 'vwap', label: 'VWAP' }] }),
      row(100, { ask: { text: '3.00', frac: 0.2, wall: true }, last: true, st1: 'up' }),
    ]), pal);
    const lastLine = ops.lastIndexOf('line');
    const firstText = ops.findIndex((o) => o.startsWith('text'));
    expect(lastLine).toBeGreaterThan(-1);
    expect(firstText).toBeGreaterThan(lastLine);
    // the bid number on the VWAP row: a wipe rect under its glyphs before the number is written
    const t = ops.indexOf('text 5.00');
    expect(t).toBeGreaterThan(-1);
    expect(ops.slice(lastLine, t).some((o) => o.startsWith('rect'))).toBe(true);
    // the tag is drawn last, on top
    expect(ops.at(-1)).toBe('text VWAP');
    expect(ops).toContain('text WALL');
    expect(ops).toContain('text ▲ ST1');
  });

  it('draws nothing it was not given', () => {
    const { ctx, ops } = recorder();
    paintLadder(ctx, frame([row(100)]), pal);
    expect(ops.filter((o) => o.startsWith('text'))).toEqual(['text 100']);
    expect(ops).not.toContain('line');
  });
});
