// Read-only measurement probe for one Vest market. Places NO orders and needs no login.
//
//   npm run probe -- NQ-PERP 120          # symbol (display or wire name), seconds
//   npm run probe -- NQ-PERP 120 --record # also writes recordings/<symbol>-<ts>.jsonl
//
// Prints the distributions that decide what a scalping panel can honestly show on this venue:
// how often the book updates, how deep it is, whether its sizes are organic or one quoter's
// ladder, how often anyone actually trades, and how far the venue's price sits from its index.

import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { fetchExchangeInfo } from '../vest/rest.js';
import { buildSymbolTable, tickSizeOf } from '../vest/symbols.js';
import WebSocket from 'ws';
import { VestMarketSocket, type SocketLike } from '../vest/ws.js';
import { WS_URL } from '../vest/types.js';
import { bookFromDepth, midTicks, spreadTicks, type Book } from '../book/book.js';
import { dist, ladderScore } from '../book/stats.js';

const [, , name = 'NQ-PERP', secsArg = '60', ...flags] = process.argv;
const seconds = Number(secsArg);
const record = flags.includes('--record');

const table = buildSymbolTable(await fetchExchangeInfo());
const info = table.resolve(name);
if (!info) {
  console.error(`unknown symbol ${name}`);
  process.exit(1);
}
const tick = tickSizeOf(info);
console.log(`probe ${info.displaySymbol ?? info.symbol} (wire ${info.symbol}) tick=${tick} for ${seconds}s`);

let out: WriteStream | null = null;
if (record) {
  mkdirSync('recordings', { recursive: true });
  const path = `recordings/${info.symbol}-${Date.now()}.jsonl`;
  out = createWriteStream(path);
  console.log(`recording -> ${path}`);
}

const depthGapsMs: number[] = [];
const spreads: number[] = [];
const bidLevels: number[] = [];
const askLevels: number[] = [];
const topSizes: number[] = [];
const ladder: number[] = [];
const midMoves: number[] = [];
const tradeQty: number[] = [];
const tradeNotional: number[] = [];
const basisBps: number[] = []; // mark vs index
const midVsMarkTicks: number[] = [];
let lastDepthAt = 0;
let last: Book | null = null;
let lastMark: number | undefined;
let trades = 0;
let midChanges = 0;

const sock = new VestMarketSocket({
  onStatus: (s, d) => console.log(`socket ${s}${d ? ` (${d})` : ''}`),
  onRejected: (s, r) => console.log(`stream ${s} rejected: ${r}`),
  onDepth: (_sym, msg) => {
    out?.write(JSON.stringify({ rx: Date.now(), ...msg }) + '\n');
    const now = Date.now();
    if (lastDepthAt) depthGapsMs.push(now - lastDepthAt);
    lastDepthAt = now;
    const b = bookFromDepth(msg, tick, now);
    const sp = spreadTicks(b);
    if (sp !== undefined) spreads.push(sp);
    bidLevels.push(b.bids.ticks.length);
    askLevels.push(b.asks.ticks.length);
    if (b.bids.sizes[0] !== undefined) topSizes.push(b.bids.sizes[0]);
    if (b.asks.sizes[0] !== undefined) topSizes.push(b.asks.sizes[0]);
    ladder.push(ladderScore([...b.bids.sizes, ...b.asks.sizes]).score);
    const m = midTicks(b);
    const pm = last ? midTicks(last) : undefined;
    if (m !== undefined && pm !== undefined && m !== pm) {
      midChanges++;
      midMoves.push(Math.abs(m - pm));
    }
    if (m !== undefined && lastMark !== undefined) midVsMarkTicks.push(m - lastMark / tick);
    last = b;
  },
  onTrade: (_sym, msg) => {
    out?.write(JSON.stringify({ rx: Date.now(), ...msg }) + '\n');
    trades++;
    tradeQty.push(Number(msg.data.qty));
    tradeNotional.push(Number(msg.data.quoteQty));
  },
  onTicker: (_sym, msg) => {
    out?.write(JSON.stringify({ rx: Date.now(), ...msg }) + '\n');
    const mark = Number(msg.data.markPrice);
    const index = Number(msg.data.indexPrice);
    if (Number.isFinite(mark)) lastMark = mark;
    if (Number.isFinite(mark) && Number.isFinite(index) && index > 0) {
      basisBps.push(((mark - index) / index) * 1e4);
    }
  },
}, WS_URL, (url) => new WebSocket(url) as unknown as SocketLike);

sock.subscribe(info.symbol, ['depth', 'trades', 'ticker']);
sock.start();

setTimeout(() => {
  sock.stop();
  out?.end();
  const perSec = (n: number) => +(n / seconds).toFixed(2);
  const fmt = (o: object) => JSON.stringify(o);
  console.log('\n=== results ===');
  console.log(`depth msgs/s        ${perSec(depthGapsMs.length + 1)}   gap ms ${fmt(dist(depthGapsMs))}`);
  console.log(`levels bid          ${fmt(dist(bidLevels))}`);
  console.log(`levels ask          ${fmt(dist(askLevels))}`);
  console.log(`spread ticks        ${fmt(dist(spreads))}`);
  console.log(`top-of-book size    ${fmt(dist(topSizes))}`);
  console.log(`ladder score 0..1   ${fmt(dist(ladder))}   (~1 = one quoter's size ladder, ~0 = organic)`);
  console.log(`mid changes/s       ${perSec(midChanges)}   move ticks ${fmt(dist(midMoves))}`);
  console.log(`trades/min          ${+((trades / seconds) * 60).toFixed(2)}   qty ${fmt(dist(tradeQty))}`);
  console.log(`trade notional USD  ${fmt(dist(tradeNotional))}`);
  console.log(`mark-index bps      ${fmt(dist(basisBps))}`);
  console.log(`book mid - mark tks ${fmt(dist(midVsMarkTicks))}`);
  process.exit(0);
}, seconds * 1000);
