// Canvas ladder (owner, 2026-10-13: "why does the NT DOM look so much better?"): the ladder's visuals
// painted on ONE canvas, as the NT DOM paints its LadderControl — exact pixels, one font pipeline, and
// lines that pass BEHIND every number (the glyph area is wiped before the cell and its number draw).
//
// Drawing only. Clicks, shift-clicks, order chips and drag/drop stay on the DOM rows laid over the
// canvas, each bound to its own row's price exactly as before, so no click→price mapping changes here.
// Every value arrives pre-computed and pre-formatted from App (the same values the DOM rows show).

export interface PaintLine {
  cls: string;
  label: string;
}

export interface PaintRow {
  t: number;
  price: string;
  bestBid: boolean;
  bestAsk: boolean;
  last: boolean;
  fail: boolean;
  inside: boolean;
  va: boolean;
  poc: boolean;
  idx: boolean;
  bid?: { text: string; frac: number; wall: boolean };
  ask?: { text: string; frac: number; wall: boolean };
  sold?: { text: string; imb: boolean; stack: boolean };
  bought?: { text: string; imb: boolean; stack: boolean };
  pnl?: { text: string; sign: number };
  prof?: { text: string; frac: number; soldFrac: number; boughtFrac: number; label: string };
  delta?: { text: string; frac: number; up: boolean };
  heat?: { cells: Array<{ alpha: number; side: 1 | -1; wall: boolean } | null>; net?: { text: string; up: boolean }; absorb?: 'bid' | 'ask' };
  lines: PaintLine[];
  st1?: 'up' | 'down';
  st2?: 'up' | 'down';
}

export interface PaintCol {
  key: string;
  x: number;
  w: number;
}

export interface PaintFrame {
  width: number;
  height: number;
  rowH: number;
  cols: PaintCol[];
  rows: PaintRow[];
  failLabel: boolean;
}

/** How a level line is stroked, from its class list (same rules as styles.css .hl.*). */
export function lineStyle(cls: string): { color: string; width: number; dash: number[]; alpha: number } {
  const c = cls.split(' ');
  const has = (k: string) => c.includes(k);
  const base: Record<string, [string, number, number[]]> = {
    vwap: ['vwap', 2, []],
    vwapband: ['vwap', 1, [4, 3]],
    'zone-buy': ['stack-buy', 1, [1, 2]],
    'zone-sell': ['stack-sell', 1, [1, 2]],
    'or-h': ['or-high', 3, []],
    'or-l': ['or-low', 3, []],
    'or-mid': ['or-mid', 2, []],
    'or-ext-up': ['or-high', 2, [6, 4]],
    'or-ext-dn': ['or-low', 2, [6, 4]],
    'br-sl': ['neg', 2, []],
    'br-tp': ['pos', 2, []],
    'br-in': ['br-in', 2, []],
    'br-trail': ['warn', 2, [6, 4]],
    rng: ['range', 1, [4, 3]],
    nochase: ['no-chase', 1, [1, 2]],
    npoc: ['npoc', 1.5, [5, 3]],
  };
  const k = c.find((x) => base[x]) ?? '';
  const [color, width, dash0] = base[k] ?? ['muted', 1, []];
  const dashed = has('pv') || has('forming');
  return { color, width, dash: dashed && dash0.length === 0 ? [6, 4] : dash0, alpha: has('forming') ? 0.7 : has('pv') ? 0.85 : 1 };
}

/** Left edge of `textW`-wide text aligned in a cell [x, x+w) with `pad`. */
export function alignedLeft(x: number, w: number, textW: number, align: 'left' | 'right' | 'center', pad = 4): number {
  return align === 'right' ? x + w - pad - textW : align === 'center' ? x + (w - textW) / 2 : x + pad;
}

const NUM = "'Inter', 'Segoe UI', system-ui, sans-serif";
const MONO = "ui-monospace, 'Cascadia Mono', Consolas, monospace";

type Pal = (k: string, a?: number) => string;

/** Theme colours from the CSS tokens on <html> (Settings › Colours applies there). */
export function paletteFrom(el: Element): Pal {
  const cs = getComputedStyle(el);
  const cache = new Map<string, string>();
  return (k, a = 1) => {
    const key = `${k}|${a}`;
    let v = cache.get(key);
    if (!v) {
      const rgb = cs.getPropertyValue(`--${k}-rgb`).trim();
      v = rgb ? `rgba(${rgb}, ${a})` : cs.getPropertyValue(`--${k}`).trim() || '#888';
      cache.set(key, v);
    }
    return v;
  };
}

