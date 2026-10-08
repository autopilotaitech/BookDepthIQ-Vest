// Does Vest's INDEX price lead Vest's own book mid? Read-only, no login.
//
//   npm run leadlag -- NQ-PERP 300
//
// Both series are sampled onto a 100 ms grid (last value carried forward). Then:
//  1. Cross-correlation of 100 ms changes at lags −5 s … +5 s. A peak at a POSITIVE lag means the
//     index moves first and the Vest mid follows that many ms later.
//  2. Event study: every time the index moves ≥ N ticks within 1 s, how long until the Vest mid
//     has moved ≥ N/2 ticks the SAME way (or the opposite way first).
// Prints distributions, never a single cherry-picked number.

import WebSocket from 'ws';
import { fetchExchangeInfo } from '../vest/rest.js';
import { buildSymbolTable, tickSizeOf } from '../vest/symbols.js';
import { VestMarketSocket, type SocketLike } from '../vest/ws.js';
import { WS_URL } from '../vest/types.js';
import { bookFromDepth, midTicks } from '../book/book.js';
import { dist } from '../book/stats.js';
import { crossCorrelation, eventStudy, resample } from '../book/leadlag.js';

const [, , name = 'NQ-PERP', secsArg = '300'] = process.argv;
const seconds = Number(secsArg);
const table = buildSymbolTable(await fetchExchangeInfo());
const info = table.resolve(name);
if (!info) throw new Error(`unknown symbol ${name}`);
const tick = tickSizeOf(info);

const index: Array<[number, number]> = []; // [ms, ticks]
const mid: Array<[number, number]> = [];
let idxUpdates = 0;
let depthUpdates = 0;

const sock = new VestMarketSocket(
  {
    onTicker: (_s, m) => {
      idxUpdates++;
      const t = Date.now(); // receive time for BOTH series: server stamps and local clock must never be mixed
      index.push([t, Number(m.data.indexPrice) / tick]);
    },
    onDepth: (_s, m) => {
      depthUpdates++;
      const md = midTicks(bookFromDepth(m, tick));
      if (md !== undefined) mid.push([Date.now(), md]);
    },
  },
  WS_URL,
  (url) => new WebSocket(url) as unknown as SocketLike,
);
sock.subscribe(info.symbol, ['depth', 'ticker']);
sock.start();
console.log(`leadlag ${info.displaySymbol} for ${seconds}s …`);

setTimeout(() => {
  sock.stop();
  const step = 100;
  const t0 = Math.max(index[0]?.[0] ?? 0, mid[0]?.[0] ?? 0);
  const t1 = Math.min(index.at(-1)?.[0] ?? 0, mid.at(-1)?.[0] ?? 0);
  const ix = resample(index, t0, t1, step);
  const md = resample(mid, t0, t1, step);
  console.log(`index updates ${idxUpdates} (${(idxUpdates / seconds).toFixed(2)}/s), depth updates ${depthUpdates}, grid ${ix.length} × ${step}ms`);
  // Gaps between index updates, to know the finest lead we could even see.
  const gaps = index.slice(1).map((p, i) => p[0] - index[i]![0]);
  console.log(`index update gap ms ${JSON.stringify(dist(gaps))}`);

  const cc = crossCorrelation(ix, md, 50);
  const best = cc.reduce((a, b) => (b.r > a.r ? b : a));
  console.log(`\ncross-correlation of 100ms changes (lag>0 = index leads):`);
  for (const p of cc.filter((p) => p.lag % 5 === 0)) {
    console.log(`  lag ${String(p.lag * step).padStart(6)} ms  r=${p.r.toFixed(3)} ${'#'.repeat(Math.max(0, Math.round(p.r * 60)))}`);
  }
  console.log(`  PEAK at ${best.lag * step} ms, r=${best.r.toFixed(3)}`);

  for (const n of [2, 4, 8]) {
    const ev = eventStudy(ix, md, step, n, 10, 50);
    console.log(
      `\nindex move ≥${n}t in 1s: ${ev.events} events · mid followed ${ev.followed} · went against first ${ev.against} · nothing in 5s ${ev.none}`,
    );
    console.log(`  follow delay ms ${JSON.stringify(dist(ev.delaysMs))}`);
  }
  process.exit(0);
}, seconds * 1000);
