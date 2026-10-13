import { useEffect, useState } from 'react';
import { CME_MULTIPLIER, displayRoot } from '../src/panel/model';
import { failPtsAtLev, inGroup, marketLevCap, riskCalc, type RiskGroup } from '../src/panel/riskcalc';
import { fetchTickers } from '../src/vest/rest';
import { tickSizeOf } from '../src/vest/symbols';
import type { SymbolInfo } from '../src/vest/types';
import type { Settings } from './settings';

// The Risk page: what a size, stop and leverage mean for this account on any Vest market. It reads
// the panel's live account and prices; "Use in DOM" writes the plan into the ticket. It never sends
// an order.

export interface RiskViewProps {
  s: Settings;
  update: (p: Partial<Settings>) => void;
  /** Every Vest market (exchangeInfo) and the one on screen. */
  infos: SymbolInfo[];
  cur: SymbolInfo | undefined;
  /** Live mid of the market on screen. */
  curPx: number | undefined;
  /** The DOM's stop and target for the market on screen, points (0 = none). */
  curStopPts: number;
  curTpPts: number;
  /** Account: equity, room to the fail floor, and the leverage the panel would use on a market. */
  equity: number;
  room: number;
  levFor: (info: SymbolInfo) => number;
  live: boolean;
  /** Put a market on screen (true when it switched). */
  select: (symbol: string) => boolean;
  onClose: () => void;
}