/** Mix a token toward white (p = share of the token, like CSS color-mix with #fff). */
function tint(pal: Pal, k: string, p: number): string {
  const m = /rgba\((\d+), (\d+), (\d+)/.exec(pal(k));
  if (!m) return pal(k);
  const f = (v: string) => Math.round(Number(v) * p + 255 * (1 - p));
  return `rgb(${f(m[1]!)}, ${f(m[2]!)}, ${f(m[3]!)})`;
}

export function paintLadder(ctx: CanvasRenderingContext2D, f: PaintFrame, pal: Pal): void {
  const { width: W, height: H, rowH: RH } = f;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = pal('bg');
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const col = (k: string) => f.cols.find((c) => c.key === k);
  const y0 = (i: number) => i * RH;
  const mid = (i: number) => i * RH + RH / 2;

  // Wipe the line from behind a number's glyphs (only on rows that carry a line), then draw it.
  const lineRow = new Set<number>();
  f.rows.forEach((r, i) => (r.lines.length || r.st1 || r.st2) && lineRow.add(i));
  const text = (i: number, s: string, c: PaintCol, align: 'left' | 'right' | 'center', color: string, font: string, wipe = true, pad = 4) => {
    if (!s) return;
    ctx.font = font;
    const tw = ctx.measureText(s).width;
    const x = alignedLeft(c.x, c.w, tw, align, pad);
    if (wipe && lineRow.has(i)) {
      ctx.fillStyle = pal('bg');
      ctx.fillRect(x - 2, y0(i) + 2, tw + 4, RH - 4);
    }
    ctx.fillStyle = color;
    ctx.fillText(s, x, mid(i) + 0.5);
  };

  // 1. row backgrounds
  const pc = col('price');
  f.rows.forEach((r, i) => {
    const y = y0(i);
    if (r.fail) {
      ctx.fillStyle = pal('neg', 0.12);
      ctx.fillRect(0, y, W, RH);
    }
    if (pc) {
      // Best bid / ask filled in their colour, the value area tinted, the rest the panel colour.
      ctx.fillStyle = r.bestBid ? pal('bid', 0.55) : r.bestAsk ? pal('ask', 0.7) : r.va ? pal('vwap', 0.1) : pal('panel', r.inside ? 0.6 : 1);
      ctx.fillRect(pc.x, y, pc.w, RH);
    }
    ctx.fillStyle = pal('row-line');
    ctx.fillRect(0, y + RH - 1, W, 1);
  });

  // 2. lines (behind everything that follows)
  f.rows.forEach((r, i) => {
    const y = Math.round(mid(i)) + 0.5;
    const stroke = (color: string, w: number, dash: number[], alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.restore();
    };
    for (const l of r.lines) {
      const st = lineStyle(l.cls);
      stroke(pal(st.color), st.width, st.dash, st.alpha);
    }
    if (r.st1) stroke(pal(r.st1 === 'up' ? 'st-up' : 'st-dn'), 2, []);
    if (r.st2) stroke(pal(r.st2 === 'up' ? 'st-up' : 'st-dn'), 1, [4, 3], 0.85);
  });

  // 3. cells
  const hc = col('heat');
  const bidC = col('bid');
  const askC = col('ask');
  const soldC = col('sold');
  const boughtC = col('bought');
  const pnlC = col('pnl');
  const profC = col('profile');
  const deltaC = col('delta');
  f.rows.forEach((r, i) => {
    const y = y0(i);
    // heat · pull/stack
    if (hc && r.heat) {
      const absW = 30;
      const netW = Math.min(46, hc.w * 0.25);
      const sx = hc.x + absW + 4;
      const sw = Math.max(0, hc.w - absW - netW - 12);
      const n = r.heat.cells.length || 1;
      const cw = sw / n;
      r.heat.cells.forEach((c, k) => {
        if (!c) return;
        ctx.fillStyle = c.wall ? pal('heat-hot', 0.95) : pal(c.side > 0 ? 'heat-bid' : 'heat-ask', c.alpha);
        ctx.fillRect(sx + k * cw, y + 2, Math.max(1, cw - 1), RH - 4);
      });
      if (r.heat.absorb) {
        ctx.font = `700 9px ${NUM}`;
        const tw = ctx.measureText('ABS').width;
        ctx.fillStyle = pal(r.heat.absorb === 'bid' ? 'heat-bid' : 'heat-ask');
        ctx.fillRect(hc.x + 4, mid(i) - 6.5, tw + 8, 13);
        ctx.fillStyle = '#04121a';
        ctx.fillText('ABS', hc.x + 8, mid(i) + 0.5);
      }
      if (r.heat.net) text(i, r.heat.net.text, { key: 'h', x: hc.x + hc.w - netW - 4, w: netW }, 'right', pal(r.heat.net.up ? 'pos' : 'neg'), `10px ${NUM}`);
    }
    // depth: the whole cell tinted by size (as the DOM's liquidity cells), number against the price
    for (const [c, d, side] of [[bidC, r.bid, 'bid'], [askC, r.ask, 'ask']] as const) {
      if (!c) continue;
      if (r.bestBid && side === 'bid') {
        ctx.fillStyle = pal('bid', 0.22);
        ctx.fillRect(c.x, y, c.w, RH - 1);
      }
      if (r.bestAsk && side === 'ask') {
        ctx.fillStyle = pal('ask', 0.22);
        ctx.fillRect(c.x, y, c.w, RH - 1);
      }
      if (!d) continue;
      const align = side === 'bid' ? 'right' : 'left';
      ctx.font = `600 14px ${NUM}`;
      const tw = ctx.measureText(d.text).width;
      if (lineRow.has(i)) {
        ctx.fillStyle = pal('bg');
        ctx.fillRect(alignedLeft(c.x, c.w, tw, align) - 2, y + 2, tw + 4, RH - 4);
      }
      ctx.fillStyle = pal(side, 0.06 + 0.66 * d.frac);
      ctx.fillRect(c.x, y, c.w, RH - 1);
      if (d.wall) {
        ctx.font = `700 8px ${NUM}`;
        const ww = ctx.measureText('WALL').width + 6;
        const wx = side === 'bid' ? c.x + 3 : c.x + c.w - ww - 3;
        ctx.fillStyle = tint(pal, side, 0.6);
        ctx.fillRect(wx, mid(i) - 6, ww, 12);
        ctx.fillStyle = pal('bg');
        ctx.fillText('WALL', wx + 3, mid(i) + 0.5);
      }
      text(i, d.text, c, align, '#fff', `600 14px ${NUM}`, false);
    }
    // footprint
    for (const [c, d, side] of [[soldC, r.sold, 'stack-sell'], [boughtC, r.bought, 'stack-buy']] as const) {
      if (!c || !d) continue;
      const align = side === 'stack-sell' ? 'right' : 'left';
      ctx.font = `${d.imb ? 700 : 400} 11px ${NUM}`;
      const tw = ctx.measureText(d.text).width;
      if (lineRow.has(i)) {
        ctx.fillStyle = pal('bg');
        ctx.fillRect(alignedLeft(c.x, c.w, tw, align, 5) - 2, y + 2, tw + 4, RH - 4);
      }
      if (d.imb) {
        ctx.fillStyle = pal(side, 0.22);
        ctx.fillRect(c.x, y, c.w, RH - 1);
        ctx.fillStyle = d.stack ? '#fff' : pal(side);
        ctx.fillRect(align === 'right' ? c.x + c.w - (d.stack ? 4 : 2) : c.x, y, d.stack ? 4 : 2, RH - 1);
      }
      text(i, d.text, c, align, d.imb ? tint(pal, side, 0.6) : side === 'stack-sell' ? '#c9a38a' : '#8fb8c9', `${d.imb ? 700 : 400} 11px ${NUM}`, false, 5);
    }
    // price
    if (pc) {
      const color = r.last || r.bestBid || r.bestAsk || r.poc ? '#fff' : r.inside ? '#566070' : r.va ? '#f5d0fe' : '#e6ebf2';
      const weight = r.last || r.bestBid || r.bestAsk || r.poc ? 700 : 500;
      text(i, r.price, pc, 'center', color, `${weight} 14px ${NUM}`);
      if (r.last) {
        ctx.strokeStyle = pal('last');
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(pc.x + 1, y + 1, pc.w - 2, RH - 3);
      } else if (r.poc) {
        ctx.strokeStyle = '#e4e8f0';
        ctx.lineWidth = 2;
        ctx.strokeRect(pc.x + 1, y + 1, pc.w - 2, RH - 3);
      }
      if (r.idx) text(i, '◆', { key: 'i', x: pc.x, w: 18 }, 'left', pal('vwap'), `10px ${NUM}`, false, 3);
      if (r.fail && f.failLabel) text(i, 'FAIL', pc, 'right', pal('neg'), `9px ${NUM}`, false, 3);
      const stTag = (dir: 'up' | 'down', label: string, right: boolean, solid: boolean) => {
        ctx.font = `700 9px ${NUM}`;
        const tw = ctx.measureText(label).width + 8;
        const x = right ? pc.x + pc.w - tw - 2 : pc.x + 2;
        const c = pal(dir === 'up' ? 'st-up' : 'st-dn');
        ctx.fillStyle = solid ? c : pal('bg');
        ctx.fillRect(x, mid(i) - 6.5, tw, 13);
        if (!solid) {
          ctx.strokeStyle = c;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, mid(i) - 6, tw - 1, 12);
        }
        ctx.fillStyle = solid ? (dir === 'up' ? pal('bg') : '#fff') : tint(pal, dir === 'up' ? 'st-up' : 'st-dn', 0.7);
        ctx.fillText(label, x + 4, mid(i) + 0.5);
      };
      if (r.st1) stTag(r.st1, `${r.st1 === 'up' ? '▲' : '▼'} ST1`, false, true);
      if (r.st2) stTag(r.st2, `${r.st2 === 'up' ? '▲' : '▼'} ST2`, true, false);
    }
    // P&L
    if (pnlC && r.pnl) text(i, r.pnl.text, pnlC, 'center', r.pnl.sign > 0 ? pal('pos') : r.pnl.sign < 0 ? pal('neg') : pal('muted'), `12px ${NUM}`);
    // profile: split bar sold | bought, number and POC/VAH/VAL label in fixed slots
    if (profC && r.prof) {
      const labW = 28;
      const numW = 44;
      const tw = Math.max(0, profC.w - labW - numW - 16);
      const bw = tw * r.prof.frac;
      const bh = r.poc ? 9 : 7;
      ctx.save();
      ctx.globalAlpha = r.poc ? 1 : r.va ? 0.75 : 0.35;
      ctx.fillStyle = pal('prof-sell');
      ctx.fillRect(profC.x + 4, mid(i) - bh / 2, bw * r.prof.soldFrac, bh);
      ctx.fillStyle = pal('prof-buy');
      ctx.fillRect(profC.x + 4 + bw * r.prof.soldFrac, mid(i) - bh / 2, bw * r.prof.boughtFrac, bh);
      ctx.restore();
      text(i, r.prof.text, { key: 'pn', x: profC.x + profC.w - labW - numW - 4, w: numW }, 'right', r.poc ? '#fff' : r.va ? '#9aa3b2' : '#5d6676', `${r.poc ? 700 : 400} 11px ${NUM}`, true, 0);
      if (r.prof.label) text(i, r.prof.label, { key: 'pl', x: profC.x + profC.w - labW, w: labW }, 'left', r.prof.label === 'POC' ? '#fff' : pal('vwap'), `9px ${NUM}`, true, 0);
    }
    // Δ: signed bar from the centre of its track, number in its own slot
    if (deltaC && r.delta) {
      const numW = 46;
      const tw = Math.max(0, deltaC.w - numW - 12);
      const cx = deltaC.x + 4 + tw / 2;
      const bw = (tw / 2) * r.delta.frac;
      ctx.fillStyle = pal(r.delta.up ? 'delta-up' : 'delta-dn', 0.8);
      ctx.fillRect(r.delta.up ? cx : cx - bw, mid(i) - 3.5, bw, 7);
      text(i, r.delta.text, { key: 'dn', x: deltaC.x + deltaC.w - numW - 4, w: numW }, 'right', tint(pal, r.delta.up ? 'delta-up' : 'delta-dn', 0.6), `11px ${NUM}`, true, 0);
    }
  });
  // Δ track centre line
  if (deltaC) {
    const tw = Math.max(0, deltaC.w - 46 - 12);
    ctx.fillStyle = '#2a3344';
    ctx.fillRect(Math.round(deltaC.x + 4 + tw / 2), 0, 1, H);
  }

  // 4. line tags on top, right-aligned; same-row labels joined as the DOM did
  f.rows.forEach((r, i) => {
    if (!r.lines.length) return;
    const st = lineStyle(r.lines[0]!.cls);
    const label = r.lines.map((l) => l.label).join(' · ');
    ctx.font = `700 9px ${MONO}`;
    const tw = ctx.measureText(label).width + 10;
    const x = W - tw - 4;
    ctx.fillStyle = pal('bg', 0.95);
    ctx.fillRect(x, mid(i) - 6.5, tw, 13);
    ctx.strokeStyle = pal(st.color);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(x + 0.5, mid(i) - 6, tw - 1, 12);
    ctx.fillStyle = tint(pal, st.color, 0.55);
    ctx.fillText(label, x + 5, mid(i) + 0.5);
  });
}