const usd = (v: number) => {
  if (!Number.isFinite(v)) return '—';
  const x = Math.abs(v);
  const t = x >= 1000 ? `$${Math.round(x).toLocaleString('en-US')}` : x >= 100 ? `$${x.toFixed(0)}` : `$${x.toFixed(2)}`;
  return v < 0 ? `−${t}` : t;
};
const num = (v: number) => {
  if (!Number.isFinite(v)) return '∞';
  if (v === 0) return '0';
  const x = Math.abs(v);
  return x >= 1000 ? Math.round(v).toLocaleString('en-US') : x >= 100 ? v.toFixed(1) : x >= 1 ? v.toFixed(2) : v.toFixed(4);
};
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(Math.abs(v) < 0.001 ? 3 : 2)}%` : '—');
/** Vest Instant funding sizes and their static drawdown (funded.now listing, 2026-10; $500 = $10
 * matches the owner's own account). */
const INSTANT = [
  { label: '$500', bal: 500, room: 10 },
  { label: '$5K', bal: 5000, room: 200 },
  { label: '$10K', bal: 10000, room: 400 },
  { label: '$25K', bal: 25000, room: 1000 },
];
const nice = (v: number) => (v >= 10 ? Math.round(v) : Number(v.toPrecision(2)));

export function RiskView(p: RiskViewProps) {
  const { s, update, infos, cur } = p;
  const [sym, setSym] = useState(cur?.symbol ?? '');
  const info = infos.find((i) => i.symbol === sym) ?? cur;
  const onScreen = !!info && info.symbol === cur?.symbol;
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [long, setLong] = useState(true);
  const [mode, setMode] = useState<'risk' | 'lev'>('risk');
  const [riskPct, setRiskPct] = useState(s.sizeMode === 'room' ? s.sizeInput : 25);
  const [lev, setLev] = useState(5);
  const [entryIn, setEntryIn] = useState('');
  const [stopIn, setStopIn] = useState('');
  const [tpIn, setTpIn] = useState('');
  // "What if" account (another package); empty = this account.
  const [plan, setPlan] = useState<{ bal: string; room: string; max: string } | null>(null);
  const [used, setUsed] = useState('');

  const shown = infos.filter((i) => inGroup(displayRoot(i), s.riskGroup) || i.symbol === info?.symbol);
  const shownKey = shown.map((i) => i.symbol).join(',');
  useEffect(() => {
    let dead = false;
    const syms = shownKey.split(',').filter(Boolean);
    const load = () =>
      fetchTickers(syms).then(
        (ts) => {
          if (dead) return;
          const o: Record<string, number> = {};
          for (const t of ts) {
            const v = Number(t.markPrice);
            if (v > 0) o[t.symbol] = v;
          }
          setPrices((prev) => ({ ...prev, ...o }));
        },
        () => {},
      );
    void load();
    const h = setInterval(load, 10_000);
    return () => {
      dead = true;
      clearInterval(h);
    };
  }, [shownKey]);

  if (!info) return null;
  const pxOf = (i: SymbolInfo) => (i.symbol === cur?.symbol && p.curPx ? p.curPx : prices[i.symbol]);
  const livePx = pxOf(info);
  const parse = (v: string) => {
    const x = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(x) && x > 0 ? x : undefined;
  };
  const entry = parse(entryIn) ?? livePx ?? 0;
  const defStop = onScreen && p.curStopPts > 0 ? p.curStopPts : entry ? nice(entry * 0.001) : 0;
  const stopPts = parse(stopIn) ?? defStop;
  const tpPts = parse(tpIn) ?? (onScreen && p.curTpPts > 0 ? p.curTpPts : nice(stopPts * 2));
  const balance = (plan && parse(plan.bal)) ?? p.equity;
  const room = plan ? (parse(plan.room) ?? 0) : p.room;
  const capFor = (i: SymbolInfo) => (plan ? marketLevCap(i.initMarginRatio, parse(plan.max)) : p.levFor(i));
  const levCap = capFor(info);
  const fee = Number(info.takerFee ?? 0) || 0;
  const riskUsd = (Math.max(0, room) * riskPct) / 100;
  const r = riskCalc({ balance, room, levCap, price: entry, feeRate: fee, stopPts, targetPts: tpPts, mode, riskUsd, lev, sizeDecimals: info.sizeDecimals });
  const root = displayRoot(info);
  const cme = CME_MULTIPLIER[root];
  const tick = tickSizeOf(info);
  const dir = long ? 1 : -1;
  const dpx = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, Math.min(6, Math.round(-Math.log10(tick)))) });

  const pick = (i: SymbolInfo) => {
    setSym(i.symbol);
    setEntryIn('');
    setStopIn('');
    setTpIn('');
    setUsed('');
  };
  const useInDom = () => {
    if (!onScreen && !p.select(info.symbol)) return setUsed(`couldn't open ${info.displaySymbol ?? info.symbol}`);
    const t = tickSizeOf(info);
    const sizing: Partial<Settings> = mode === 'risk' ? { sizeMode: 'room', sizeInput: riskPct } : { sizeMode: 'units', sizeInput: r.units };
    update({ ...(onScreen ? {} : { symbol: info.symbol }), ...sizing, stopMode: 'pts', slTicks: Math.round(stopPts / t), tpTicks: Math.round(tpPts / t), tp2Ticks: 0, tp3Ticks: 0, bracketsOn: true });
    setUsed(mode === 'risk' ? `DOM: ${riskPct}% of room at the stop, SL ${num(stopPts)} / TP ${num(tpPts)} pts` : `DOM: ${num(r.units)} u, SL ${num(stopPts)} / TP ${num(tpPts)} pts`);
  };

  // Risk map: target, entry, stop and (when near) the fail line on one price axis.
  const H = 360;
  const pTp = entry + dir * tpPts;
  const pSl = entry - dir * stopPts;
  const pFail = entry - dir * r.failPts;
  const failOn = Number.isFinite(r.failPts) && r.failPts <= stopPts * 2.6;
  let lo = Math.min(pTp, pSl, failOn ? pFail : pSl);
  let hi = Math.max(pTp, pSl, failOn ? pFail : pSl);
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad;
  hi += pad;
  const Y = (v: number) => 12 + ((hi - v) / (hi - lo)) * (H - 40);
  const lines = [
    { k: 'tp', name: 'Target', price: pTp, note: `+${usd(r.win)}` },
    { k: 'entry', name: 'Entry', price: entry, note: `${r.levUsed.toFixed(1)}x` },
    { k: 'sl', name: 'Stop', price: pSl, note: usd(-r.loss) },
    ...(failOn ? [{ k: 'fail', name: 'Account fails', price: pFail, note: usd(-room) }] : []),
  ];
  const zone = (a: number, b: number) => ({ top: Math.min(Y(a), Y(b)), height: Math.abs(Y(a) - Y(b)) });
  const dead = failOn ? (long ? { top: Y(pFail), height: H - Y(pFail) } : { top: 0, height: Y(pFail) }) : undefined;

  // Leverage chart: points to the fail line at each leverage, your stop as a line.
  const xMax = Math.max(50, levCap);
  const yTop = Math.max(stopPts * 3, failPtsAtLev(balance, room, entry, 2)) || 1;
  const cx = (L: number) => 50 + ((L - 1) / (xMax - 1)) * 700;
  const cy = (v: number) => 200 - (Math.min(v, yTop) / yTop) * 190;
  const curve: string[] = [];
  for (let L = 1; L <= xMax; L += 0.5) curve.push(`${cx(L).toFixed(1)},${cy(failPtsAtLev(balance, room, entry, L)).toFixed(1)}`);
  const lu = Math.min(Math.max(r.levUsed, 1), xMax);
  const dX = cx(Math.max(1, Math.min(r.levStopFails, levCap)));

  // Every market in the filter: same account, same $ risk, stop at the same % of price.
  const stopFrac = entry ? stopPts / entry : 0;
  const rows = shown
    .map((i) => {
      const px = pxOf(i);
      if (!px) return { i, px: undefined };
      const cap = capFor(i);
      const rr = riskCalc({ balance, room, levCap: cap, price: px, feeRate: Number(i.takerFee ?? 0) || 0, stopPts: px * stopFrac, targetPts: 0, mode: 'risk', riskUsd, lev: 1, sizeDecimals: i.sizeDecimals });
      return { i, px, cap, rr, failMax: failPtsAtLev(balance, room, px, cap) / px };
    })
    .sort((a, b) => (b.failMax ?? -1) - (a.failMax ?? -1));
  const maxFail = Math.max(1e-12, ...rows.map((x) => x.failMax ?? 0));

  const alert = r.stopPastFail
    ? `Your stop is past the fail line: the account fails ${num(r.failPts)} pts in, before the ${num(stopPts)}-pt stop. Cut the size or tighten the stop.`
    : r.capped
      ? `That risk needs more than ${levCap}x. Size is capped at the max, so you risk ${usd(r.loss)}, not ${usd(riskUsd)}.`
      : s.maxLevUser > 0 && r.levUsed > s.maxLevUser
        ? `${r.levUsed.toFixed(1)}x is over your own ${s.maxLevUser}x limit.`
        : '';
  const roomColor = r.roomUsed > 0.5 ? 'bad' : r.roomUsed > 0.25 ? 'mid' : 'ok';

  return (
    <div className="riskview" role="dialog" aria-label="Risk calculator">
      <div className="rv-head">
        <div>
          <b>Risk calculator</b>
          <small>
            {plan ? 'planning another package' : p.live ? 'your LIVE Vest account' : 'your PAPER account'} · prices from Vest · never sends an order
          </small>
        </div>
        <div className="rv-headbtns">
          <button className="rv-use" onClick={useInDom} disabled={!r.units || !stopPts} title="writes this size rule, stop and target into the DOM ticket (stop mode: points). Nothing is sent.">
            Use in DOM{onScreen ? '' : ` (open ${root})`}
          </button>
          <button className="mini" onClick={p.onClose} aria-label="Close the risk calculator">
            ✕
          </button>
        </div>
      </div>
      {used && <div className="rv-used">✓ {used}</div>}

      <div className="rv-body">
        <section className="rv-card rv-inputs">
          <div className="rv-field">
            <span className="rv-lbl">Account</span>
            <div className="rv-seg">
              <button className={plan ? '' : 'on'} onClick={() => setPlan(null)}>
                Mine
              </button>
              <button className={plan ? 'on' : ''} onClick={() => setPlan({ bal: '5000', room: '200', max: '25' })}>
                Another package
              </button>
            </div>
            {plan && (
              <div className="rv-seg" title="Vest Instant funding (no evaluation): static drawdown, 2% on $500 and 4% on the rest, as listed on funded.now (2026-10). Check your own Vest screen; every box stays editable.">
                {INSTANT.map((x) => (
                  <button key={x.bal} className={plan.bal === String(x.bal) && plan.room === String(x.room) ? 'on' : ''} onClick={() => setPlan({ bal: String(x.bal), room: String(x.room), max: plan.max })}>
                    {x.label}
                  </button>
                ))}
              </div>
            )}
            {plan && <small className="rv-note">Instant: fails ${plan.room} under the start, static (the floor never moves up).</small>}
          </div>
          <div className="rv-grid2">
            <label className="rv-field">
              <span className="rv-lbl">Balance</span>
              <span className="rv-inp">
                $<input value={plan ? plan.bal : p.equity.toFixed(2)} disabled={!plan} onChange={(e) => plan && setPlan({ ...plan, bal: e.target.value })} />
              </span>
            </label>
            <label className="rv-field">
              <span className="rv-lbl">Room to fail</span>
              <span className="rv-inp">
                $<input value={plan ? plan.room : p.room.toFixed(2)} disabled={!plan} onChange={(e) => plan && setPlan({ ...plan, room: e.target.value })} />
              </span>
            </label>
            <label className="rv-field">
              <span className="rv-lbl">{plan ? 'Account max lev' : `Leverage on ${root}`}</span>
              <span className="rv-inp">
                <input value={plan ? plan.max : String(levCap)} disabled={!plan} onChange={(e) => plan && setPlan({ ...plan, max: e.target.value })} />x
              </span>
            </label>
            <label className="rv-field" title="the DOM asks for a second click on an entry over this leverage (0 = off). Nothing is blocked.">
              <span className="rv-lbl">My max lev</span>
              <span className="rv-inp">
                <input type="number" min={0} step={1} value={s.maxLevUser} onChange={(e) => update({ maxLevUser: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />x
              </span>
            </label>
          </div>

          <div className="rv-field">
            <span className="rv-lbl">Market</span>
            <div className="rv-seg">
              {(['fut', 'crypto', 'all'] as RiskGroup[]).map((g) => (
                <button key={g} className={s.riskGroup === g ? 'on' : ''} onClick={() => update({ riskGroup: g })}>
                  {g === 'fut' ? 'Futures' : g === 'crypto' ? 'Crypto' : 'All'}
                </button>
              ))}
            </div>
            <select value={info.symbol} onChange={(e) => pick(infos.find((i) => i.symbol === e.target.value) ?? info)}>
              {shown.map((i) => (
                <option key={i.symbol} value={i.symbol}>
                  {i.displaySymbol ?? i.symbol} · {capFor(i)}x{i.symbol === cur?.symbol ? ' · on screen' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="rv-seg">
            <button className={long ? 'on long' : ''} onClick={() => setLong(true)}>
              Long
            </button>
            <button className={long ? '' : 'on short'} onClick={() => setLong(false)}>
              Short
            </button>
          </div>
          <div className="rv-field">
            <span className="rv-lbl">Size it by</span>
            <div className="rv-seg">
              <button className={mode === 'risk' ? 'on' : ''} onClick={() => setMode('risk')}>
                Stop + $ risk
              </button>
              <button
                className={mode === 'lev' ? 'on' : ''}
                onClick={() => {
                  setMode('lev');
                  setLev(Math.max(1, Math.min(levCap, Math.round(r.levUsed) || 1)));
                }}
              >
                Leverage
              </button>
            </div>
          </div>
          <div className="rv-grid3">
            <label className="rv-field">
              <span className="rv-lbl">Entry</span>
              <span className="rv-inp">
                <input value={entryIn || (entry ? dpx(entry) : '')} onChange={(e) => setEntryIn(e.target.value)} />
              </span>
            </label>
            <label className="rv-field">
              <span className="rv-lbl">Stop pts</span>
              <span className="rv-inp">
                <input value={stopIn || (stopPts ? String(stopPts) : '')} onChange={(e) => setStopIn(e.target.value)} />
              </span>
            </label>
            <label className="rv-field">
              <span className="rv-lbl">Target pts</span>
              <span className="rv-inp">
                <input value={tpIn || (tpPts ? String(tpPts) : '')} onChange={(e) => setTpIn(e.target.value)} />
              </span>
            </label>
          </div>
          {entryIn && (
            <button className="mini" onClick={() => setEntryIn('')}>
              ↺ entry = live price
            </button>
          )}
          {mode === 'risk' ? (
            <label className="rv-field">
              <span className="rv-row">
                <span className="rv-lbl">Risk per trade</span>
                <b className="rv-neg">
                  {usd(riskUsd)} · {riskPct}% of room
                </b>
              </span>
              <input type="range" min={1} max={100} step={1} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} />
            </label>
          ) : (
            <label className="rv-field">
              <span className="rv-row">
                <span className="rv-lbl">Leverage</span>
                <b className="rv-acc">
                  {Math.min(lev, levCap)}x of {levCap}x
                </b>
              </span>
              <input type="range" min={1} max={Math.max(1, levCap)} step={1} value={Math.min(lev, levCap)} onChange={(e) => setLev(Number(e.target.value))} />
            </label>
          )}
        </section>

        <section className="rv-main">
          <div className={`rv-card rv-hero ${alert ? 'alert' : ''}`}>
            <div>
              <span className="rv-lbl">Order size</span>
              <div className={`rv-size ${long ? 'long' : 'short'}`}>
                {long ? 'BUY' : 'SELL'} {num(r.units)}
              </div>
              <small>
                units · {usd(r.notional)} notional{cme ? ` · ≈ ${(r.units / cme.full).toFixed(3)} ${cme.name}` : ''}
                {!livePx && ' · waiting for price'}
              </small>
            </div>
            <div className="rv-kpis">
              <div>
                <span className="rv-lbl">Leverage</span>
                <b>{r.levUsed.toFixed(1)}x</b>
                <small>cap {levCap}x</small>
              </div>
              <div>
                <span className="rv-lbl">If stopped</span>
                <b className="rv-neg">{usd(r.loss)}</b>
                <small>{pct(Math.min(r.roomUsed, 9.99))} of room</small>
              </div>
              <div>
                <span className="rv-lbl">At target</span>
                <b className="rv-acc">{usd(r.win)}</b>
                <small>{r.rr.toFixed(2)} R:R after fees</small>
              </div>
            </div>
          </div>
          {alert && <div className="rv-alert">⚠ {alert}</div>}

          <div className="rv-split">
            <div className="rv-card">
              <div className="rv-title">
                Risk map <small>{info.displaySymbol ?? info.symbol}</small>
              </div>
              <div className="rv-map" style={{ height: H }}>
                <i className="z tp" style={zone(entry, pTp)} />
                <i className="z sl" style={zone(entry, pSl)} />
                {dead && <i className="z dead" style={dead} />}
                {lines.map((l) => (
                  <div key={l.k} className={`ln ${l.k}`} style={{ top: Y(l.price) }}>
                    <span style={{ top: Y(l.price) < 26 ? 4 : -18 }}>{l.name}</span>
                    <span style={{ top: Y(l.price) < 26 ? 4 : -18 }}>
                      {dpx(l.price)} <small>{l.note}</small>
                    </span>
                  </div>
                ))}
                <small className="foot">
                  {failOn ? '' : `account fails ${num(r.failPts)} pts away (${dpx(pFail)}) · `}liquidation ≈ {num(r.liqPts)} pts away
                </small>
              </div>
            </div>
            <div className="rv-col">
              <div className="rv-card">
                <div className="rv-title">What a move is worth</div>
                <div className="rv-stat">
                  <span>1 point</span>
                  <b>{usd(r.units)}</b>
                </div>
                <div className="rv-stat">
                  <span>10 points</span>
                  <b>{usd(r.units * 10)}</b>
                </div>
                <div className="rv-stat">
                  <span>0.1% move ({num(entry * 0.001)} pts)</span>
                  <b>{usd(r.notional * 0.001)}</b>
                </div>
                <div className="rv-stat">
                  <span>1% move ({num(entry * 0.01)} pts)</span>
                  <b>{usd(r.notional * 0.01)}</b>
                </div>
                <div className="rv-stat">
                  <span>Fees, round trip</span>
                  <b>
                    {usd(r.fees)} = {num(2 * entry * fee)} pts
                  </b>
                </div>
              </div>
              <div className="rv-card">
                <div className="rv-title">Account</div>
                <div className="rv-row">
                  <small>Room used if stopped</small>
                  <small>{pct(Math.min(r.roomUsed, 9.99))}</small>
                </div>
                <div className="rv-bar">
                  <i className={roomColor} style={{ width: `${Math.min(100, r.roomUsed * 100).toFixed(1)}%` }} />
                </div>
                <div className="rv-stat">
                  <span>Losers like this before it fails</span>
                  <b>{Number.isFinite(r.losersLeft) ? r.losersLeft : '—'}</b>
                </div>
                <div className="rv-stat">
                  <span>Account fails at</span>
                  <b>
                    {Number.isFinite(r.failPts) ? `${dpx(pFail)} (${num(r.failPts)} pts)` : '—'}
                  </b>
                </div>
                <div className="rv-stat">
                  <span>Max size at {levCap}x</span>
                  <b>{num(r.maxUnits)} u</b>
                </div>
              </div>
            </div>
          </div>

          <div className="rv-card">
            <div className="rv-title">
              Leverage vs room before the account fails <small>{info.displaySymbol ?? info.symbol}</small>
            </div>
            <svg viewBox="0 0 760 230" width="100%" role="img" aria-label="points to the fail line at each leverage">
              <rect x={cx(levCap)} y={10} width={Math.max(0, 750 - cx(levCap))} height={190} fill="rgba(248,113,113,.10)" />
              <rect x={dX} y={10} width={Math.max(0, cx(levCap) - dX)} height={190} fill="rgba(251,146,60,.08)" />
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={50} x2={750} y1={cy(yTop * f)} y2={cy(yTop * f)} stroke="#1c2638" />
                  <text x={44} y={cy(yTop * f) + 4} textAnchor="end" fill="#77839a" fontSize={11}>
                    {num(yTop * f)}
                  </text>
                </g>
              ))}
              {[1, 5, 10, 25, 50, 75, 100]
                .filter((v) => v <= xMax)
                .map((v) => (
                  <text key={v} x={cx(v)} y={220} textAnchor="middle" fill="#77839a" fontSize={11}>
                    {v}x
                  </text>
                ))}
              <line x1={50} x2={750} y1={cy(stopPts)} y2={cy(stopPts)} stroke="#fb923c" strokeDasharray="6 5" strokeWidth={1.5} />
              <polyline points={curve.join(' ')} fill="none" stroke="#22d3ee" strokeWidth={2.5} />
              {r.units > 0 && (
                <>
                  <circle cx={cx(lu)} cy={cy(r.failPts)} r={6} fill="#090d15" stroke="#e6e9f2" strokeWidth={2.5} />
                  <text x={cx(lu)} y={cy(r.failPts) - 12} textAnchor="middle" fill="#e6e9f2" fontSize={12} fontWeight={700}>
                    {r.levUsed.toFixed(1)}x
                  </text>
                </>
              )}
            </svg>
            <small className="rv-note">
              <b className="rv-acc">━</b> pts to the fail line · <b className="rv-neg">┅</b> your stop · red = over the cap.{' '}
              {r.levStopFails < levCap
                ? `Above ${r.levStopFails.toFixed(1)}x the account fails before a ${num(stopPts)}-pt stop is hit (orange). You are at ${r.levUsed.toFixed(1)}x.`
                : `Up to the ${levCap}x cap, your ${num(stopPts)}-pt stop is always hit before the account fails.`}
            </small>
          </div>
        </section>
      </div>

      <section className="rv-card rv-table">
        <div className="rv-title">
          Every market · same account, same {usd(riskUsd)} risk, stop = {pct(stopFrac)} of price <small>click a row to load it</small>
        </div>
        <div className="rv-scroll">
          <div className="rv-tr hd">
            <span>Market</span>
            <span>Price</span>
            <span>Cap</span>
            <span>Move to fail at max size</span>
            <span>Size</span>
            <span>Lev used</span>
            <span>$ / point</span>
            <span>$ / 1%</span>
          </div>
          {rows.map((x) => (
            <button key={x.i.symbol} className={`rv-tr ${x.i.symbol === info.symbol ? 'on' : ''}`} onClick={() => pick(x.i)}>
              <span className="sym">{x.i.displaySymbol ?? x.i.symbol}</span>
              {x.px && x.rr && x.cap !== undefined && x.failMax !== undefined ? (
                <>
                  <span>{x.px.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                  <span>{x.cap}x</span>
                  <span className="barcell">
                    <span className="rv-bar">
                      <i className={x.failMax * x.px < x.px * stopFrac ? 'bad' : 'ok'} style={{ width: `${((x.failMax / maxFail) * 100).toFixed(1)}%` }} />
                    </span>
                    <span>
                      {pct(x.failMax)} · {num(x.failMax * x.px)} pts
                    </span>
                  </span>
                  <span>{num(x.rr.units)}</span>
                  <span>{x.rr.levUsed.toFixed(1)}x</span>
                  <span>{usd(x.rr.units)}</span>
                  <span>{usd(x.rr.notional * 0.01)}</span>
                </>
              ) : (
                <span className="muted">loading…</span>
              )}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
