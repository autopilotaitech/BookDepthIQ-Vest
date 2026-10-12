import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { bestAsk, bestBid } from '../src/book/book';
import { PanelModel } from '../src/panel/model';
import { formatPrice, tickDecimals, type BracketSettings, type Result, type Side, type WorkingOrder } from '../src/sim/paper';
import { journalCsv, journalStats, marketState, rMultiple, swingStopTicks, type JournalTrade } from '../src/panel/structure';
import { feedHealth, needsConfirm, percentiles, tradeChecks, type TradeCheck } from '../src/panel/checks';
import type { Session } from '../src/panel/replay';
import { failPrice, leverageUsed, marginUsed, maxUnits, unitsForNotional } from '../src/sim/account';
import { dayCheck, dayLimitHit, riskWithFees, tradingDay, unitsForRiskWithFees, type DayState } from '../src/panel/protect';
import { weekendCloseAt } from '../src/live/manage';
import { fetchMarketHours } from '../src/vest/rest';
import { aggregate, bucketOf, offscreen, rowPnlUsd, stepGroup } from '../src/panel/ladderMath';
import { loadSettings, saveSettings, type Settings, type SizeMode } from './settings';
import { edgeRatio, roundTrip, spreadGate } from '../src/panel/cost';
import { bidShare, imbalances, walls } from '../src/panel/footprint';
import { indicatorsFor, parseBands, stackZones, type IndicatorCfg } from '../src/panel/indicators';
import { orLabel, orRoot } from '../src/panel/paxor';
import { fundingUsdPerHour, nextSettlement } from '../src/panel/funding';
import { buildProfile } from '../src/panel/profile';
import { watchHookStatus, watchUserToken, watchVestTabs } from './liveToken';
import { liveOpenPnl } from '../src/live/rules';
import { parseSplit, scaleOrders, splitTargets, type SkewDir, type Target } from '../src/live/targets';
import type { BracketCtx } from '../src/live/session';

const ROW_PX = 22;

function useModel(): PanelModel {
  const ref = useRef<PanelModel | null>(null);
  if (!ref.current) ref.current = new PanelModel();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => ref.current!.subscribe(force), []);
  return ref.current;
}

const fmtUsd = (v: number) => `${v < 0 ? '-' : v > 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
/** Compact volume: 0.81, 12.3, 106 — fewer digits, less noise on the ladder. */
const fmtVol = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const pnlClass = (v: number) => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : '');
const fmtK = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

/**
 * A price-distance box in POINTS, stored in ticks. Perp P&L is units × points, so points are the
 * natural unit; ticks stay internal because orders must land on the venue's 0.25 grid. Keeps its
 * own text while typing (so "1." or "1.2" are not snapped mid-entry) and snaps to the grid on blur.
 */
function PointsInput(props: { ticks: number; tick: number; signed?: boolean; onTicks: (t: number) => void }) {
  const { ticks, tick, signed, onTicks } = props;
  const dec = tickDecimals(tick);
  const shown = (ticks * tick).toFixed(dec);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const t = Math.round(v / tick);
    onTicks(signed ? t : Math.max(0, t));
  };
  return (
    <input
      type="number"
      step={tick}
      min={signed ? undefined : 0}
      value={editing ? text : shown}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setEditing(false)}
    />
  );
}

/** The trade journal: totals, results by setup, the last trades, CSV export. */
function JournalView(props: { trades: JournalTrade[]; onClear: () => void }) {
  const { trades, onClear } = props;
  const st = journalStats(trades);
  const fR = (r: number | undefined) => (r === undefined ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
  return (
    <div className="journal">
      <div className="jsum">
        <b>{st.n}</b> trades · <b>{Math.round(st.winRate * 100)}%</b> won · <b className={pnlClass(st.totalUsd)}>{fmtUsd(st.totalUsd)}</b> · avg <b>{fR(st.avgR)}</b>
      </div>
      <div className="jset" title="execution: slippage = filled vs the price you expected when you clicked (+ = worse); fees on entries; maker = limit fills, taker = market/stop fills; ack = Vest's answer time (LIVE)">
        <span>slip avg <b>{st.exec.avgSlipPts === undefined ? '—' : `${st.exec.avgSlipPts.toFixed(2)} pts`}</b> ({fmtUsd(st.exec.slipUsd)})</span>
        <span>fees <b>{fmtUsd(-st.exec.feesUsd)}</b></span>
        <span>maker/taker <b>{st.exec.maker}/{st.exec.taker}</b></span>
        <span>ack <b>{st.exec.ack ? `${st.exec.ack.p50}/${st.exec.ack.p95} ms` : '—'}</b></span>
      </div>
      {st.bySetup.length > 1 && (
        <div className="jset">
          {st.bySetup.map((x) => (
            <span key={x.setup}>
              {x.setup} {x.n}: <span className={pnlClass(x.totalUsd)}>{fmtUsd(x.totalUsd)}</span> {fR(x.avgR)}
            </span>
          ))}
        </div>
      )}
      <div className="jbtns">
        <button className="mini" onClick={() => void navigator.clipboard?.writeText(journalCsv(trades)).catch(() => {})}>
          copy CSV
        </button>
        <button className="mini" onClick={onClear}>
          clear
        </button>
      </div>
      {[...trades]
        .reverse()
        .slice(0, 60)
        .map((t) => (
          <div key={`${t.open}-${t.sym}`} className="jrow" title={`${t.mode} · expected ${t.expected ?? '—'} · entry ${t.entry}${t.exit ? ` → ${t.exit}` : ''}${t.stop ? ` · stop ${t.stop}` : ''} · ${t.stopMode} stop${t.liquidity ? ` · ${t.liquidity}` : ''}${t.feeUsd !== undefined ? ` · fee $${t.feeUsd.toFixed(2)}` : ''}${t.ackMs !== undefined ? ` · ack ${t.ackMs} ms` : ''}${t.approx ? ' · LIVE result is the last marked P&L (≈)' : ''}`}>
            <span>{new Date(t.close).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
            <span>{t.sym.replace(/-PERP$/, '')}</span>
            <span className={t.side === 'long' ? 'pos' : 'neg'}>{t.side === 'long' ? 'L' : 'S'}</span>
            <span>{t.setup || '—'}</span>
            <span>{fR(rMultiple(t))}</span>
            <span className={t.slipPts !== undefined && t.slipPts > 0 ? 'neg' : 'muted'}>{t.slipPts === undefined ? '' : `${t.slipPts > 0 ? '+' : ''}${t.slipPts.toFixed(2)}`}</span>
            <span className={pnlClass(t.pnl)}>
              {t.approx ? '≈' : ''}
              {fmtUsd(t.pnl)}
            </span>
          </div>
        ))}
      {trades.length === 0 && <div className="muted">no trades yet — tag a setup on the ticket before you enter</div>}
    </div>
  );
}

/**
 * In a trade: SL, entry, now and every target on one bar, with $ at each. Display only. Legs are
 * Vest's own in LIVE and the paper broker's in PAPER.
 */
function BracketBar(props: { long: boolean; qty: number; avgTicks: number; nowTicks: number | undefined; legs: WorkingOrder[]; fail: number | undefined; tick: number; fee: number; roomUsd: number }) {
  const { long, qty, avgTicks, nowTicks, legs, fail, tick, fee, roomUsd } = props;
  const dir = long ? 1 : -1;
  const usd = (t: number, q: number) => (t - avgTicks) * dir * q * tick;
  const tps = legs.filter((l) => l.leg === 'tp').sort((a, b) => (a.priceTicks - b.priceTicks) * dir);
  const sls = legs.filter((l) => l.leg === 'sl');
  const pts = [avgTicks, ...legs.map((l) => l.priceTicks), ...(nowTicks !== undefined ? [nowTicks] : [])];
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < 4) {
    lo -= 2;
    hi += 2;
  }
  // Left = the losing side, right = the winning side, for longs and shorts alike.
  const x = (t: number) => `${(((long ? t - lo : hi - t) / (hi - lo)) * 92 + 4).toFixed(2)}%`;
  const open = nowTicks === undefined ? undefined : usd(nowTicks, qty);
  const sl = sls[0];
  // Worst case now: the stop fills (plus the exit fee); with no stop, everything down to the floor.
  const worst = sl ? usd(sl.priceTicks, qty) - qty * sl.priceTicks * tick * fee : -Math.max(0, roomUsd);
  return (
    <section className="brbar">
      <div className="brhead">
        <b className={long ? 'pos' : 'neg'}>{long ? 'LONG' : 'SHORT'}</b> {qty}
        {open !== undefined && (
          <>
            {' '}
            <b className={pnlClass(open)}>{fmtUsd(open)}</b> <small>{(((nowTicks! - avgTicks) * dir) * tick).toFixed(2)} pts</small>
          </>
        )}
        <small className={worst < 0 ? 'neg' : 'pos'} title="what you lose (or keep) if the stop fills now, exit fee included; with no stop, the room left to the fail floor">
          {sl ? ` · worst case now ${fmtUsd(worst)}` : ` · NO STOP — worst case ${fmtUsd(worst)} (to the floor)`}
        </small>
        {fail !== undefined && <small> · fail {formatPrice(fail, tick)}</small>}
      </div>
      <div className="brtrack">
        {sl && <i className="zone loss" style={{ left: long ? x(sl.priceTicks) : x(avgTicks), right: `calc(100% - ${long ? x(avgTicks) : x(sl.priceTicks)})` }} />}
        {tps.length > 0 && <i className="zone win" style={{ left: long ? x(avgTicks) : x(tps.at(-1)!.priceTicks), right: `calc(100% - ${long ? x(tps.at(-1)!.priceTicks) : x(avgTicks)})` }} />}
        {sls.map((l) => (
          <span key={l.id} className="mk sl" style={{ left: x(l.priceTicks) }}>
            <em>SL {formatPrice(l.priceTicks, tick)}</em>
            <small>{fmtUsd(usd(l.priceTicks, qty))}</small>
          </span>
        ))}
        <span className="mk in" style={{ left: x(avgTicks) }}>
          <em>IN {formatPrice(Math.round(avgTicks), tick)}</em>
        </span>
        {tps.map((l, i) => (
          <span key={l.id} className="mk tp" style={{ left: x(l.priceTicks) }}>
            <em>TP{tps.length > 1 ? i + 1 : ''} {formatPrice(l.priceTicks, tick)}</em>
            <small>
              {fmtUsd(usd(l.priceTicks, Math.min(l.qty, qty)))}
              {tps.length > 1 ? ` · ${l.qty}u` : ''}
            </small>
          </span>
        ))}
        {nowTicks !== undefined && <span className="mk now" style={{ left: x(nowTicks) }} title={`now ${formatPrice(nowTicks, tick)}`} />}
      </div>
    </section>
  );
}

export function App() {
  const m = useModel();
  const [s, setS] = useState<Settings>(loadSettings);
  const [center, setCenter] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: number; from: number } | null>(null);
  // Rows per price: your zoom, widened when needed so the stop, targets and trail fit on screen.
  const [fitG, setFitG] = useState(1);
  const g = Math.max(1, s.groupTicks, s.fitBracket ? fitG : 1);
  const bk = (x: number | undefined) => (x === undefined ? undefined : bucketOf(x, g));
  // Hotkeys that OPEN risk (B/S/R/E) only work while armed; F (flatten) and Esc (cancel all) always do.
  const [armed, setArmed] = useState(false);
  const [nRows, setNRows] = useState(40);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const n = Math.max(10, Math.floor(el.clientHeight / ROW_PX) & ~1);
      setNRows(n);
      // Stretch rows to share the leftover pixels so the last row meets the ticket.
      el.style.setProperty('--row-h', `${el.clientHeight / n}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const started = useRef(false);

  const update = useCallback((patch: Partial<Settings>) => {
    setS((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // Start the market socket ONCE with the saved symbol; stop it only when the panel unmounts.
  // (It used to depend on s.symbol, so switching instruments ran the cleanup, stopped the socket,
  // and the `started` guard never restarted it: only the first instrument ever got a live book.)
  const initialSymbol = useRef(s.symbol);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void m.start(initialSymbol.current);
    return () => {
      started.current = false;
      m.stop();
    };
  }, [m]);

  // Vest Liquidity Scanner row click → background stores { symbol, at } in storage.session → switch
  // here, exactly like picking it in the dropdown (held stops disarm on a switch). Retried for a
  // few seconds because a freshly opened panel's market list may still be loading.
  useEffect(() => {
    type Switch = { symbol?: unknown; at?: unknown };
    type Area = { get(k: string): Promise<Record<string, Switch | undefined>> };
    type OnChanged = { addListener(f: (c: Record<string, { newValue?: Switch }>, area: string) => void): void; removeListener(f: unknown): void };
    const chrome = (globalThis as { chrome?: { storage?: { session?: Area; onChanged?: OnChanged } } }).chrome;
    const session = chrome?.storage?.session;
    const onChanged = chrome?.storage?.onChanged;
    if (!session || !onChanged) return;
    let retry: ReturnType<typeof setInterval> | undefined;
    const apply = (v: Switch | undefined) => {
      if (!v || typeof v.symbol !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > 15_000) return;
      const sym = v.symbol;
      const until = (v.at as number) + 15_000;
      clearInterval(retry);
      const tryOnce = (): boolean => {
        if (m.select(sym)) {
          setCenter(null);
          update({ symbol: m.info?.symbol ?? sym });
          return true;
        }
        return Date.now() > until; // give up after 15 s
      };
      if (!tryOnce()) retry = setInterval(() => tryOnce() && clearInterval(retry), 500);
    };
    void session.get('scannerSwitch').then((r) => apply(r.scannerSwitch), () => {});
    const on = (c: Record<string, { newValue?: Switch }>, area: string) => {
      if (area === 'session' && c.scannerSwitch) apply(c.scannerSwitch.newValue);
    };
    onChanged.addListener(on);
    return () => {
      clearInterval(retry);
      onChanged.removeListener(on);
    };
  }, [m, update]);

  // Bracket settings are the user's numbers, applied to the paper broker as they change.
  // TP1 is the TP pts box; TP2/TP3 and the split turn it into partial targets.
  // ATR mode: stop = ATR of the 60 s candles × your multiple; targets = your R multiples of it. A
  // stop dragged on the preview overrides it until "snap back".
  // Swing mode: a long's stop under the low of the last N minutes, a short's over the high, so the
  // distance differs by side and by entry price; everything below asks per side (slFor / brFor).
  const atrMode = s.stopMode === 'atr';
  const swingMode = s.stopMode === 'swing';
  const rMode = atrMode || swingMode;
  const atrT = m.trend.t1.atrTicks();
  const [slOverride, setSlOverride] = useState<number | null>(null);
  const atrSl = atrT !== undefined && atrT > 0 ? Math.max(1, Math.round(atrT * s.atrMult)) : 0;
  const book0 = m.book;
  const ask0 = book0 ? bestAsk(book0) : undefined;
  const bid0 = book0 ? bestBid(book0) : undefined;
  const swingRange = swingMode ? m.bars.range(s.swingMins, Date.now()) : undefined;
  /** Stop distance in ticks for a long or short entered at `ref` (default: the ask / the bid). */
  const slFor = (long: boolean, ref?: number): number => {
    if (rMode && slOverride !== null) return slOverride;
    if (atrMode) return atrSl;
    if (swingMode) {
      const r = ref ?? (long ? ask0 : bid0);
      const d = r === undefined ? 0 : (swingStopTicks(long, r, swingRange, s.swingBufTicks) ?? 0);
      return d > 0 ? Math.max(d, s.swingMinTicks) : 0;
    }
    return s.slTicks;
  };
  const split = parseSplit(s.tpSplit);
  const tpsFor = (sl: number) => (rMode ? [0, 1, 2].map((i) => ((s.tpR[i] ?? 0) > 0 && sl > 0 ? Math.max(1, Math.round(sl * (s.tpR[i] ?? 0))) : 0)) : [s.tpTicks, s.tp2Ticks, s.tp3Ticks]);
  const brFor = (long: boolean, ref?: number): BracketCtx => {
    const sl = slFor(long, ref);
    const tps = tpsFor(sl);
    const tg: Target[] = tps.map((ticks, i) => ({ ticks, pct: split[i] ?? 0 }));
    return { bracketsOn: s.bracketsOn, tpTicks: tps[0]!, slTicks: sl, targets: tg, beAfterTp1: tg.filter((t) => t.ticks > 0).length >= 2 && s.beAfterTp1, beOffset: s.beOffset, trailStartR: s.trailLine ? 0 : s.trailStartR, trailLine: s.trailLine || undefined };
  };
  /** The paper broker's copy of a bracket (fixed on the order when you click). */
  const paperBr = (b: BracketCtx): BracketSettings => ({ enabled: b.bracketsOn, tpTicks: b.tpTicks, slTicks: b.slTicks, targets: b.targets, beAfterTp1: b.beAfterTp1, beOffset: b.beOffset, trailStartR: b.trailStartR, trailLine: b.trailLine });
  // What the ticket shows: the preview side, else the long side.
  const viewLong = s.preview !== 'short';
  const br = brFor(viewLong);
  const slEff = br.slTicks;
  const targets = br.targets!;
  const tpEff = targets.map((t) => t.ticks);
  const multiTp = targets.filter((t) => t.ticks > 0).length >= 2;
  const brKey = JSON.stringify(br);
  const broker = m.broker;
  useEffect(() => {
    if (broker) broker.bracket = paperBr(JSON.parse(brKey) as BracketCtx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broker, brKey]);

  useEffect(() => {
    m.account = { startEquity: s.startEquity, maxDrawdownUsd: s.maxDrawdownUsd, leverage: s.leverage };
    m.changed();
  }, [m, s.startEquity, s.maxDrawdownUsd, s.leverage]);

  // ── LIVE (LIVE-ORDERS-SPEC §4). Mode is not a setting: every launch starts in PAPER. ──
  const L = m.live;
  // Per-instrument indicator settings (VWAP, imbalances, big trades); the model re-anchors VWAP on change.
  const ind = indicatorsFor(s.indicators, m.info?.symbol);
  const indJson = JSON.stringify(ind);
  useEffect(() => {
    m.configureIndicators(JSON.parse(indJson) as IndicatorCfg);
  }, [m, indJson, m.info?.symbol]);
  const setInd = (patch: Partial<IndicatorCfg>) => {
    const sym = m.info?.symbol;
    if (!sym) return;
    update({ indicators: { ...s.indicators, [sym]: { ...(s.indicators[sym] ?? {}), ...patch } } });
  };
  const live = L.mode === 'live';
  // Two sources for the Vest login: the relay → storage.session chain, and the panel reading open
  // Vest tabs itself. Either one is enough.
  useEffect(() => {
    let fromStorage: string | null = null;
    let fromTabs: string | null = null;
    const seenWrites = new Set<string>();
    const apply = () => L.setUserToken(fromTabs ?? fromStorage);
    const offStorage = watchUserToken((t) => {
      fromStorage = t;
      apply();
    });
    const offStatus = watchHookStatus((h) => {
      if (h) L.setHookStatus(h);
    });
    const offTabs = watchVestTabs((r) => {
      fromTabs = r.token;
      L.setVestTabs({ tabs: r.tabs, hooked: r.hooked, error: r.error });
      // Vest's own ticket orders, copied into the LIVE log so their exact shape can be adopted.
      for (const w of r.writes) {
        const k = `${w.at} ${w.method} ${w.path}`;
        if (w.status === 0 || seenWrites.has(k)) continue;
        seenWrites.add(k);
        L.note(`VEST TICKET ${w.method} ${w.path} ${w.body} ← ${w.status} ${w.resp}`);
      }
      if (r.status) L.setHookStatus(r.status);
      apply();
    });
    return () => {
      offStorage();
      offStatus();
      offTabs();
    };
  }, [L]);
  useEffect(() => {
    L.sizeCap = s.liveSizeCap;
  }, [L, s.liveSizeCap]);
  const [liveBusy, setLiveBusy] = useState(false);
  /** Why the last LIVE press did not go live — shown next to the switch, not only in the log. */
  const [liveWhy, setLiveWhy] = useState('');
  /** Last footprint imbalances, so a lit cell does not blink when its ratio wobbles around 3:1. */
  const imbMemo = useRef<{ key: string; buy: Set<number>; sell: Set<number> }>({ key: '', buy: new Set(), sell: new Set() });
  /** Result of the last LIVE action, shown under the banner: a refusal must never look like nothing. */
  const [liveLast, setLiveLast] = useState<Result | null>(null);
  // Stops fire from the trade feed, not a click: surface their result in the same bar.
  const stopEventAt = L.stopEvent?.at;
  useEffect(() => {
    if (L.stopEvent) setLiveLast({ ok: L.stopEvent.ok, message: L.stopEvent.message });
  }, [L, stopEventAt]);

  // ── price follow, ported from BookDepthIQ's render worker (view.followPrice) ──
  // Following is the normal state and is NOT a saved setting: the ladder centres on the mid on
  // every update. Zooming the price scale never detaches it (BookDepthIQ scales the span and keeps
  // following). Only scrolling the ladder detaches, and that resumes on its own after FOLLOW_IDLE_MS
  // with no further scrolling — or at once with Space / the FOLLOW button. v0.4.1 saved a scroll as
  // "auto-centre off" forever, which is why the ladder never came back.
  const FOLLOW_IDLE_MS = 3000;
  const [follow, setFollow] = useState(true);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeFollow = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
    setFollow(true);
    setCenter(null); // Space / FOLLOW: snap to the market now
  }, []);
  const detachBriefly = useCallback(() => {
    setFollow(false);
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setFollow(true), FOLLOW_IDLE_MS);
  }, []);
  useEffect(() => () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
  }, []);

  const mid = m.mid();
  // Calm follow (v1.6.4): the ladder holds still and re-centres only when price has drifted a sixth
  // of the screen from the middle. While the pointer is over the ladder (placing or dragging an
  // order) it does not move at all unless price gets within 3 rows of the edge.
  const [overLadder, setOverLadder] = useState(false);
  const holdStill = overLadder || drag !== null;
  useEffect(() => {
    if (mid === undefined) return;
    const c = bucketOf(Math.round(mid), g);
    if (center === null) return setCenter(c);
    if (!follow) return;
    const rowsOff = Math.abs(c - center) / g;
    const limit = holdStill ? nRows / 2 - 3 : Math.max(2, Math.floor(nRows / 6));
    if (rowsOff > limit) setCenter(c);
  }, [mid, follow, center, g, holdStill, nRows]);
  // A group change re-snaps the centre onto the new bucket grid.
  useEffect(() => {
    setCenter((c) => (c === null ? c : bucketOf(c, g)));
  }, [g]);

  const actOuter = (r: Result) => {
    if (live) setLiveLast(r);
    const line = `${r.ok ? '✓' : '✗'} ${r.message}`;
    m.note(line);
    // Whenever the side panel is showing the LIVE log, results must land there too.
    if (live || L.log.length > 0) L.note(line);
  };
  const act = actOuter;
  const actAsync = (p: Promise<Result>) => void p.then(act, (e: unknown) => act({ ok: false, message: String(e) }));
  const paperOnly = (what: string) => act({ ok: false, message: `LIVE: ${what} is paper-only for now` });

  /** PAPER → LIVE: Vest login, account, canTrade, then an explicit confirm. No hotkey does this. */
  const toLive = async () => {
    if (liveBusy || live) return;
    setLiveBusy(true);
    setLiveWhy('');
    const act = (r: Result) => {
      if (!r.ok) setLiveWhy(r.message);
      actOuter(r);
    };
    try {
      if (!L.account) {
        const c = await L.connect();
        act(c);
        if (!c.ok) return;
      }
      if (!L.account) return act({ ok: false, message: 'pick the Vest account next to the PAPER | LIVE switch, then press LIVE again' });
      const p = await L.prepare();
      if (!p.ok) return act(p);
      if (!window.confirm(`LIVE: orders go to ${L.account.label}. Continue?`)) return act({ ok: false, message: 'LIVE cancelled at the confirm' });
      setArmed(false);
      L.goLive();
    } finally {
      setLiveBusy(false);
    }
  };
  // FLATTEN, CANCEL ALL: never disabled, never guarded, in either mode.
  const flattenNow = () => {
    const c = m.marketCtx();
    if (live) {
      if (c) actAsync(L.flatten(c.info));
    } else if (broker) act(broker.flatten());
  };
  const cancelNow = () => {
    if (live) actAsync(L.cancelAll(m.info?.symbol));
    else if (broker) act(broker.cancelAll());
  };
  const breakevenNow = () => {
    const c = m.marketCtx();
    if (live) {
      if (c) actAsync(L.breakeven(c, s.beOffset));
    } else if (broker) act(broker.breakeven(s.beOffset));
  };

  const keys = useRef<Record<string, () => void>>({});
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        keys.current.__kill?.();
        return;
      }
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.code === 'Space') {
        e.preventDefault();
        resumeFollow();
        return;
      }
      const fn = keys.current[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    },
    [resumeFollow],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  const tick = m.tick;
  const dec = tickDecimals(tick);
  const px = (t: number | undefined) => (t === undefined ? '—' : formatPrice(t, tick));
  const cme = m.cme();
  const eq = (units: number) =>
    cme ? `≈ ${(units / cme.full).toFixed(3)} ${cme.name}${cme.micro ? ` · ${(units / cme.micro).toFixed(2)} M${cme.name}` : ''}` : '';

  const book = m.book;
  const bid = book ? bestBid(book) : undefined;
  const ask = book ? bestAsk(book) : undefined;
  const bidAt = useMemo(() => (book ? aggregate(book.bids.ticks, book.bids.sizes, g) : new Map<number, number>()), [book, g]);
  const askAt = useMemo(() => (book ? aggregate(book.asks.ticks, book.asks.sizes, g) : new Map<number, number>()), [book, g]);
  const volAt = aggregate([...m.volumeAt.keys()], [...m.volumeAt.values()], g);
  const maxSize = Math.max(1, ...bidAt.values(), ...askAt.values());
  const deltaAt = aggregate([...m.deltaAt.keys()], [...m.deltaAt.values()], g);
  // Session profile on the grouped rows: POC, 70% value area, delta scale.
  const prof = buildProfile(volAt, deltaAt);
  const maxVol = Math.max(1e-9, prof.maxVol);
  const maxDelta = Math.max(1e-9, prof.maxAbsDelta);
  // Footprint (bought at ask / sold at bid per row) with diagonal imbalances, and liquidity walls.
  const boughtG = aggregate([...m.boughtAt.keys()], [...m.boughtAt.values()], g);
  const soldG = aggregate([...m.soldAt.keys()], [...m.soldAt.values()], g);
  const imbKey = `${m.info?.symbol ?? ''}|${g}`;
  const prevImb = imbMemo.current.key === imbKey ? imbMemo.current : undefined;
  const imb = ind.fpOn
    ? imbalances(boughtG, soldG, g, ind.fpRatio, (ind.fpMinPct / 100) * prof.maxVol, ind.fpStack, prevImb)
    : { buy: new Set<number>(), sell: new Set<number>(), buyStack: new Set<number>(), sellStack: new Set<number>() };
  imbMemo.current = { key: imbKey, buy: imb.buy, sell: imb.sell };
  const bidWalls = walls(bidAt);
  const askWalls = walls(askAt);
  const liqBid = bidShare(bidAt.values(), askAt.values());

  // ── sizing ──
  const sizeDec = m.info?.sizeDecimals ?? 4;
  const refPx = mid !== undefined ? mid * tick : undefined;
  const feeRate = Number(m.info?.takerFee ?? 0) || 0;
  const units =
    s.sizeMode === 'units'
      ? s.sizeInput
      : s.sizeMode === 'usd'
        ? refPx
          ? unitsForNotional(s.sizeInput, refPx, sizeDec)
          : 0
        : refPx
          ? unitsForRiskWithFees(s.sizeInput, slEff, tick, refPx, feeRate, sizeDec)
          : 0;
  /** Size for a long or short entered at `ref`: in $ risk sizing it follows that side's stop. */
  const unitsFor = (long: boolean, ref?: number) => (s.sizeMode !== 'risk' ? units : refPx ? unitsForRiskWithFees(s.sizeInput, slFor(long, ref), tick, refPx, feeRate, sizeDec) : 0);
  const lpos = live && m.info ? L.positionFor(m.info.symbol) : undefined;
  const liveOpen = lpos ? liveOpenPnl(lpos, tick, bid, ask) : 0;
  const equity = live ? (L.balance ?? 0) + liveOpen : m.equity();
  const floor = live ? (L.floor() ?? 0) : m.floor();
  const lev = live && m.info ? L.leverageFor(m.info) : s.leverage;
  const ddUsed = Math.max(0, s.startEquity - equity);
  const ddLeft = equity - floor;
  const maxU = refPx ? maxUnits(equity, lev, refPx) : 0;
  const openNotional = live ? Math.abs(lpos?.qty ?? 0) * (refPx ?? 0) : m.notionalUsd();
  const levUsed = leverageUsed(openNotional, equity);
  const margin = marginUsed(openNotional, lev);
  const openPnl = live ? liveOpen : (broker?.unrealizedUsd() ?? 0);
  const equityExOpen = equity - openPnl;

  // In LIVE the ladder shows Vest's own legs as read-only chips; nothing is derived locally.
  const legSide: Side = (lpos?.qty ?? 0) > 0 ? 'sell' : 'buy';
  const liveLegs: WorkingOrder[] = lpos
    ? [
        ...lpos.takeProfits.map((l, i) => ({ id: -1 - i, side: legSide, type: 'limit' as const, priceTicks: Math.round(l.triggerPrice / tick), qty: l.quantity ?? Math.abs(lpos.qty), reduceOnly: true, leg: 'tp' as const })),
        ...lpos.stopLosses.map((l, i) => ({ id: -100 - i, side: legSide, type: 'stop' as const, priceTicks: Math.round(l.triggerPrice / tick), qty: Math.abs(lpos.qty), reduceOnly: true, leg: 'sl' as const })),
      ]
    : [];
  // Vest's resting limit entries on this symbol, as draggable chips. Chip id -1000-i ↔ liveOrderIds[i].
  const liveResting = live && m.info ? L.ordersFor(m.info.symbol).filter((o) => !o.reduceOnly && o.side && o.price !== undefined) : [];
  const liveOrderIds = liveResting.map((o) => o.orderId);
  const liveEntries: WorkingOrder[] = liveResting.map((o, i) => ({
    id: -1000 - i,
    side: o.side!,
    type: 'limit' as const,
    priceTicks: Math.round(o.price! / tick),
    qty: (o.quantity ?? 0) - (o.executedQuantity ?? 0),
    reduceOnly: false,
  }));
  // Panel-held stops on this symbol as dashed STP chips. Chip id -2000-i ↔ liveStopIds[i].
  const liveStops = live && m.info ? L.stops.list(m.info.symbol) : [];
  const liveStopIds = liveStops.map((x) => x.id);
  const liveStopChips: WorkingOrder[] = liveStops.map((x, i) => ({ id: -2000 - i, side: x.side, type: 'stop' as const, priceTicks: x.ticks, qty: x.units, reduceOnly: false }));
  const orders = live ? [...liveEntries, ...liveStopChips, ...liveLegs] : (broker?.orders ?? []);
  const ordersAt = (t: number, side: Side) => [...orders, ...pvChips].filter((o) => bucketOf(o.priceTicks, g) === t && o.side === side);
  const pos = live ? { qty: lpos?.qty ?? 0, avgTicks: lpos ? lpos.openPrice / tick : 0 } : (broker?.position ?? { qty: 0, avgTicks: 0 });
  const avgRow = pos.qty !== 0 ? Math.round(pos.avgTicks) : undefined;

  const place = (side: Side, t: number, stop: boolean) => {
    if (dayBlocked() || feedBlocked()) return;
    const long = side === 'buy';
    const u = unitsFor(long, t);
    const b = brFor(long, t);
    if (confirmBlocked(`${stop ? 'stp' : 'lmt'}:${side}:${t}`, checksFor(u, mid === undefined ? undefined : t - mid))) return;
    lastIntent.current = { side: long ? 'long' : 'short', px: t * tick, kind: stop ? 'stop' : 'limit', at: Date.now() };
    if (live) {
      const c = m.marketCtx();
      // Vest has no stop entry type: the panel holds the stop and fires a MARKET entry (stops.ts).
      if (stop) {
        if (c) act(countEntry(L.armStop(side, t, u, c, b, s.stopConfirm)));
        return;
      }
      if (s.scaleOn) {
        if (c) actAsync(L.enterScale(side, u, t, scaleEnd(side, t), s.scaleCount, s.scaleSkew, s.scaleDir, c).then(countEntry));
        return;
      }
      if (c) actAsync(L.enterLimit(side, u, t, c, b).then(countEntry));
      return;
    }
    if (!broker) return;
    if (!stop && s.scaleOn) {
      const end = scaleEnd(side, t);
      const plan = scaleOrders(u, sizeDec, t, end, s.scaleCount, s.scaleSkew, s.scaleDir);
      if (!plan.ok) return act({ ok: false, message: plan.message });
      // Like Vest's scale: no TP/SL legs.
      const noLegs = { ...paperBr(b), enabled: false };
      act(countEntry(
        m.guarded(side, u, Math.max(t, end) * tick, () => {
          const bad = plan.legs.map((l) => broker.limitOrder(side, l.qty, l.ticks, Date.now(), noLegs)).filter((r) => !r.ok);
          return bad.length ? { ok: false, message: bad.map((r) => r.message).join('; ') } : { ok: true, message: `SCALE ${side.toUpperCase()} ${u} in ${plan.legs.length} limits ${px(t)} → ${px(end)}` };
        }),
      ));
      return;
    }
    const pb = paperBr(b);
    act(countEntry(m.guarded(side, u, t * tick, () => (stop ? broker.stopOrder(side, u, t, Date.now(), pb, s.stopConfirm === 'close') : broker.limitOrder(side, u, t, Date.now(), pb)))));
  };
  /** A scale runs from the clicked price AWAY from the market: down for buys, up for sells. */
  const scaleEnd = (side: Side, t: number) => t + (side === 'buy' ? -1 : 1) * s.scaleSpanTicks;
  const market = (side: Side) => {
    if (dayBlocked() || feedBlocked()) return;
    const long = side === 'buy';
    const u = unitsFor(long);
    const b = brFor(long);
    if (confirmBlocked(`mkt:${side}`, checksFor(u, undefined))) return;
    const exp = long ? ask : bid;
    if (exp !== undefined) lastIntent.current = { side: long ? 'long' : 'short', px: exp * tick, kind: 'market', at: Date.now() };
    if (live) {
      const c = m.marketCtx();
      if (c) actAsync(L.enter(side, u, c, b).then(countEntry));
      return;
    }
    if (!broker) return;
    const p = side === 'buy' ? ask : bid;
    act(countEntry(m.guarded(side, u, p === undefined ? undefined : p * tick, () => broker.marketOrder(side, u, Date.now(), paperBr(b)))));
  };
  const reverse = () => {
    if (live) return paperOnly('REVERSE');
    if (!broker || !pos.qty || dayBlocked()) return;
    const side: Side = pos.qty > 0 ? 'sell' : 'buy';
    const p = side === 'buy' ? ask : bid;
    act(m.guarded(side, Math.abs(pos.qty) * 2, p === undefined ? undefined : p * tick, () => broker.reverse()));
  };

  // ── Protect my day (all off by default): limits on NEW entries only; exits never pass through it ──
  const dayKey = live ? `live:${L.account?.id ?? ''}` : 'paper';
  const today = tradingDay(Date.now());
  const [days, setDays] = useState<Record<string, DayState & { limitClosed?: boolean }>>(() => {
    try {
      return JSON.parse(localStorage.getItem('bdiqvest.day.v1') ?? '{}') as Record<string, DayState>;
    } catch {
      return {};
    }
  });
  const saveDay = (patch: Partial<DayState & { limitClosed?: boolean }>) =>
    setDays((prev) => {
      const cur = prev[dayKey]?.day === today ? prev[dayKey]! : { day: today, startEquity: equity, trades: 0 };
      const next = { ...prev, [dayKey]: { ...cur, ...patch } };
      try {
        localStorage.setItem('bdiqvest.day.v1', JSON.stringify(next));
      } catch {
        /* storage unavailable: the day still counts in this window */
      }
      return next;
    });
  const equityKnown = !live || L.balance !== undefined;
  const dayRec = days[dayKey]?.day === today ? days[dayKey] : undefined;
  useEffect(() => {
    if (!dayRec && equityKnown) saveDay({});
  });
  const daySt: DayState = dayRec ?? { day: today, startEquity: equity, trades: 0 };
  const limits = { lossUsd: s.dayLossUsd, maxTrades: s.maxTradesDay, cooldownSec: s.cooldownSec };
  const limitsOn = limits.lossUsd > 0 || limits.maxTrades > 0 || limits.cooldownSec > 0;
  const nextRisk = s.bracketsOn && slEff > 0 && refPx ? riskWithFees(units, slEff, tick, refPx, feeRate) : undefined;
  const verdict = dayCheck(limits, daySt, equity, Date.now(), nextRisk);
  const dayPnl = equity - daySt.startEquity;
  /** True (and says why) when a NEW entry is not allowed today. */
  const dayBlocked = (): boolean => {
    if (!limitsOn || verdict.ok) return false;
    act({ ok: false, message: verdict.message });
    setNotice(verdict.message);
    return true;
  };
  // ── Fat-finger checks: amber needs a second click on the same order within 4 s; nothing else blocks ──
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(h);
  }, [notice]);
  /** Average size of the last 20 journal trades (needs 5+). */
  const normalUnits = () => {
    const q = journal.slice(-20).map((t) => t.qty);
    return q.length >= 5 ? q.reduce((a, b) => a + b, 0) / q.length : undefined;
  };
  const checksFor = (u: number, distTicks: number | undefined): TradeCheck[] =>
    tradeChecks({
      units: u,
      normalUnits: normalUnits(),
      sizeMult: s.ffSizeMult,
      distTicks,
      farTicks: s.ffFarPts > 0 ? Math.round(s.ffFarPts / tick) : atrT ? Math.round(4 * atrT) : 0,
      gate,
      spreadTicks: spread,
      slTicks: slEff,
      bracketsOn: s.bracketsOn,
      tick,
    });
  const confirmRef = useRef<{ key: string; until: number } | null>(null);
  /** True (and asks for the second click) when this order's checks have a warning. */
  const confirmBlocked = (key: string, ck: TradeCheck[]): boolean => {
    if (!needsConfirm(ck)) {
      confirmRef.current = null;
      return false;
    }
    const c = confirmRef.current;
    if (c && c.key === key && Date.now() < c.until) {
      confirmRef.current = null;
      return false;
    }
    confirmRef.current = { key, until: Date.now() + 4000 };
    const msg = `${ck.filter((x) => x.level !== 'ok').map((x) => x.text).join(' · ')} — click again within 4 s to send`;
    setNotice(msg);
    if (live) setLiveLast({ ok: false, message: msg });
    return true;
  };
  // ── Connection health ──
  const nowH = Date.now();
  const feedAge = m.lastMsgAt === undefined ? undefined : nowH - m.lastMsgAt;
  const health = m.replay ? 'live' : feedHealth(feedAge, m.socketOpen);
  const vestHealth = !L.positionsFresh() ? 'stale' : L.pushOpen ? 'live' : 'slow';
  const ackP = percentiles(L.blotter.ackTimes().slice(0, 20));
  /** Entries are off while the market feed is stale (exits never are). */
  const feedBlocked = (): boolean => {
    if (health !== 'stale') return false;
    const msg = 'market data is stale — entries are off until it is back (FLATTEN, CANCEL and KILL work)';
    setNotice(msg);
    if (live) setLiveLast({ ok: false, message: msg });
    return true;
  };
  /** KILL: every position on every symbol closed at market, every order cancelled. Never blocked. */
  const killNow = () => {
    if (live) {
      actAsync(L.killAll((sym) => m.table?.resolve(sym) ?? undefined));
      return;
    }
    const parts: string[] = [];
    for (const [sym, b] of m.brokers) {
      if (b.position.qty === 0 && b.orders.length === 0) continue;
      parts.push(`${m.table?.resolve(sym)?.displaySymbol ?? sym}: ${b.flatten().message}`);
    }
    act({ ok: true, message: parts.length ? `KILL — ${parts.join(' | ')}` : 'KILL — nothing open' });
  };
  // ── Replay ──
  const [replayOpen, setReplayOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessIdx, setSessIdx] = useState(0);
  const openReplay = () => {
    const next = !replayOpen;
    setReplayOpen(next);
    if (next) void m.sessions().then(setSessions, () => setSessions([]));
  };
  const countEntry = (r: Result) => {
    if (r.ok) saveDay({ trades: daySt.trades + 1 });
    return r;
  };

  // ── Trade journal: every round trip on the market on screen, with its setup, risk and result ──
  const [journal, setJournal] = useState<JournalTrade[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('bdiqvest.journal.v1') ?? '[]') as JournalTrade[];
    } catch {
      return [];
    }
  });
  const saveJournal = (j: JournalTrade[]) => {
    setJournal(j);
    try {
      localStorage.setItem('bdiqvest.journal.v1', JSON.stringify(j.slice(-500)));
    } catch {
      /* storage unavailable: the journal lasts while this window is open */
    }
  };
  const openTrade = useRef<null | {
    open: number;
    sym: string;
    side: 'long' | 'short';
    qty: number;
    entry: number;
    stop?: number;
    riskUsd?: number;
    setup: string;
    mode: 'paper' | 'live' | 'replay';
    stopMode: string;
    realized0: number;
    lastPnl: number;
    lastPx?: number;
    expected?: number;
    feeUsd?: number;
    liquidity?: 'maker' | 'taker';
    ackMs?: number;
  }>(null);
  /** What the last entry click expected (for slippage in the journal). */
  const lastIntent = useRef<{ side: 'long' | 'short'; px: number; kind: 'market' | 'limit' | 'stop'; at: number } | null>(null);
  useEffect(() => {
    const sym = m.info?.displaySymbol ?? m.info?.symbol ?? '';
    const o = openTrade.current;
    const side: 'long' | 'short' = pos.qty > 0 ? 'long' : 'short';
    const closeIt = (cur: NonNullable<typeof o>) => {
      const paperPnl = broker ? broker.realizedUsd - broker.feesUsd - cur.realized0 : 0;
      saveJournal([
        ...journal,
        {
          open: cur.open, close: Date.now(), sym: cur.sym, side: cur.side, qty: cur.qty, entry: cur.entry, exit: cur.lastPx, stop: cur.stop, riskUsd: cur.riskUsd,
          pnl: cur.mode === 'live' ? cur.lastPnl : paperPnl, approx: cur.mode === 'live', setup: cur.setup, mode: cur.mode, stopMode: cur.stopMode,
          expected: cur.expected, slipPts: cur.expected === undefined ? undefined : Math.round((cur.entry - cur.expected) * (cur.side === 'long' ? 1 : -1) * 1e6) / 1e6,
          feeUsd: cur.feeUsd, liquidity: cur.liquidity, ackMs: cur.ackMs,
        },
      ]);
    };
    if (pos.qty !== 0) {
      if (!o || o.sym !== sym || o.side !== side) {
        if (o && o.sym === sym) closeIt(o); // reversed
        const lastFill = broker?.fills.at(-1);
        const lastFee = lastFill?.feeUsd ?? 0;
        const intent = lastIntent.current && lastIntent.current.side === side && Date.now() - lastIntent.current.at < 120_000 ? lastIntent.current : null;
        const entryPx = pos.avgTicks * tick;
        const makerFee = Number(m.info?.makerFee ?? 0) || 0;
        const ackRow = live ? L.blotter.rows.find((r) => r.ackMs !== undefined && (r.kind === 'MARKET' || r.kind === 'LIMIT')) : undefined;
        openTrade.current = {
          open: Date.now(),
          sym,
          side,
          qty: Math.abs(pos.qty),
          entry: entryPx,
          setup: s.setup,
          mode: m.replay ? 'replay' : live ? 'live' : 'paper',
          stopMode: s.stopMode,
          realized0: broker ? broker.realizedUsd - broker.feesUsd + lastFee : 0,
          lastPnl: openPnl,
          expected: intent?.px,
          feeUsd: live ? Math.abs(pos.qty) * entryPx * (intent?.kind === 'limit' ? makerFee : feeRate) : lastFee,
          liquidity: live ? (intent?.kind === 'limit' ? 'maker' : 'taker') : lastFill?.liquidity,
          ackMs: ackRow?.ackMs,
        };
      }
      const cur = openTrade.current!;
      cur.qty = Math.max(cur.qty, Math.abs(pos.qty));
      cur.lastPnl = openPnl;
      const exitPx = pos.qty > 0 ? bid : ask;
      if (exitPx !== undefined) cur.lastPx = exitPx * tick;
      const sl = orders.find((x) => x.leg === 'sl')?.priceTicks;
      if (cur.stop === undefined && sl !== undefined) {
        cur.stop = sl * tick;
        cur.riskUsd = Math.abs(cur.entry - cur.stop) * cur.qty;
      }
    } else if (o) {
      if (o.sym === sym) closeIt(o);
      openTrade.current = null;
    }
  });
  // A losing close starts the cooldown (open P&L just before the position went flat).
  const lastOpen = useRef({ qty: 0, pnl: 0, sym: '' });
  useEffect(() => {
    const prev = lastOpen.current;
    if (prev.qty !== 0 && pos.qty === 0 && prev.sym === (m.info?.symbol ?? '') && prev.pnl < 0) saveDay({ lastLossAt: Date.now() });
    lastOpen.current = { qty: pos.qty, pnl: openPnl, sym: m.info?.symbol ?? '' };
  });
  // Close everything at the daily loss limit (optional; owner OK 2026-10-12). Once per day.
  useEffect(() => {
    if (!s.closeAtDayLimit || !dayRec || dayRec.limitClosed || !dayLimitHit(limits, daySt, equity)) return;
    saveDay({ limitClosed: true });
    if (live) {
      for (const p of L.positions) {
        const info = m.table?.resolve(p.symbol);
        if (info) actAsync(L.flatten(info).then((r) => ({ ...r, message: `daily loss limit: ${r.message}` })));
      }
    } else for (const b of m.brokers.values()) if (b.position.qty !== 0) act({ ...b.flatten(), message: 'daily loss limit: paper position closed' });
  });
  // Close 5 min before Vest's weekend lock (optional; owner OK 2026-10-12). Crypto has no lock.
  useEffect(() => {
    if (!s.weekendClose) return;
    const hours = new Map<number, { at: number; closeAt?: number }>();
    const done = new Set<string>();
    const check = async () => {
      const now = Date.now();
      const held = live ? L.positions.map((p) => p.symbol) : [...m.brokers].filter(([, b]) => b.position.qty !== 0).map(([k]) => k);
      for (const sym of new Set(held)) {
        const info = m.table?.resolve(sym);
        const aid = info?.assetId;
        if (!info || aid === undefined) continue;
        let h = hours.get(aid);
        if (!h || now - h.at > 15 * 60_000) {
          const end = now + 72 * 3600_000;
          h = { at: now, closeAt: weekendCloseAt(await fetchMarketHours(aid, now - 60_000, end), now, end) };
          hours.set(aid, h);
        }
        const key = `${sym}@${h.closeAt}`;
        if (h.closeAt === undefined || now < h.closeAt || done.has(key)) continue;
        done.add(key);
        if (live) actAsync(L.flatten(info).then((r) => ({ ...r, message: `weekend close: ${r.message}` })));
        else {
          const b = m.brokers.get(sym);
          if (b) act({ ...b.flatten(), message: `weekend close: paper ${info.displaySymbol ?? sym} closed` });
        }
      }
    };
    void check().catch(() => {});
    const h = setInterval(() => void check().catch(() => {}), 30_000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.weekendClose, live]);
  useEffect(() => {
    L.stopGuardOn = s.stopGuard;
  }, [L, s.stopGuard]);
  // The trail menu applies to the position you are in now, not only to the next entry.
  const hasLivePos = !!lpos;
  useEffect(() => {
    const c = m.marketCtx();
    if (live && hasLivePos && c) L.setTrail(c, s.trailLine ? 0 : s.trailStartR, s.trailLine || undefined);
  }, [L, m, live, hasLivePos, m.info?.symbol, s.trailStartR, s.trailLine]);

  /** Close half: an exit, never gated. */
  // Dev server only (never in the extension build): lets a test script drive the panel's own
  // actions, e.g. a paper trading session. Gone from production by Vite's dead-code removal.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bdiq = { m, place, market, update, settings: s, live };
  });
  const closeHalfNow = () => {
    const c = m.marketCtx();
    if (live) {
      if (c) actAsync(L.closePart(c.info, 0.5));
    } else if (broker) act(broker.closePart(0.5));
  };

  // ── Preview: the would-be bracket on the ladder while flat. Nothing is sent. ──
  const pvLong = s.preview === 'long';
  const pvRef = s.preview === 'off' ? undefined : pvLong ? ask : bid;
  const pvChips: WorkingOrder[] = [];
  if (pvRef !== undefined && pos.qty === 0 && s.bracketsOn && units > 0) {
    const exit: Side = pvLong ? 'sell' : 'buy';
    const dir = pvLong ? 1 : -1;
    if (slEff > 0) pvChips.push({ id: -3000, side: exit, type: 'stop', priceTicks: pvRef - dir * slEff, qty: units, reduceOnly: true, leg: 'sl' });
    const sp = splitTargets(units, sizeDec, targets);
    if (sp.ok) sp.legs.forEach((l, i) => pvChips.push({ id: -3001 - i, side: exit, type: 'limit', priceTicks: pvRef + dir * l.ticks, qty: l.qty, reduceOnly: true, leg: 'tp' }));
  }
  /** A preview leg dropped on row `t`: the stop sets the stop distance (size follows in $ risk mode,
   * so the risk stays the same); a target sets its distance. */
  const previewDrop = (id: number, t: number) => {
    if (pvRef === undefined) return;
    const dir = pvLong ? 1 : -1;
    const dist = (t - pvRef) * dir;
    if (id === -3000) {
      if (dist >= 0) return act({ ok: false, message: `the stop must be ${pvLong ? 'below' : 'above'} the entry` });
      if (rMode) setSlOverride(-dist);
      else update({ slTicks: -dist });
      return;
    }
    if (dist <= 0) return act({ ok: false, message: `a target must be ${pvLong ? 'above' : 'below'} the entry` });
    const i = -3001 - id;
    if (rMode) {
      const tpR = [...s.tpR];
      tpR[i] = slEff > 0 ? Math.round((dist / slEff) * 10) / 10 : 0;
      update({ tpR });
    } else update(i === 0 ? { tpTicks: dist } : i === 1 ? { tp2Ticks: dist } : { tp3Ticks: dist });
  };

  const rows: number[] = [];
  if (center !== null) for (let i = 0; i < nRows; i++) rows.push(center + (nRows / 2 - i) * g);
  // Heat column: raw sizes per row, scaled against the brightest cell on screen.
  const heatRows = s.showHeat ? new Map(rows.map((t) => [t, m.liq.heat(t, g)])) : undefined;
  let heatMax = 1e-9;
  if (heatRows) for (const h of heatRows.values()) for (const v of h) heatMax = Math.max(heatMax, v);
  const hi = (rows[0] ?? 0) + g - 1;
  const lo = rows[rows.length - 1] ?? 0;

  // ── risk overlays ──
  const failTicksPos =
    pos.qty !== 0
      ? (() => {
          const fp = failPrice(pos.qty, pos.avgTicks * tick, equityExOpen, floor);
          return fp === undefined ? undefined : Math.round(fp / tick);
        })()
      : undefined;
  // P&L per row only while in a position (no hover "what if" preview: it shifted the ladder).
  const pnlAt = (t: number): number | undefined => (pos.qty !== 0 ? rowPnlUsd(pos.qty, pos.avgTicks, t, tick) : undefined);
  const failRow = failTicksPos;
  // v0.8 ladder columns: buy · sold · bid liq · price · ask liq · bought · sell · [P&L] · profile · [Δ]
  const showPnl = pos.qty !== 0;
  const cols = ['0.5fr', '0.62fr', '0.9fr', '1fr', '0.9fr', '0.62fr', '0.5fr', ...(showPnl ? ['0.7fr'] : []), ...(s.showHeat ? ['1fr'] : []), '1.35fr', ...(s.showDelta ? ['0.7fr'] : [])].join(' ');
  const gridStyle = { gridTemplateColumns: cols };
  // Header sparkline of session cumulative delta (last 120 trades).
  const spark = (() => {
    const h = m.cumDeltaHist.slice(-120);
    if (h.length < 2) return '';
    const lo = Math.min(0, ...h);
    const hi = Math.max(0, ...h);
    const span = hi - lo || 1;
    return h.map((v, i) => `${((i / (h.length - 1)) * 110).toFixed(1)},${(20 - ((v - lo) / span) * 18).toFixed(1)}`).join(' ');
  })();
  const toFloorPts = pos.qty ? (equity - floor) / Math.abs(pos.qty) : undefined;
  // Funding: shown only while you hold a position — what this hour's settlement costs or pays you.
  const fundNow = Date.now();
  const fundRate = m.ticker?.oneHrFundingRate !== undefined ? Number(m.ticker.oneHrFundingRate) : undefined;
  const fundIdx = Number(m.ticker?.indexPrice) || undefined;
  const prem5 = m.premium.avgSince(fundNow - 5 * 60_000);
  const fundMinLeft = Math.ceil((nextSettlement(fundNow) - fundNow) / 60_000);
  const fundYou = pos.qty && fundIdx && fundRate !== undefined ? fundingUsdPerHour(pos.qty, fundIdx, fundRate) : undefined;
  const fundWarn = fundYou !== undefined && fundYou > 0 && fundMinLeft <= 5;
  const pct = (r: number) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(4)}%`;
  // Basis limit on NQ/ES/RTY is ±25 bps (BTC/ETH ±50): flag the premium when it nears the band.
  const premBand = m.fundingCls === 'cmeIndex' ? 25 : m.fundingCls === 'crypto' ? 50 : undefined;
  const implied = s.showIndexRef && m.impliedTicks !== undefined ? Math.round(m.impliedTicks) : undefined;
  // Dual SuperTrend (BookDepthIQ engine): levels in ticks, drawn as lines across their ladder rows.
  const tr = m.trendSnap;
  const st1 = s.showTrend && tr.t1.lineTicks !== undefined && tr.t1.dir !== 'neutral' ? { ticks: tr.t1.lineTicks, dir: tr.t1.dir } : undefined;
  const st2 = s.showTrend && tr.t2.lineTicks !== undefined && tr.t2.dir !== 'neutral' ? { ticks: tr.t2.lineTicks, dir: tr.t2.dir } : undefined;
  const stRef = m.lastTradeTicks ?? mid;
  const stDist = (st: typeof st1) => (st && stRef !== undefined ? (stRef - st.ticks) * tick : undefined);
  const TREND_LABEL = { strongLong: '▲▲ STRONG LONG', weakLong: '▲ WEAK LONG', chop: '◆ CHOP', weakShort: '▼ WEAK SHORT', strongShort: '▼▼ STRONG SHORT' } as const;
  const flipFresh = m.lastFlip !== null && Date.now() - m.lastFlip.at < 5000;
  // CHOP vs TREND, and EXTENDED (don't chase). See structure.ts.
  const mstate = marketState({
    st1: tr.t1.dir,
    st2: tr.t2.dir,
    flips15: m.flips.filter((t) => t > Date.now() - 15 * 60_000).length,
    price: m.lastTradeTicks,
    vwap: m.vwap.value(),
    vwapSigma: m.vwap.sigma(),
    st1Line: tr.t1.lineTicks,
    atrTicks: atrT,
  });
  // Level lines drawn across ladder rows (like the ST lines): VWAP + σ bands, stacked-imbalance
  // zones, big prints. Keyed by row; each row can carry several.
  const vwapT = ind.vwapOn ? m.vwap.value() : undefined;
  const vwapSd = ind.vwapOn ? m.vwap.sigma() : undefined;
  const levelLines = new Map<number, Array<{ cls: string; label: string }>>();
  const addLine = (ticks: number, cls: string, label: string) => {
    const r = bk(Math.round(ticks))!;
    const arr = levelLines.get(r) ?? [];
    arr.push({ cls, label });
    levelLines.set(r, arr);
  };
  if (vwapT !== undefined) {
    addLine(vwapT, 'vwap', 'VWAP');
    for (const b of m.vwap.bands(ind.vwapBands)) {
      addLine(b.hi, 'vwapband', `+${b.k}σ`);
      addLine(b.lo, 'vwapband', `−${b.k}σ`);
    }
  }
  // RTH opening range (BookDepthIQ PAXOR): OR H/L solid, MID and EXT rungs dashed; dashed while forming.
  const orLevels = m.or?.levels() ?? [];
  const orForming = !!m.or && m.or.forming(Date.now());
  for (const l of orLevels) {
    const cls = l.kind === 'high' ? 'or-h' : l.kind === 'low' ? 'or-l' : l.kind === 'mid' ? 'or-mid' : l.kind === 'upper' ? 'or-ext-up' : 'or-ext-dn';
    addLine(l.ticks, `${cls}${orForming ? ' forming' : ''}`, orForming && (l.kind === 'high' || l.kind === 'low') ? `${orLabel(l)} forming` : orLabel(l));
  }
  if (ind.fpOn && ind.fpLines) for (const z of stackZones(imb.buyStack, imb.sellStack, g)) addLine(z.ticks, z.side === 'buy' ? 'zone-buy' : 'zone-sell', `STACK ${z.side === 'buy' ? '▲' : '▼'}${z.rows}`);
  // The bracket drawn across the ladder like chart lines: stop, entry, targets, where the trail
  // starts, each with its $. In a trade: the real legs. Flat with PREVIEW on: the would-be ones.
  const brLines: Array<{ ticks: number; cls: string; label: string }> = [];
  if (pos.qty !== 0) {
    const dir = pos.qty > 0 ? 1 : -1;
    const q = Math.abs(pos.qty);
    brLines.push({ ticks: Math.round(pos.avgTicks), cls: 'br-in', label: `IN ${formatPrice(Math.round(pos.avgTicks), tick)}` });
    for (const o of orders.filter((x) => x.leg)) {
      const usd = (o.priceTicks - pos.avgTicks) * dir * Math.min(o.qty, q) * tick;
      brLines.push({ ticks: o.priceTicks, cls: o.leg === 'sl' ? 'br-sl' : 'br-tp', label: `${o.leg === 'sl' ? 'SL' : 'TP'} ${fmtUsd(usd)}` });
    }
    const stl = s.trailLine === 1 ? st1 : s.trailLine === 2 ? st2 : undefined;
    if (stl && stl.dir === (dir > 0 ? 'up' : 'down')) brLines.push({ ticks: stl.ticks, cls: 'br-trail', label: `TRAIL on ST${s.trailLine}` });
    else if (!s.trailLine && s.trailStartR > 0 && slEff > 0) brLines.push({ ticks: Math.round(pos.avgTicks + dir * s.trailStartR * slEff), cls: 'br-trail', label: `TRAIL starts here (${s.trailStartR}R)` });
  } else if (pvRef !== undefined && pvChips.length) {
    const dir = pvLong ? 1 : -1;
    brLines.push({ ticks: pvRef, cls: 'br-in pv', label: `PREVIEW ${pvLong ? 'LONG' : 'SHORT'} ${units}u` });
    for (const o of pvChips)
      brLines.push({
        ticks: o.priceTicks,
        cls: `${o.leg === 'sl' ? 'br-sl' : 'br-tp'} pv`,
        label: o.leg === 'sl' ? `SL −$${(refPx ? riskWithFees(units, slEff, tick, refPx, feeRate) : 0).toFixed(2)}${atrMode ? ` (${s.atrMult}× ATR)` : ''}` : `TP +$${(o.qty * Math.abs(o.priceTicks - pvRef) * tick).toFixed(2)}`,
      });
    if (!s.trailLine && s.trailStartR > 0 && slEff > 0) brLines.push({ ticks: pvRef + dir * Math.round(s.trailStartR * slEff), cls: 'br-trail pv', label: `TRAIL starts (${s.trailStartR}R)` });
  }
  for (const l of brLines) addLine(l.ticks, l.cls, l.label);
  // In CHOP, the edges to trade: the last 30 minutes' high and low.
  if (mstate.state === 'chop') {
    const rg = m.bars.range(30, Date.now());
    if (rg && rg.hi > rg.lo) {
      addLine(rg.hi, 'rng', 'RANGE H 30m — fade');
      addLine(rg.lo, 'rng', 'RANGE L 30m — fade');
    }
  }
  const fitSpan = brLines.length && mid !== undefined ? Math.max(...brLines.map((l) => Math.abs(l.ticks - mid))) : 0;
  useEffect(() => {
    const half = nRows / 2 - 2;
    let need = 1;
    while (need < 100 && fitSpan / need > half) need = stepGroup(need, 1);
    // A little slack before zooming back in, so the rows don't flicker at the edge.
    setFitG((prev) => (need < prev && fitSpan / need > half * 0.8 ? prev : need));
  }, [fitSpan, nRows]);
  const markers = [
    ...orders.map((o) => ({ label: o.leg ? o.leg.toUpperCase() : o.type === 'stop' ? 'STP' : 'LMT', ticks: o.priceTicks })),
    ...pvChips.map((o) => ({ label: `${o.leg === 'sl' ? 'SL' : 'TP'} ◇ preview`, ticks: o.priceTicks })),
    ...(failRow !== undefined ? [{ label: 'FAIL', ticks: failRow }] : []),
    ...(() => {
      // In CHOP the range edges pin like other levels when they are off-screen.
      const rg = mstate.state === 'chop' ? m.bars.range(30, Date.now()) : undefined;
      return rg && rg.hi > rg.lo ? [{ label: 'RANGE H', ticks: rg.hi }, { label: 'RANGE L', ticks: rg.lo }] : [];
    })(),
    ...(st1 ? [{ label: `ST1 ${st1.dir === 'up' ? 'support' : 'resistance'}`, ticks: st1.ticks }] : []),
    ...(vwapT !== undefined ? [{ label: 'VWAP', ticks: Math.round(vwapT) }] : []),
    ...orLevels.filter((l) => l.kind === 'high' || l.kind === 'low').map((l) => ({ label: orLabel(l), ticks: l.ticks })),
    // Nearest off-screen EXT rung on each side, so the 65/15-pt spacing from OR H/L is always readable.
    ...(() => {
      const above = orLevels.filter((l) => (l.kind === 'upper' || l.kind === 'lower') && l.ticks > hi).sort((x, y) => x.ticks - y.ticks)[0];
      const below = orLevels.filter((l) => (l.kind === 'upper' || l.kind === 'lower') && l.ticks < lo).sort((x, y) => y.ticks - x.ticks)[0];
      return [above, below].filter((l): l is NonNullable<typeof l> => !!l).map((l) => ({ label: orLabel(l), ticks: l.ticks }));
    })(),
    ...(st2 ? [{ label: `ST2 ${st2.dir === 'up' ? 'support' : 'resistance'}`, ticks: st2.ticks }] : []),
  ];
  const pinned = center === null ? [] : offscreen(markers, lo, hi);
  const pinRow = (p: (typeof pinned)[number]) => {
    const pnl = pnlAt(p.ticks);
    return (
      <div
        key={`${p.label}${p.ticks}`}
        className={`pin ${p.label.startsWith('FAIL') ? 'fail' : p.label.startsWith('TP') ? 'tp' : p.label.startsWith('SL') ? 'sl' : p.label.startsWith('ST') ? (p.label.endsWith('support') ? 'st-up' : 'st-down') : p.label === 'VWAP' ? 'vwap' : p.label === 'OR H' ? 'or-h' : p.label === 'OR L' ? 'or-l' : p.label.startsWith('OR EXT') ? (p.above ? 'or-h' : 'or-l') : ''}`}
        onClick={() => {
          detachBriefly();
          setCenter(bucketOf(p.ticks, g));
        }}
      >
        {p.above ? '▲' : '▼'}
        {p.label.replace(' resistance', '').replace(' support', '')} {formatPrice(p.ticks, tick)} <i>{(p.distance * tick).toFixed(dec)}</i>
        {pnl !== undefined ? ` ${fmtUsd(pnl)}` : ''}
      </div>
    );
  };

  const orderChip = (o: WorkingOrder) => (
    <span
      key={o.id}
      className={`chip ${o.leg ?? o.type} ${o.side} ${o.id <= -3000 ? 'preview' : live && o.id <= -2000 ? 'heldstop' : ''}`}
      title={o.id <= -3000 ? `PREVIEW ${o.leg === 'sl' ? 'stop' : 'target'} — nothing is sent. Drag it to change the distance${o.leg === 'sl' ? ' (in $ risk sizing the size follows, so the risk stays the same)' : ''}.` : `${o.leg ? o.leg.toUpperCase() + ' ' : ''}${o.side} ${o.type} ${o.qty} — ${live ? (o.id <= -2000 ? 'panel-held STOP (Vest does not see it until it fires a market order): click to cancel, drag to move' : o.leg ? 'on Vest: drag to move' : 'on Vest: click to cancel, drag to move') : 'click to cancel, drag to move'}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        setDrag({ id: o.id, from: o.priceTicks });
      }}
      // The row's pointer-up decides cancel (same row) vs move (other row); a chip click must never
      // reach the row underneath, which would place a new order.
      onClick={(e) => e.stopPropagation()}
    >
      {o.id <= -3000 ? '◇' : ''}
      {o.leg ? o.leg.toUpperCase() : o.type === 'stop' ? 'STP' : 'LMT'} {o.id <= -3000 && refPx ? (o.leg === 'sl' ? `−$${riskWithFees(units, slEff, tick, refPx, feeRate).toFixed(2)}` : `+$${(o.qty * Math.abs(o.priceTicks - (pvRef ?? o.priceTicks)) * tick).toFixed(2)}`) : o.qty}
      {live && o.id <= -1000 && o.id > -2000 && (() => {
        const st = L.blotter.forOrder(liveOrderIds[-1000 - o.id] ?? '')?.status;
        return <i className="cst">{` · ${st ?? 'WORKING'}`}</i>;
      })()}
    </span>
  );

  const symbols = useMemo(
    () => (m.table ? m.table.all().filter((i) => i.tradingStatus === 'TRADING') : []),
    [m.table],
  );

  const exposure = m.backgroundExposure();
  const unreal = openPnl;
  // Vest positions not shown on the ladder: other symbols in LIVE, all of them in PAPER.
  const vestElsewhere = L.positions.filter((p) => !live || p.symbol !== m.info?.symbol);
  const spread = m.spread();
  const basis = m.basisBps();
  const wide = spread !== undefined && m.spreadWin.isWide(spread);
  const p90 = m.spreadWin.quantile(0.9);
  // v0.9 cost panel: real fill for this size from the live book, all-in break-even, spread gate.
  const takerFee = Number(m.info?.takerFee ?? 0) || 0;
  const rtBuy = book && units > 0 ? roundTrip(book.bids, book.asks, 'buy', units, tick, takerFee) : undefined;
  const rtSell = book && units > 0 ? roundTrip(book.bids, book.asks, 'sell', units, tick, takerFee) : undefined;
  const breakEven = rtBuy && rtSell ? Math.max(rtBuy.breakEvenPts, rtSell.breakEvenPts) : (rtBuy ?? rtSell)?.breakEvenPts;
  const gate = spread !== undefined ? spreadGate(spread, m.spreadWin.quantile(0.5), p90) : undefined;
  const tpPts = s.bracketsOn ? tpEff[0]! * tick : 0;
  const edge = edgeRatio(tpPts, breakEven);
  const fillTxt = (r: typeof rtBuy) => (r ? (r.entry.avgTicks * tick).toFixed(dec) : '—');

  keys.current = {
    __kill: killNow,
    f: flattenNow,
    escape: cancelNow,
    ...(armed
      ? {
          b: () => market('buy'),
          s: () => market('sell'),
          r: reverse,
          e: breakevenNow,
        }
      : {}),
  };

  return (
    <div className={`app ${drag ? 'dragging' : ''}`} onPointerUp={() => setTimeout(() => setDrag(null), 0)}>
      {live ? (
        <>
          <div className="live-banner">LIVE — {L.account?.label} — real orders</div>
          {liveLast && (
            <div className={liveLast.ok ? 'live-result ok' : 'live-result neg'} onClick={() => setLiveLast(null)} title="click to dismiss">
              {liveLast.ok ? '✓' : '✗'} {liveLast.message}
            </div>
          )}
        </>
      ) : (
        <div className="paper-banner">
          {m.replay
            ? `REPLAY — recorded ${m.table?.resolve(m.replay.session.symbol)?.displaySymbol ?? m.replay.session.symbol} ${new Date(m.replay.session.from).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · PAPER only, nothing is sent to Vest.`
            : 'LOCAL PAPER — orders fill in this window only. Nothing is sent to Vest.'}
        </div>
      )}

      <header className="bar">
        <select
          value={m.info?.symbol ?? ''}
          onChange={(e) => {
            if (m.select(e.target.value)) {
              setCenter(null);
              update({ symbol: e.target.value });
            }
          }}
        >
          {symbols.map((i) => (
            <option key={i.symbol} value={i.symbol}>
              {i.displaySymbol ?? i.symbol}
            </option>
          ))}
        </select>
        <span className="mode" title={L.tokenOk() ? 'Vest login captured' : `LIVE unavailable — ${L.loginProblem()}`}>
          <button className={live ? '' : 'on'} onClick={() => L.goPaper()}>
            PAPER
          </button>
          <button className={live ? 'on live' : ''} disabled={liveBusy || !!m.replay} title={m.replay ? 'LIVE is off during a replay' : undefined} onClick={() => void toLive()}>
            {liveBusy ? 'LIVE…' : 'LIVE'}
          </button>
        </span>
        {live && L.stops.size > 0 && (
          <span className="stopsbadge" title="panel-held stops: they fire a MARKET entry when a trade prints at or through them, only while this window is open and LIVE">
            ⚡ {L.stops.size} stop{L.stops.size > 1 ? 's' : ''} armed
          </span>
        )}
        {s.showTrend && mstate.state !== 'warming' && (
          <span className={`statebadge ${mstate.state} ${mstate.extended ? 'ext' : ''}`} title={mstate.why}>
            {mstate.state === 'chop' ? 'CHOP — fade the edges' : mstate.state === 'trend-up' ? 'TREND ▲' : 'TREND ▼'}
            {mstate.extended ? ` · EXTENDED ${mstate.extended === 'up' ? '↑' : '↓'} don't chase` : ''}
          </span>
        )}
        {limitsOn && (
          <span className={`daychip ${verdict.ok ? '' : 'locked'}`} title={verdict.ok ? 'Protect my day (settings)' : verdict.message}>
            day <b className={pnlClass(dayPnl)}>{fmtUsd(dayPnl)}</b>
            {limits.lossUsd > 0 ? ` / −$${limits.lossUsd}` : ''}
            {limits.maxTrades > 0 ? ` · ${daySt.trades}/${limits.maxTrades} trades` : ''}
            {verdict.ok ? '' : ' · LOCKED'}
          </span>
        )}
        {s.showTrend && (
          <span
            className={`trendbadge ${tr.t1.lineTicks === undefined ? 'warm' : tr.state} ${flipFresh ? 'flip' : ''}`}
            title={`Dual SuperTrend (BookDepthIQ): ST1 60s×10 ×3.6, ST2 15s×10 ×3.0, flip on price + delta.${m.lastFlip ? ` Last flip: ST${m.lastFlip.line} ${m.lastFlip.dir === 'up' ? '▲' : '▼'} ${Math.round((Date.now() - m.lastFlip.at) / 1000)} s ago.` : ''}`}
          >
            {m.trendLoading ? 'SuperTrend loading 45 min…' : tr.t1.lineTicks === undefined ? 'SuperTrend warming up…' : `${TREND_LABEL[tr.state]} ${tr.confidence > 0 ? '+' : ''}${tr.confidence}`}
          </span>
        )}
        {!live && !L.tokenOk() && (
          <span className="neg" title="LIVE needs the Vest login from an open next.vestmarkets.com tab">
            no Vest login — {L.loginProblem()}
          </span>
        )}
        {!live && L.tokenOk() && liveWhy && <span className="neg">LIVE refused: {liveWhy}</span>}
        {!live && L.accounts.length > 1 && (
          <select value={L.account?.id ?? ''} onChange={(e) => L.selectAccount(e.target.value)} title="Vest account for LIVE">
            <option value="">Vest account…</option>
            {L.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <span className={`hpill ${health}`} title="market feed: how long since the last message from Vest. Over 2 s amber, over 6 s STALE: entries off until it is back.">
          {health === 'live' ? '●' : health === 'slow' ? '◐' : '○'} FEED {m.replay ? 'REPLAY' : feedAge === undefined ? '—' : health === 'live' ? `${feedAge} ms` : `${(feedAge / 1000).toFixed(1)} s`}
        </span>
        {live && (
          <span className={`hpill ${vestHealth}`} title="Vest account link: push connected (⚡), polling, or positions not read recently. ACK = Vest's median / 95th-percentile answer time for your last orders.">
            {vestHealth === 'live' ? `⚡ VEST${ackP ? ` ACK ${ackP.p50} ms` : ''}` : vestHealth === 'slow' ? '◐ VEST POLLING' : '○ VEST STALE'}
          </span>
        )}
        <button className={`mini ${replayOpen || m.replay ? 'on' : ''}`} onClick={openReplay} title="replay a recorded session (PAPER only)">
          Replay {m.replay ? '●' : '○'}
        </button>
        <button className="kill" onClick={killNow} title="KILL (Ctrl+K): close every position on every symbol at market and cancel every order. Never blocked." aria-label="Kill switch: close everything">
          KILL ⏻
        </button>
        <span className={`status ${m.status}`} title={m.statusDetail}>
          ● {m.status}
        </span>
        <span className="kv">
          last <b>{px(m.lastTradeTicks)}</b>
        </span>
        <span className="kv">
          mark <b>{m.ticker ? Number(m.ticker.markPrice).toFixed(dec) : '—'}</b>
        </span>
        <span className="kv">
          index <b>{m.ticker ? Number(m.ticker.indexPrice).toFixed(dec) : '—'}</b>
        </span>
        <span className="kv">
          basis <b>{basis === undefined ? '—' : `${basis.toFixed(1)} bps`}</b>
        </span>
        <span
          className={`kv ${prem5 !== undefined && premBand !== undefined && Math.abs(prem5 * 1e4) >= 0.8 * premBand ? 'wide' : ''}`}
          title={`premium over the last 5 min, Vest's way: impact prices for a $${m.info?.initMarginRatio ? Math.round(100 / Number(m.info.initMarginRatio)).toLocaleString() : '—'} order vs the index. Positive = Vest rich (longs crowded).${premBand ? ` Trades are blocked beyond ±${premBand} bps; near the band, price tends to snap back.` : ''}`}
        >
          prem 5m <b>{prem5 === undefined ? '—' : `${(prem5 * 1e4).toFixed(1)} bps`}</b>
        </span>
        <span className={`kv ${wide ? 'wide' : ''}`} title={p90 === undefined ? 'collecting spread history…' : `this market's p90 spread over the last 5 min: ${(p90 * tick).toFixed(dec)} pts`}>
          spread <b>{spread === undefined ? '—' : (spread * tick).toFixed(dec)}</b>
          {wide ? ' WIDE' : ''}
        </span>
        <span
          className={`badge ${m.ladder > 0.8 ? 'warn' : ''}`}
          title="Share of resting sizes that are whole multiples of one unit. Near 1 = one market maker's quote ladder, not organic order flow."
        >
          {m.ladder > 0.8 ? 'QUOTED BOOK' : 'book'} {(m.ladder * 100).toFixed(0)}%
        </span>
      </header>
      {(replayOpen || m.replay) && (
        <div className="replaybar">
          <b className="rtag">REPLAY</b>
          {!m.replay ? (
            <>
              <label htmlFor="rp-sess">Session</label>
              <select id="rp-sess" value={sessIdx} onChange={(e) => setSessIdx(Number(e.target.value))}>
                {sessions.map((x, i) => (
                  <option key={`${x.symbol}${x.from}`} value={i}>
                    {m.table?.resolve(x.symbol)?.displaySymbol ?? x.symbol} · {new Date(x.from).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}–{new Date(x.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {x.minutes} min
                  </option>
                ))}
              </select>
              <button
                className="mini"
                disabled={!sessions[sessIdx]}
                onClick={() => {
                  const sx = sessions[sessIdx];
                  if (sx && m.startReplay(sx)) setCenter(null);
                }}
              >
                ▶ start
              </button>
              {sessions.length === 0 && <span className="muted">no recordings yet — the panel records the market on screen while it is open (kept 7 days, in this browser)</span>}
            </>
          ) : (
            (() => {
              const r = m.replay;
              const p = r.player;
              const seek = (ms: number) => void p.seek(ms).then(() => setCenter(null));
              const span = Math.max(1, r.session.to - r.session.from);
              const rb = broker;
              const rPnl = rb ? rb.realizedUsd - rb.feesUsd + rb.unrealizedUsd() : 0;
              return (
                <>
                  <button className="mini" onClick={() => seek(p.nowMs - 60_000)} aria-label="back one minute">
                    « 1m
                  </button>
                  <button className="mini on" onClick={() => (p.playing ? p.pause() : p.play(), m.changed())} aria-label={p.playing ? 'pause' : 'play'}>
                    {p.playing ? '❚❚' : '▶'}
                  </button>
                  <button className="mini" onClick={() => seek(p.nowMs + 60_000)} aria-label="forward one minute">
                    1m »
                  </button>
                  {[1, 2, 5, 10].map((x) => (
                    <button
                      key={x}
                      className={`mini ${p.speed === x ? 'on' : ''}`}
                      onClick={() => {
                        p.speed = x;
                        m.changed();
                      }}
                    >
                      {x}×
                    </button>
                  ))}
                  <span className="rclock">{new Date(p.nowMs).toLocaleTimeString([], { hour12: false })}</span>
                  <span className="rtrack">
                    {journal
                      .filter((t) => t.mode === 'replay' && t.open >= r.session.from && t.open <= r.session.to)
                      .map((t) => (
                        <i key={t.open} className={t.pnl > 0 ? 'win' : 'loss'} style={{ left: `${(((t.open - r.session.from) / span) * 100).toFixed(2)}%` }} title={`${t.side} ${t.setup || ''} ${fmtUsd(t.pnl)}`} />
                      ))}
                    <input id="rp-pos" type="range" min={r.session.from} max={r.session.to} step={1000} value={p.nowMs} onChange={(e) => seek(Number(e.target.value))} aria-label="replay position" />
                  </span>
                  <span>
                    replay P&amp;L <b className={pnlClass(rPnl)}>{fmtUsd(rPnl)}</b>
                  </span>
                  <button
                    className="mini"
                    onClick={() => {
                      m.stopReplay();
                      setReplayOpen(false);
                      setCenter(null);
                    }}
                  >
                    exit replay
                  </button>
                </>
              );
            })()
          )}
        </div>
      )}

      {live && (
        <section className="account live">
          <div className="acct-nums">
            <span title="GET /v3/accounts amount">
              Balance <b>{L.balance === undefined ? '—' : `$${L.balance.toFixed(2)}`}</b>
            </span>
            <span title="max_drawdown_limit from /v3/capital/accounts/active — the account fails below it">
              Floor <b>{L.floor() === undefined ? '—' : `$${L.floor()!.toFixed(2)}`}</b> · room <b>${Math.max(0, equity - floor).toFixed(2)}</b>
            </span>
            <span title="saved per account/symbol, else floor(1 / initMarginRatio), capped at the account max">
              Leverage <b>{lev}x</b>
              {L.account?.maxLeverage !== undefined ? ` (max ${L.account.maxLeverage}x)` : ''}
            </span>
            <span>
              Power <b>{fmtK(equity * lev)}</b> · Max <b>{maxU.toFixed(sizeDec)}u</b>
            </span>
            <span title="LIVE hard size cap (settings)">
              Cap <b>{s.liveSizeCap > 0 ? `${s.liveSizeCap}u` : 'off'}</b>
            </span>
            <span className={L.positionsFresh() ? '' : 'neg'} title={L.pollError || (L.pushOpen ? 'Vest pushes account changes; positions + orders re-read instantly (5 s safety net)' : 'positions + orders every 1.5 s, balance every 10 s')}>
              {L.positionsFresh() ? (L.pushOpen ? 'Vest ⚡ live' : 'Vest synced (polling)') : `Vest STALE${L.pollError ? `: ${L.pollError.slice(0, 60)}` : ''}`}
            </span>
            {L.api.rateRemaining !== null && <span title="x-ratelimit-remaining">rate {L.api.rateRemaining}</span>}
            {!L.tokenOk() && (
              <span className="neg" title="Entries need a fresh login. FLATTEN / CANCEL keep working while the ~15 min account token lasts.">
                Vest login expired — reload the Vest tab
              </span>
            )}
          </div>
          {(() => {
            // Room to the fail floor, live: full bar = the account's whole drawdown allowance.
            const room = Math.max(0, equity - floor);
            const full = Math.max(room, (L.account?.initialCapital ?? 0) - floor);
            if (!(full > 0) || L.floor() === undefined) return null;
            const f = room / full;
            return (
              <div className="roombar" title={`$${room.toFixed(2)} of $${full.toFixed(2)} left before the account fails (open P&L on this market included)`}>
                <i className={f < 0.25 ? 'low' : f < 0.5 ? 'mid' : ''} style={{ width: `${(f * 100).toFixed(1)}%` }} />
                <span>room to floor ${room.toFixed(2)} · {(f * 100).toFixed(0)}%</span>
              </div>
            );
          })()}
        </section>
      )}

      <section className={`account ${m.failed ? 'failed' : ''} ${live ? 'paper-hidden' : ''}`}>
        <div className="acct-nums">
          <span>
            Account <b>${equity.toFixed(2)}</b>
          </span>
          <span className={ddLeft < s.maxDrawdownUsd * 0.3 ? 'neg' : ''}>
            Drawdown <b>${ddUsed.toFixed(2)}</b> / ${s.maxDrawdownUsd.toFixed(2)} · left <b>${Math.max(0, ddLeft).toFixed(2)}</b>
          </span>
          <span className={levUsed > s.leverage * 0.8 ? 'neg' : ''} title="open notional ÷ account value (Vest's header 'Leverage'). Margin = notional ÷ order leverage.">
            Leverage <b>{levUsed.toFixed(1)}x</b> / {s.leverage}x · margin <b>${margin.toFixed(2)}</b>
          </span>
          <span>
            Power <b>{fmtK(equity * s.leverage)}</b> · free <b>{fmtK(Math.max(0, equity * s.leverage - openNotional))}</b>
          </span>
          <span>
            Max <b>{maxU.toFixed(sizeDec)}u</b> <small>{eq(maxU)}</small>
          </span>
          {m.failed && (
            <button className="mini danger" onClick={() => m.resetPaper()}>
              FAILED — reset paper
            </button>
          )}
        </div>
        <div className="ddbar">
          <i style={{ width: `${Math.min(100, (ddUsed / Math.max(1e-9, s.maxDrawdownUsd)) * 100)}%` }} />
        </div>
        <details>
          <summary>settings</summary>
          <button className="mini" onClick={() => update({ ladderUsd: !s.ladderUsd })}>
            sizes {s.ladderUsd ? 'USD' : 'units'}
          </button>
          <button className="mini" title="index-implied mid — lags Vest by ~600 ms, reference only" onClick={() => update({ showIndexRef: !s.showIndexRef })}>
            ◆ idx {s.showIndexRef ? 'on' : 'off'}
          </button>
          <br />
          <label>
            start value $<input type="number" step={0.01} value={s.startEquity} onChange={(e) => update({ startEquity: Number(e.target.value) || 0 })} />
          </label>
          <label>
            max drawdown $<input type="number" step={0.01} value={s.maxDrawdownUsd} onChange={(e) => update({ maxDrawdownUsd: Number(e.target.value) || 0 })} />
          </label>
          <label>
            leverage x<input type="number" min={1} value={s.leverage} onChange={(e) => update({ leverage: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <small>(paper only)</small>
          <br />
          <label title="Optional largest size a LIVE entry may send. 0 = off: trading power is the limit, as on Vest's own ticket.">
            LIVE size cap u (0 = off)
            <input type="number" min={0} step={0.001} value={s.liveSizeCap} onChange={(e) => update({ liveSizeCap: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label title="fat-finger: a limit or stop this far from the market asks for a second click (0 = 4 × ATR)">
            far from market pts
            <input type="number" min={0} step={1} value={s.ffFarPts} onChange={(e) => update({ ffFarPts: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label title="fat-finger: a size this many × your normal (last 20 trades) asks for a second click">
            size × normal
            <input type="number" min={1} step={0.5} value={s.ffSizeMult} onChange={(e) => update({ ffSizeMult: Math.max(1, Number(e.target.value) || 2) })} />
          </label>
          <label title="the one-click $ risk buttons next to the size box">
            risk buttons $
            <input type="text" className="wide" defaultValue={s.riskPresets.join(', ')} onBlur={(e) => update({ riskPresets: e.target.value.split(/[\s,]+/).map(Number).filter((x) => x > 0).slice(0, 6) })} />
          </label>
          <fieldset className="protect">
            <legend>Protect my day (0 = off) — new entries only; FLATTEN and CANCEL are never locked</legend>
            <label title="lock new entries once the day (from 17:00 Chicago) is down this much">
              daily loss $
              <input type="number" min={0} step={1} value={s.dayLossUsd} onChange={(e) => update({ dayLossUsd: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label title="when the daily loss limit is hit, close every open position at market (the panel acts without a click)">
              <input type="checkbox" checked={s.closeAtDayLimit} disabled={!s.dayLossUsd} onChange={(e) => update({ closeAtDayLimit: e.target.checked })} /> also close open trades
            </label>
            <label>
              max trades / day
              <select value={s.maxTradesDay} onChange={(e) => update({ maxTradesDay: Number(e.target.value) })}>
                {[0, 3, 5, 10].map((v) => (
                  <option key={v} value={v}>
                    {v || 'off'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              cooldown after a loss
              <select value={s.cooldownSec} onChange={(e) => update({ cooldownSec: Number(e.target.value) })}>
                <option value={0}>off</option>
                <option value={30}>30 s</option>
                <option value={60}>1 min</option>
                <option value={300}>5 min</option>
              </select>
            </label>
            <label title="close a position 5 min before Vest's weekend lock (crypto has none); the panel acts without a click, and only while this window is open">
              <input type="checkbox" checked={s.weekendClose} onChange={(e) => update({ weekendClose: e.target.checked })} /> close before the weekend lock
            </label>
          </fieldset>
          <details className="indset">
            <summary>Indicators — {m.info?.displaySymbol ?? m.info?.symbol ?? ''} (saved per instrument)</summary>
            <fieldset>
              <legend>
                <label><input type="checkbox" checked={ind.vwapOn} onChange={(e) => setInd({ vwapOn: e.target.checked })} /> VWAP</label>
              </legend>
              <label title="session start, HH:MM in the time zone below">start <input type="text" size={5} defaultValue={ind.vwapStart} key={`vs${m.info?.symbol}`} onBlur={(e) => setInd({ vwapStart: e.target.value.trim() })} /></label>
              <label title="session end, HH:MM (earlier than start = crosses midnight)">end <input type="text" size={5} defaultValue={ind.vwapEnd} key={`ve${m.info?.symbol}`} onBlur={(e) => setInd({ vwapEnd: e.target.value.trim() })} /></label>
              <label>
                zone
                <select value={ind.vwapTz} onChange={(e) => setInd({ vwapTz: e.target.value })}>
                  <option value="America/New_York">New York</option>
                  <option value="America/Chicago">Chicago</option>
                  <option value="Europe/London">London</option>
                  <option value="UTC">UTC</option>
                </select>
              </label>
              <label title="σ multipliers for the bands, e.g. 1, 2 (blank = none)">bands σ <input type="text" size={6} defaultValue={ind.vwapBands.join(', ')} key={`vb${m.info?.symbol}`} onBlur={(e) => setInd({ vwapBands: parseBands(e.target.value) })} /></label>
            </fieldset>
            <fieldset>
              <legend>
                <label><input type="checkbox" checked={ind.fpOn} onChange={(e) => setInd({ fpOn: e.target.checked })} /> Footprint imbalances</label>
              </legend>
              <label title="a Sold/Bought cell lights when one side beats the other diagonally by this ratio">ratio <input type="number" min={1.5} step={0.5} value={ind.fpRatio} onChange={(e) => setInd({ fpRatio: Math.max(1.5, Number(e.target.value) || 3) })} /></label>
              <label title="ignore rows that traded less than this % of the busiest row">min vol % <input type="number" min={0} step={1} value={ind.fpMinPct} onChange={(e) => setInd({ fpMinPct: Math.max(0, Number(e.target.value) || 0) })} /></label>
              <label title="consecutive imbalances that make a stacked zone">stack <input type="number" min={2} step={1} value={ind.fpStack} onChange={(e) => setInd({ fpStack: Math.max(2, Math.round(Number(e.target.value) || 3)) })} /></label>
              <label><input type="checkbox" checked={ind.fpLines} onChange={(e) => setInd({ fpLines: e.target.checked })} /> zone lines</label>
            </fieldset>
            {orRoot(m.info?.displaySymbol ?? m.info?.symbol) && (
              <fieldset>
                <legend>
                  <label><input type="checkbox" checked={ind.orOn} onChange={(e) => setInd({ orOn: e.target.checked })} /> RTH opening range (BookDepthIQ PAXOR)</label>
                </legend>
                <span className="muted">08:30:00–08:30:30 Chicago · EXT every {orRoot(m.info?.displaySymbol ?? m.info?.symbol) === 'NQ' ? '65' : '15'} pts · kept until the next bell</span>
                <label><input type="checkbox" checked={ind.orMid} onChange={(e) => setInd({ orMid: e.target.checked })} /> mid line</label>
              </fieldset>
            )}
            <fieldset>
              <legend>
                <label><input type="checkbox" checked={ind.bigOn} onChange={(e) => setInd({ bigOn: e.target.checked })} /> Big trades</label>
              </legend>
              <label title="a print this size or more is highlighted on the tape (units)">min size u <input type="number" min={0} step={0.5} value={ind.bigMin} onChange={(e) => setInd({ bigMin: Math.max(0, Number(e.target.value) || 0) })} /></label>
            </fieldset>
          </details>
          <button className="mini" onClick={() => m.resetPaper()}>reset paper account</button>
        </details>
      </section>

      <section className="position">
        <div>
          <label>Position</label>
          <b className={pos.qty > 0 ? 'pos' : pos.qty < 0 ? 'neg' : ''}>{pos.qty}</b>
          <small>{pos.qty ? eq(Math.abs(pos.qty)) : ''}</small>
        </div>
        <div>
          <label>Avg</label>
          <b>{pos.qty ? formatPrice(pos.avgTicks, tick) : '—'}</b>
        </div>
        <div>
          <label>Fail price</label>
          <b className="neg">{pos.qty ? (() => {
            const fp = failPrice(pos.qty, pos.avgTicks * tick, equityExOpen, floor);
            return fp === undefined ? '—' : fp.toFixed(dec);
          })() : '—'}</b>
        </div>
        <div>
          <label>Open P&amp;L</label>
          <b className={pnlClass(unreal)}>{fmtUsd(unreal)}</b>
        </div>
        <div title="points the market can move against you before equity reaches the fail floor">
          <label>To floor</label>
          <b className="warnv">{toFloorPts === undefined ? '—' : `${toFloorPts.toFixed(toFloorPts < 10 ? 1 : 0)} pts`}</b>
        </div>
        <div title="volume profile since the panel opened">
          <label>POC · VA</label>
          <b>
            {prof.poc === undefined ? '—' : formatPrice(prof.poc, tick)}
            {prof.val !== undefined && prof.vah !== undefined && <small className="va">{formatPrice(prof.val, tick)}–{formatPrice(prof.vah, tick)}</small>}
          </b>
        </div>
        <div title="session cumulative delta (bought − sold)">
          <label>Cum Δ</label>
          <b className={m.cumDelta >= 0 ? 'dup' : 'ddn'}>
            {spark && (
              <svg className="spark" width="110" height="22" viewBox="0 0 110 22" aria-hidden="true">
                <polyline points={spark} />
              </svg>
            )}
            {`${m.cumDelta >= 0 ? '+' : ''}${m.cumDelta.toFixed(2)}`}
          </b>
        </div>
        {s.showTrend && (
          <div title="points from the last price to each SuperTrend line (positive = price above the line)">
            <label>ST1 · ST2</label>
            <b>
              {[st1, st2].map((st, i) => {
                const d = stDist(st);
                return (
                  <span key={i} className={st ? (st.dir === 'up' ? 'dup' : 'ddn') : ''}>
                    {i > 0 ? ' · ' : ''}
                    {st && d !== undefined ? `${st.dir === 'up' ? '▲' : '▼'} ${d.toFixed(2)}` : '—'}
                  </span>
                );
              })}
            </b>
          </div>
        )}
        {m.or && (
          <div title="RTH opening range (BookDepthIQ PAXOR): 08:30:00–08:30:30 Chicago, kept until the next weekday bell; EXT every 65 pts NQ / 15 pts ES">
            <label>OR{m.orLoading ? ' (loading…)' : orForming ? ' (forming)' : m.or && !m.or.formed ? ' (no prints at the bell)' : m.orPartial ? ' (EXT history partial)' : ''}</label>
            <b className="orv">
              {(() => {
                const h = orLevels.find((l) => l.kind === 'high');
                const lo = orLevels.find((l) => l.kind === 'low');
                if (!h || !lo) return '—';
                const where = stRef === undefined ? '' : stRef > h.ticks ? 'ABOVE' : stRef < lo.ticks ? 'BELOW' : 'INSIDE';
                return (
                  <>
                    {formatPrice(lo.ticks, tick)}–{formatPrice(h.ticks, tick)} <small>{((h.ticks - lo.ticks) * tick).toFixed(2)} pts{where ? ` · ${where}` : ''}</small>
                  </>
                );
              })()}
            </b>
          </div>
        )}
        {ind.vwapOn && (
          <div title={`session VWAP ${ind.vwapStart}–${ind.vwapEnd} (${ind.vwapTz}); distance of the last price in σ`}>
            <label>VWAP{m.vwapLoading ? ' (loading…)' : ''}</label>
            <b className="vwapv">
              {vwapT === undefined ? '—' : formatPrice(Math.round(vwapT), tick)}
              {vwapT !== undefined && vwapSd !== undefined && vwapSd > 0 && stRef !== undefined && (
                <small>{`${stRef >= vwapT ? '+' : '−'}${(Math.abs(stRef - vwapT) / vwapSd).toFixed(1)}σ`}</small>
              )}
            </b>
          </div>
        )}
        {fundYou !== undefined && fundRate !== undefined && (
          <div
            className={fundWarn ? 'fundwarn' : ''}
            title="Vest funding, settled hourly on the index notional. Positive: longs pay shorts; negative: shorts pay longs. Red in the last 5 min before a settlement you pay."
          >
            <label>Funding · {fundMinLeft}m</label>
            <b>
              <span className={fundYou > 0 ? 'ddn' : 'dup'}>
                {fundYou > 0 ? 'you pay' : 'you get'} ${Math.abs(fundYou).toFixed(2)}/h
              </span>
              <small> · {pct(fundRate)}/h</small>
            </b>
          </div>
        )}
        <div title="share of visible resting size on the bid / on the ask">
          <label>Bid / ask liq</label>
          <b>
            {liqBid === undefined ? '—' : (
              <>
                <span className="dup">{Math.round(liqBid * 100)}%</span> / <span className="ddn">{100 - Math.round(liqBid * 100)}%</span>
              </>
            )}
          </b>
        </div>
        {!live && (
          <>
            <div>
              <label>Realized</label>
              <b className={pnlClass(broker?.realizedUsd ?? 0)}>{fmtUsd(broker?.realizedUsd ?? 0)}</b>
            </div>
            <div>
              <label>Fees</label>
              <b>{fmtUsd(-(broker?.feesUsd ?? 0))}</b>
            </div>
          </>
        )}
      </section>

      {pos.qty !== 0 && <BracketBar long={pos.qty > 0} qty={Math.abs(pos.qty)} avgTicks={pos.avgTicks} nowTicks={pos.qty > 0 ? bid : ask} legs={orders.filter((o) => o.leg)} fail={failRow} tick={tick} fee={feeRate} roomUsd={equity - floor} />}

      {vestElsewhere.length > 0 && (
        <div className="exposure vest">
          {live ? 'Also open on Vest:' : 'Vest LIVE still holds:'}{' '}
          {vestElsewhere.map((p) => {
            const info = m.table?.resolve(p.symbol);
            return (
              <button key={p.positionId} onClick={() => info && actAsync(L.flatten(info))} title="close this Vest position at market and cancel its orders">
                FLATTEN {info?.displaySymbol ?? p.symbol} {p.qty}
              </button>
            );
          })}
        </div>
      )}
      {!live && L.positions.length === 0 && L.orders.length > 0 && (
        <div className="exposure vest">
          Vest LIVE has {L.orders.length} resting order(s) <button onClick={() => actAsync(L.cancelAll())}>CANCEL ALL ON VEST</button>
        </div>
      )}

      {!live && exposure.length > 0 && (
        <div className="exposure">
          Also open:{' '}
          {exposure.map((x) => (
            <button key={x.symbol} onClick={() => m.select(x.symbol) && setCenter(null)}>
              {m.table?.resolve(x.symbol)?.displaySymbol ?? x.symbol} {x.qty} ({x.orders} ord)
            </button>
          ))}
        </div>
      )}


      <main className="body">
        <div
          className={`ladder g8 ${health === 'stale' ? 'stale' : ''}`}
          onPointerEnter={() => setOverLadder(true)}
          onPointerLeave={() => setOverLadder(false)}
          onWheel={(e) => {
            if (center === null) return;
            detachBriefly();
            setCenter(center + (e.deltaY < 0 ? 2 : -2) * g);
          }}
        >
          <div
            className="lrow head"
            style={gridStyle}
            title="click = limit · shift+click = stop · chip: click cancel / drag move · wheel scroll · space recentre · F flatten · Esc cancel"
          >
            <span>buy</span>
            <span title="volume that hit the bid at this price (sellers). Lit = sellers outweigh buyers diagonally by the imbalance ratio">sold</span>
            <span className="liqhead bid" title="resting bid size as heat · WALL = 3× the average level">bid liq</span>
            <span title="wheel over the price column to group rows">
              {follow ? (
                <>
                  price{g > 1 ? ` ×${g} (${(g * tick).toFixed(dec)})` : ''}{' '}
                  <button
                    className={`mini ${s.fitBracket ? 'on' : ''}`}
                    title="FIT: widen the rows so the stop, targets and trail are all on screen. Rows get coarse, so a click places at the row's price — turn it off to place stops precisely."
                    onClick={() => update({ fitBracket: !s.fitBracket })}
                  >
                    fit
                  </button>
                </>
              ) : (
                <button className="follow-pill" onClick={resumeFollow} title="back to the market now (Space); resumes by itself 3 s after you stop scrolling">
                  ▶ FOLLOW
                </button>
              )}
            </span>
            <span className="liqhead ask" title="resting ask size as heat · WALL = 3× the average level">ask liq</span>
            <span title="volume that lifted the ask at this price (buyers). Lit = buyers outweigh sellers diagonally by the imbalance ratio">bought</span>
            <span>sell</span>
            {showPnl && <span>P&amp;L</span>}
            {s.showHeat && (
              <span title="resting size at each price over the last 5 minutes (left = older, brighter = more size), then pull/stack over the last minute: − = size pulled without trading, + = size stacked. ABSORB = traded a lot while its size kept coming back.">
                heat 5m · pull/stack
              </span>
            )}
            <span title="volume profile since the panel opened: orange = sold at bid, cyan = bought at ask · POC outlined · value area bright">volume profile</span>
            {s.showDelta && (
              <span title="Δ = bought − sold at each price. Click to hide." className={`dhead ${m.cumDelta >= 0 ? 'up' : 'dn'}`} onClick={() => update({ showDelta: false })}>
                Δ
              </span>
            )}
          </div>
          <div className="pins top">{pinned.filter((p) => p.above).map(pinRow)}</div>
          <div className="rows" ref={rowsRef}>
          {rows.map((t) => {
            const b = bidAt.get(t);
            const a = askAt.get(t);
            const v = volAt.get(t);
            const dl = deltaAt.get(t);
            const volCls = t === prof.poc ? 'poc' : prof.val !== undefined && prof.vah !== undefined && t >= prof.val && t <= prof.vah ? 'va' : 'out';
            const bo = boughtG.get(t) ?? 0;
            const so = soldG.get(t) ?? 0;
            const pLabel = t === prof.poc ? 'POC' : t === prof.vah ? 'VAH' : t === prof.val ? 'VAL' : '';
            const pnl = pnlAt(t);
            const cls = [
              'lrow',
              t === bk(bid) ? 'best-bid' : '',
              t === bk(ask) ? 'best-ask' : '',
              t === bk(m.lastTradeTicks) ? 'last' : '',
              t === bk(avgRow) ? 'avg' : '',
              t === bk(failRow) ? 'fail' : '',
              bid !== undefined && ask !== undefined && t > bk(bid)! && t + g - 1 < ask ? 'inside' : '',
              volCls === 'out' ? '' : volCls,
              st1 && t === bk(st1.ticks) ? `st1 st1-${st1.dir}` : '',
              st2 && t === bk(st2.ticks) ? `st2 st2-${st2.dir}` : '',
            ].join(' ');
            const drop = () => {
              if (!drag) return;
              if (drag.id <= -3000) {
                if (t !== bk(drag.from)) previewDrop(drag.id, t);
                setDrag(null);
                return;
              }
              if (live) {
                const c = m.marketCtx();
                const same = t === bk(drag.from);
                if (c && drag.id <= -2000) {
                  const sid = liveStopIds[-2000 - drag.id];
                  if (sid !== undefined) act(same ? L.cancelStop(sid) : L.moveStop(sid, t, c));
                } else if (c && drag.id <= -1000) {
                  const oid = liveOrderIds[-1000 - drag.id];
                  if (oid) actAsync(same ? L.cancelOrder(oid) : L.moveOrder(oid, t, c, br));
                } else if (c && !same && drag.id < 0) {
                  // legs: -1-i = TP i, -100-i = SL i. Dropping a leg on its own row does nothing.
                  actAsync(drag.id > -100 ? L.moveLeg('tp', t, c, -1 - drag.id) : L.moveLeg('sl', t, c, -100 - drag.id));
                }
                setDrag(null);
                return;
              }
              if (!broker) return;
              act(t === drag.from ? broker.cancel(drag.id) : broker.modify(drag.id, t));
              setDrag(null);
            };
            return (
              <div key={t} className={cls} style={gridStyle} onPointerUp={drop}>
                {levelLines.get(t)?.map((l, i) => <i key={`hl${i}`} className={`hl ${l.cls}`} />)}
                {levelLines.has(t) && <b className={`hltag ${levelLines.get(t)![0]!.cls}`}>{levelLines.get(t)!.map((l) => l.label).join(' · ')}</b>}
                <span className="orders buy" title={live ? 'LIVE: click = limit order on Vest · shift-click = panel-held STOP (fires a market order; keep this window open)' : undefined} onClick={(e) => place('buy', t, e.shiftKey)}>
                  {ordersAt(t, 'buy').map(orderChip)}
                </span>
                <span className={`fp sold ${imb.sell.has(t) ? 'imb' : ''} ${imb.sellStack.has(t) ? 'stack' : ''}`}>{so ? <em className="fpn">{fmtVol(so)}</em> : ''}</span>
                <span
                  className="size bid liq"
                  style={b !== undefined ? { background: `rgba(34, 211, 238, ${(0.06 + 0.66 * (b / maxSize)).toFixed(2)})` } : undefined}
                 
                  onClick={(e) => place('buy', t, e.shiftKey)}
                >
                  {bidWalls.has(t) && <b className="wall">WALL</b>}
                  <em>{b !== undefined ? (s.ladderUsd ? fmtK(b * t * tick) : b.toFixed(2)) : ''}</em>
                </span>
                <span
                  className="price"
                  onWheel={(e) => {
                    // Wheel over prices = zoom the price scale (group rows); anywhere else scrolls.
                    e.stopPropagation();
                    const next = stepGroup(g, e.deltaY < 0 ? -1 : 1);
                    if (next !== g) update({ groupTicks: next });
                  }}
                >
                  {implied !== undefined && t === bk(implied) && <b className="idx" title="index-implied mid (index + tracked basis). LAGS Vest's own mid by ~600 ms — reference only, not a lead signal.">◆</b>}
                  <span className="ptxt">{formatPrice(t, tick)}</span>
                  {t === bk(failRow) && <b className="failtag">FAIL</b>}
                  {st1 && t === bk(st1.ticks) && <b className={`sttag st1 ${st1.dir}`}>{st1.dir === 'up' ? '▲' : '▼'} ST1</b>}
                  {st2 && t === bk(st2.ticks) && <b className={`sttag st2 ${st2.dir}`}>{st2.dir === 'up' ? '▲' : '▼'} ST2</b>}
                </span>
                <span
                  className="size ask liq"
                  style={a !== undefined ? { background: `rgba(251, 146, 60, ${(0.06 + 0.66 * (a / maxSize)).toFixed(2)})` } : undefined}
                 
                  onClick={(e) => place('sell', t, e.shiftKey)}
                >
                  <em>{a !== undefined ? (s.ladderUsd ? fmtK(a * t * tick) : a.toFixed(2)) : ''}</em>
                  {askWalls.has(t) && <b className="wall">WALL</b>}
                </span>
                <span className={`fp bought ${imb.buy.has(t) ? 'imb' : ''} ${imb.buyStack.has(t) ? 'stack' : ''}`}>{bo ? <em className="fpn">{fmtVol(bo)}</em> : ''}</span>
                <span className="orders sell" title={live ? 'LIVE: click = limit order on Vest · shift-click = panel-held STOP (fires a market order; keep this window open)' : undefined} onClick={(e) => place('sell', t, e.shiftKey)}>
                  {ordersAt(t, 'sell').map(orderChip)}
                </span>
                {showPnl && <span className={`pnl ${pnl === undefined ? '' : pnlClass(pnl)}`}>{pnl === undefined ? '' : fmtUsd(pnl)}</span>}
                {s.showHeat &&
                  (() => {
                    const hm = heatRows?.get(t) ?? [];
                    const fl = m.liq.flow(t, g, ind.bigMin || 5);
                    const askSide = ask !== undefined && t >= bk(ask)!;
                    const rgb = askSide ? '251,146,60' : '34,211,238';
                    return (
                      <span className="heat">
                        <span className="abs">
                          {fl.absorb && (
                            <b
                              className={fl.absorb}
                              title={fl.absorb === 'bid' ? 'ABSORB bid: sellers kept hitting this bid (more than was showing) and it held: buyers absorbing' : 'ABSORB ask: buyers kept lifting this offer (more than was showing) and it held: sellers absorbing'}
                            >
                              ABS
                            </b>
                          )}
                        </span>
                        <span className="hstrip" title={`resting size over the last 5 min, left = older (now ${fmtVol(hm.at(-1) ?? 0)})`}>
                          {hm.map((v, i) => {
                            const x = v / heatMax;
                            return <i key={i} style={x <= 0 ? undefined : { background: x >= 0.8 ? `rgba(253,230,138,${(0.55 + 0.45 * x).toFixed(2)})` : `rgba(${rgb},${(0.12 + 0.88 * Math.pow(x, 0.7)).toFixed(2)})` }} />;
                          })}
                        </span>
                        <em className={fl.net > 0 ? 'stk' : fl.net < 0 ? 'pul' : ''} title={`last minute: pulled ${fmtVol(fl.pulled)} · stacked ${fmtVol(fl.stacked)} · traded ${fmtVol(fl.traded)}`}>
                          {fl.signal && Math.abs(fl.net) >= 0.01 ? `${fl.net > 0 ? '+' : '−'}${fmtVol(Math.abs(fl.net))}` : ''}
                        </em>
                      </span>
                    );
                  })()}
                <span className={`prof ${volCls}`} title={t === prof.poc ? 'POC — most traded price this session' : volCls === 'va' ? 'inside the 70% value area' : undefined}>
                  <span className="ptrack">
                    {v !== undefined && (
                      <span className="pbar" style={{ width: `${(v / maxVol) * 100}%` }}>
                        <i className="ps" style={{ width: `${v ? (so / v) * 100 : 0}%` }} />
                        <i className="pb" style={{ width: `${v ? (bo / v) * 100 : 0}%` }} />
                      </span>
                    )}
                  </span>
                  <em className="pnum">{v !== undefined ? fmtVol(v) : ''}</em>
                  <b className={`plabel ${pLabel === 'POC' ? 'poc' : ''}`}>{pLabel}</b>
                </span>
                {s.showDelta && (
                  <span className={`delta ${dl === undefined ? '' : dl >= 0 ? 'up' : 'dn'}`}>
                    <span className="dtrack">{dl !== undefined && dl !== 0 && <i style={{ width: `${(Math.abs(dl) / maxDelta) * 50}%` }} />}</span>
                    <em className="dnum">{dl !== undefined && Math.abs(dl) >= 0.005 ? `${dl > 0 ? '+' : '−'}${fmtVol(Math.abs(dl))}` : ''}</em>
                  </span>
                )}
              </div>
            );
          })}
          </div>
          <div className="pins bottom">{pinned.filter((p) => !p.above).map(pinRow)}</div>
          {live && s.showBlotter && L.blotter.rows.length > 0 && (
            <div className="blotter" title="every request sent to Vest: SENT → ACKED → WORKING → FILLED / GONE, or REJECTED. NO ANSWER = still waiting after 3 s: check Vest before resending.">
              {L.blotter.rows.slice(0, 4).map((r) => {
                const st = r.status === 'SENT' && Date.now() - r.at >= 3000 ? 'NO ANSWER' : r.status;
                return (
                  <div key={r.id} className={`brow s-${st.replace(' ', '-').toLowerCase()}`}>
                    <span>{new Date(r.at).toLocaleTimeString([], { hour12: false })}</span>
                    <span>{r.kind}</span>
                    <span className={r.side === 'buy' ? 'bid' : r.side === 'sell' ? 'ask' : ''}>{r.side ?? ''}</span>
                    <span>{r.qty ?? ''}</span>
                    <span>{r.price ? `@ ${r.price}` : ''}</span>
                    <b>{st}</b>
                    <span>{r.ackMs !== undefined ? `${r.ackMs} ms` : ''}</span>
                    <span className="bnote">{r.note ?? ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <aside className="side">
          <div className="tape">
            <h4>
              {s.showJournal ? 'Journal' : 'Vest tape'}
              <button className={`mini ${s.showJournal ? 'on' : ''}`} title="trade journal: every trade with its setup, risk, result and R" onClick={() => update({ showJournal: !s.showJournal })}>
                journal
              </button>
              <button className={`mini ${s.showHeat ? 'on' : ''}`} title="heatmap + pull/stack column on the ladder" onClick={() => update({ showHeat: !s.showHeat })}>
                heat
              </button>
              <button className="mini" title={s.showLog ? 'hide the log: tape only' : 'show the PAPER / LIVE request log under the tape'} onClick={() => update({ showLog: !s.showLog })}>
                {s.showLog ? 'hide log' : 'log'}
              </button>
              <button className="mini" title={s.showTrend ? 'hide the SuperTrend lines and badge' : 'show the dual SuperTrend (BookDepthIQ) on the ladder'} onClick={() => update({ showTrend: !s.showTrend })}>
                {s.showTrend ? 'ST on' : 'ST'}
              </button>
              {!s.showDelta && (
                <button className="mini" title="show the Δ (delta) column on the ladder" onClick={() => update({ showDelta: true })}>
                  Δ
                </button>
              )}
            </h4>
            {s.showJournal && <JournalView trades={journal} onClear={() => saveJournal([])} />}
            {!s.showJournal && m.tape.slice(0, s.showLog ? 40 : 120).map((r) => (
              <div key={r.id} className={`trow ${r.side} ${ind.bigOn && r.qty >= ind.bigMin ? (r.qty >= 3 * ind.bigMin ? 'big huge' : 'big') : ''}`}>
                <span>{new Date(r.time).toLocaleTimeString([], { hour12: false })}</span>
                <span>{formatPrice(r.priceTicks, tick)}</span>
                <span className="tq">
                  {ind.bigOn && r.qty >= ind.bigMin && <i style={{ width: `${Math.min(100, (r.qty / (4 * ind.bigMin)) * 100)}%` }} />}
                  <em>{ind.bigOn && r.qty >= ind.bigMin ? `${r.side === 'buy' ? 'B' : 'S'} ${r.qty.toFixed(2)}` : r.qty.toFixed(4)}</em>
                </span>
              </div>
            ))}
            {!s.showJournal && m.tape.length === 0 && <div className="muted">waiting for trades…</div>}
          </div>
          {s.showLog && <div className="log">
            {live || L.log.length > 0 ? (
              <h4>
                LIVE log{' '}
                <button
                  className="mini"
                  title="copy the whole request/response log (oldest first) — tokens are already redacted"
                  onClick={() => void navigator.clipboard?.writeText(L.log.slice().reverse().join('\n')).catch(() => {})}
                >
                  copy
                </button>
              </h4>
            ) : (
              <h4>Paper log</h4>
            )}
            {(live ? L.log.slice(0, 200) : m.log).map((l, i) => (
              <div key={i} className={l.includes('→') ? 'req' : l.includes('←') ? 'res' : ''}>
                {l}
              </div>
            ))}
            {!live && broker?.fills
              .slice(-8)
              .reverse()
              .map((f) => (
                <div key={`f${f.id}`} className={`fill ${f.side}`}>
                  fill {f.side} {f.qty} @ {formatPrice(f.priceTicks, tick)} ({f.note}){f.realizedUsd ? ` ${fmtUsd(f.realizedUsd)}` : ''}
                </div>
              ))}
          </div>}
        </aside>
      </main>

      <section className="ticket">
        <div className="fields">
          <label>
            Size
            <select value={s.sizeMode} onChange={(e) => update({ sizeMode: e.target.value as SizeMode })}>
              <option value="units">units</option>
              <option value="usd">USD</option>
              <option value="risk">$ risk @SL</option>
            </select>
            <input
              type="number"
              min={0}
              step={s.sizeMode === 'units' ? 0.01 : 1}
              value={s.sizeInput}
              onChange={(e) => update({ sizeInput: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <button key={f} className="mini" disabled={!maxU} onClick={() => update({ sizeMode: 'units', sizeInput: Math.floor(maxU * f * 10 ** sizeDec) / 10 ** sizeDec })}>
              {f * 100}%
            </button>
          ))}
          {s.riskPresets.map((v) => (
            <button
              key={`r${v}`}
              className={`mini ${s.sizeMode === 'risk' && s.sizeInput === v ? 'on' : ''}`}
              title={`size so a stop-out costs $${v}, fees included`}
              onClick={() => update({ sizeMode: 'risk', sizeInput: v })}
            >
              ${v}
            </button>
          ))}
          {rMode ? (
            <label className={s.bracketsOn ? '' : 'dim'} title="TP1 as a multiple of the stop distance (R)">
              TP1 R
              <input type="number" min={0} step={0.5} value={s.tpR[0] ?? 0} onChange={(e) => update({ tpR: [Math.max(0, Number(e.target.value) || 0), s.tpR[1] ?? 0, s.tpR[2] ?? 0] })} />
              <small className="pos">{tpEff[0] ? `${(tpEff[0] * tick).toFixed(dec)} pts` : ''}</small>
            </label>
          ) : (
            <label className={s.bracketsOn ? '' : 'dim'}>
              TP pts
              <PointsInput ticks={s.tpTicks} tick={tick} onTicks={(t) => update({ tpTicks: t })} />
              <small className="pos">{s.tpTicks && units ? `+$${(units * s.tpTicks * tick).toFixed(2)}` : ''}</small>
            </label>
          )}
          {atrMode ? (
            <label className={s.bracketsOn ? '' : 'dim'} title="stop = ATR of the 60 s candles (the ST1 engine) × this">
              SL ATR×
              <input type="number" min={0.25} step={0.25} value={s.atrMult} onChange={(e) => update({ atrMult: Math.max(0.25, Number(e.target.value) || 1) })} />
              <small className="neg">{slEff ? `${(slEff * tick).toFixed(dec)} pts${slOverride !== null ? ' (dragged)' : ''}` : 'ATR warming…'}</small>
              {slOverride !== null && (
                <button className="mini" onClick={() => setSlOverride(null)} title="back to ATR × multiple">
                  snap back
                </button>
              )}
            </label>
          ) : swingMode ? (
            <label className={s.bracketsOn ? '' : 'dim'} title="swing stop: a long's goes under the LOW of the last N minutes, a short's over the HIGH, plus the buffer. The size follows in $ risk sizing.">
              SL swing
              <input type="number" min={1} step={1} value={s.swingMins} onChange={(e) => update({ swingMins: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
              min +
              <PointsInput ticks={s.swingBufTicks} tick={tick} onTicks={(t) => update({ swingBufTicks: t })} />
              <span title="the stop is never closer than this (0 = no floor): an entry at the swing high/low would otherwise get a stop inside the noise">≥</span>
              <PointsInput ticks={s.swingMinTicks} tick={tick} onTicks={(t) => update({ swingMinTicks: t })} />
              <small className="neg">
                {slFor(true) || slFor(false) ? `L ${(slFor(true) * tick).toFixed(dec)} / S ${(slFor(false) * tick).toFixed(dec)} pts${slOverride !== null ? ' (dragged)' : ''}` : 'no range yet'}
              </small>
              {slOverride !== null && (
                <button className="mini" onClick={() => setSlOverride(null)} title="back to the swing">
                  snap back
                </button>
              )}
            </label>
          ) : (
            <label className={s.bracketsOn ? '' : 'dim'}>
              SL pts
              <PointsInput ticks={s.slTicks} tick={tick} onTicks={(t) => update({ slTicks: t })} />
              <small className="neg">{s.slTicks && units ? `−$${(units * s.slTicks * tick).toFixed(2)}` : ''}</small>
            </label>
          )}
          <button
            className={`toggle ${rMode ? 'on' : ''}`}
            title="stop distance: your points, ATR × multiple, or beyond the swing high/low (targets in R for ATR and swing)"
            onClick={() => {
              setSlOverride(null);
              update({ stopMode: s.stopMode === 'pts' ? 'atr' : s.stopMode === 'atr' ? 'swing' : 'pts' });
            }}
          >
            STOP {s.stopMode === 'atr' ? 'ATR' : s.stopMode === 'swing' ? 'SWING' : 'PTS'}
          </button>
          <label>
            B/E + pts
            <PointsInput ticks={s.beOffset} tick={tick} signed onTicks={(t) => update({ beOffset: t })} />
          </label>
          <button className={`toggle ${s.bracketsOn ? 'on' : ''}`} onClick={() => update({ bracketsOn: !s.bracketsOn })}>
            BRACKET {s.bracketsOn ? 'ON' : 'OFF'}
          </button>
          <button
            className={`toggle ${armed ? 'armed' : ''}`}
            title="Armed: B buy mkt · S sell mkt · R reverse · E break-even. Always on: F flatten · Esc cancel all."
            onClick={() => setArmed(!armed)}
          >
            HOTKEYS {armed ? 'ARMED' : 'SAFE'}
          </button>
        </div>
        <div className="fields more">
          {[1, 2].map((i) =>
            rMode ? (
              <label key={i} className={s.bracketsOn ? '' : 'dim'} title={`TP${i + 1} in R (0 = off)`}>
                TP{i + 1} R
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={s.tpR[i] ?? 0}
                  onChange={(e) => {
                    const tpR = [s.tpR[0] ?? 0, s.tpR[1] ?? 0, s.tpR[2] ?? 0];
                    tpR[i] = Math.max(0, Number(e.target.value) || 0);
                    update({ tpR });
                  }}
                />
              </label>
            ) : (
              <label key={i} className={s.bracketsOn ? '' : 'dim'} title={`target ${i + 1}, further than the one before (0 = off)`}>
                TP{i + 1}
                <PointsInput ticks={i === 1 ? s.tp2Ticks : s.tp3Ticks} tick={tick} onTicks={(t) => update(i === 1 ? { tp2Ticks: t } : { tp3Ticks: t })} />
              </label>
            ),
          )}
          {multiTp && (
            <>
              <label title="share of the size at TP1 / TP2 / TP3, in %">
                split
                <input type="text" className="wide" defaultValue={s.tpSplit} onBlur={(e) => update({ tpSplit: e.target.value.trim() })} />
              </label>
              <label title="when TP1 fills, the panel moves your stop to entry ± the B/E offset — once, while this window is open (in LIVE it sends that stop move without a click)">
                <input type="checkbox" checked={s.beAfterTp1} onChange={(e) => update({ beAfterTp1: e.target.checked })} /> B/E after TP1
              </label>
            </>
          )}
          <button
            className={`toggle ${s.scaleOn ? 'on' : ''}`}
            title="SCALE ON: a ladder click places several limits from that price, further away from the market, like Vest's Scale ticket. Shift-click is still a stop. Scale orders carry no TP/SL (Vest's own don't)."
            onClick={() => update({ scaleOn: !s.scaleOn })}
          >
            SCALE {s.scaleOn ? 'ON' : 'OFF'}
          </button>
          {s.scaleOn && (
            <>
              <label title="number of limits, 2–10 (Vest's own limits)">
                ×
                <input type="number" min={2} max={10} step={1} value={s.scaleCount} onChange={(e) => update({ scaleCount: Math.round(Number(e.target.value) || 2) })} />
              </label>
              <label title="from the clicked price to the last limit, away from the market">
                over pts
                <PointsInput ticks={s.scaleSpanTicks} tick={tick} onTicks={(t) => update({ scaleSpanTicks: t })} />
              </label>
              <label title="1 = even; higher puts bigger sizes toward the chosen end">
                skew
                <input type="number" min={1} step={0.5} value={s.scaleSkew} onChange={(e) => update({ scaleSkew: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <select value={s.scaleDir} onChange={(e) => update({ scaleDir: e.target.value as SkewDir })} title="where the biggest sizes go: Start = the clicked price, End = furthest from the market">
                <option value="start">bigger at start</option>
                <option value="even">even</option>
                <option value="end">bigger at end</option>
              </select>
            </>
          )}
          <button
            className={`toggle ${s.stopConfirm === 'close' ? 'on' : ''}`}
            title="stop entries (shift-click): fire on the first trade at/through the price (TOUCH), or only on a 1-minute CLOSE at/through it, so a wick doesn't fill you"
            onClick={() => update({ stopConfirm: s.stopConfirm === 'close' ? 'touch' : 'close' })}
          >
            STP {s.stopConfirm === 'close' ? '1m CLOSE' : 'TOUCH'}
          </button>
          <label title="setup tag saved with the trade in the journal">
            setup
            <select value={s.setup} onChange={(e) => update({ setup: e.target.value })}>
              {['', 'edge fade', 'breakout', 'pullback', 'trend', 'other'].map((v) => (
                <option key={v} value={v}>
                  {v || '—'}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`toggle ${s.preview !== 'off' ? 'on' : ''}`}
            title="show the would-be stop and targets on the ladder before you enter (nothing is sent); drag the stop to change it"
            onClick={() => update({ preview: s.preview === 'off' ? 'long' : s.preview === 'long' ? 'short' : 'off' })}
          >
            PREVIEW {s.preview === 'off' ? 'OFF' : s.preview === 'long' ? 'LONG' : 'SHORT'}
          </button>
          <label title="trailing stop, moved by the panel without a click (keep this window open), only ever your way. From xR: once price is that many × your risk in your favour, the stop follows the best price one risk behind. ST1 / ST2: the stop sits on that SuperTrend line while it is on your side.">
            trail
            <select
              value={s.trailLine ? `st${s.trailLine}` : String(s.trailStartR)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'st1' || v === 'st2') update({ trailLine: v === 'st1' ? 1 : 2, trailStartR: 0 });
                else update({ trailLine: 0, trailStartR: Number(v) });
              }}
            >
              <option value="0">off</option>
              <option value="1">from 1R</option>
              <option value="1.5">from 1.5R</option>
              <option value="2">from 2R</option>
              <option value="st1">on ST1 (60 s)</option>
              <option value="st2">on ST2 (15 s)</option>
            </select>
          </label>
          <label title="LIVE: if a Vest position loses its stop, the panel puts it back at the last price and shows a red warning (keep this window open)">
            <input type="checkbox" checked={s.stopGuard} onChange={(e) => update({ stopGuard: e.target.checked })} /> stop guard
          </label>
        </div>
        {limitsOn && !verdict.ok && (
          <div className="lockbar">
            <b>{dayLimitHit(limits, daySt, equity) ? `DAY LOCKED · ${fmtUsd(dayPnl)} of −$${limits.lossUsd}` : 'ENTRIES PAUSED'}</b> {verdict.message}. FLATTEN, CANCEL, CLOSE HALF, stop moves and KILL keep working.
          </div>
        )}
        {notice && (
          <div className="noticebar" onClick={() => setNotice(null)} title="click to dismiss">
            {notice}
          </div>
        )}
        {(() => {
          const ck = checksFor(units, undefined);
          return ck.length ? (
            <div className="checks" title="fat-finger checks for the next order: ! needs a second click; ✗ would fill at once or be rejected">
              {ck.map((c, i) => (
                <i key={i} className={c.level}>
                  {c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} {c.text}
                </i>
              ))}
            </div>
          ) : null;
        })()}
        <div className="pretrade">
          <span>
            = <b>{units.toFixed(sizeDec)}u</b> <small>{eq(units)}</small>
          </span>
          {swingMode && s.sizeMode === 'risk' && (
            <span title="swing stops differ by side, so the size does too">
              L <b>{unitsFor(true).toFixed(sizeDec)}u</b> / S <b>{unitsFor(false).toFixed(sizeDec)}u</b>
            </span>
          )}
          <span>{refPx ? `${fmtK(units * refPx)} notional` : ''}</span>
          {refPx && units > 0 && (
            <span title="leverage after this entry, counting what is already open">
              → <b>{leverageUsed(openNotional + units * refPx, equity).toFixed(1)}x</b> lev
            </span>
          )}
          <span>${units.toFixed(2)}/pt</span>
          <span className={nextRisk !== undefined && nextRisk > ddLeft ? 'neg' : ''} title="loss at the stop, taker fee both ways included">
            {nextRisk !== undefined ? `risk $${nextRisk.toFixed(2)} at SL` : 'no SL'}
          </span>
          {limitsOn && verdict.roomUsd !== undefined && nextRisk !== undefined && nextRisk > verdict.roomUsd && verdict.roomUsd > 0 && (
            <span className="neg">
              only ${verdict.roomUsd.toFixed(2)} left today{' '}
              <button className="mini" onClick={() => update({ sizeMode: 'risk', sizeInput: Math.floor(verdict.roomUsd! * 100) / 100 })}>
                size to fit
              </button>
            </span>
          )}
          {refPx && units > 0 && (
            <span>
              fail <span className="pos">L {(refPx - (equity - floor) / units).toFixed(dec)}</span> /{' '}
              <span className="neg">S {(refPx + (equity - floor) / units).toFixed(dec)}</span>
            </span>
          )}
          {s.bracketsOn && slEff > 0 && spread !== undefined && slEff <= spread && (
            <span className="neg" title="The stop is measured from your fill. A buy fills at the ask, so a stop closer than the spread is already at or through the bid. In this paper sim it triggers on the bid; Vest's own trigger price (bid, mid or mark) is not yet confirmed.">
              SL {(slEff * tick).toFixed(dec)} ≤ spread {(spread * tick).toFixed(dec)} — stops out on entry
            </span>
          )}
          {atrMode && s.bracketsOn && !slEff && <span className="neg">ATR still warming up — entries go WITHOUT a stop</span>}
          {s.sizeMode === 'risk' && !slEff && !atrMode && <span className="neg">set SL points to size by risk</span>}
          {s.bracketsOn && multiTp && units > 0 && (() => {
            const sp = splitTargets(units, sizeDec, targets);
            return sp.ok ? (
              <span title="each target closes its own part of the position">
                {sp.legs.map((l, i) => `TP${i + 1} ${l.qty}u +$${(l.qty * l.ticks * tick).toFixed(2)}`).join(' · ')}
              </span>
            ) : (
              <span className="neg">{sp.message}</span>
            );
          })()}
          {s.scaleOn && units > 0 && (() => {
            const sc = scaleOrders(units, sizeDec, 0, s.scaleSpanTicks, s.scaleCount, s.scaleSkew, s.scaleDir);
            return sc.ok ? (
              <span title="click a ladder price: limits from there, further from the market">
                scale {sc.legs.map((l) => l.qty).join(' / ')}u every {((s.scaleSpanTicks / (s.scaleCount - 1)) * tick).toFixed(dec)} pts · no TP/SL
              </span>
            ) : (
              <span className="neg">scale: {sc.message}</span>
            );
          })()}
          {units > maxU + 1e-9 && maxU > 0 && <span className="neg">over max size</span>}
          {live && s.liveSizeCap > 0 && units > s.liveSizeCap + 1e-12 && <span className="neg">over LIVE cap {s.liveSizeCap}u</span>}
        </div>
        <div className="coststrip">
          <span
            className={`gate ${gate ?? 'learning'}`}
            title={
              gate
                ? `spread vs this market's last 5 min: cheap = at or below the median (${((m.spreadWin.quantile(0.5) ?? 0) * tick).toFixed(dec)}), wide = above p90 (${((p90 ?? 0) * tick).toFixed(dec)})`
                : 'collecting a few minutes of spread history before judging'
            }
          >
            <i />
            spread {spread === undefined ? '—' : (spread * tick).toFixed(dec)} · {gate === 'cheap' ? 'CHEAP to cross' : gate === 'normal' ? 'normal' : gate === 'wide' ? 'WIDE — wait or use a limit' : 'learning…'}
          </span>
          {rtBuy && (
            <span className={`fillest ${rtBuy.entry.slipTicks >= 0.05 || !rtBuy.entry.complete ? 'slip' : ''}`} title={`buy ${units} walks ${rtBuy.entry.levels} ask level(s), worst ${(rtBuy.entry.worstTicks * tick).toFixed(dec)}`}>
              BUY ≈ <b>{fillTxt(rtBuy)}</b> {!rtBuy.entry.complete ? '· book too thin' : rtBuy.entry.slipTicks >= 0.05 ? `· slip ${rtBuy.entry.slipTicks.toFixed(1)}t` : '· no slip'}
            </span>
          )}
          {rtSell && (
            <span className={`fillest ${rtSell.entry.slipTicks >= 0.05 || !rtSell.entry.complete ? 'slip' : ''}`} title={`sell ${units} walks ${rtSell.entry.levels} bid level(s), worst ${(rtSell.entry.worstTicks * tick).toFixed(dec)}`}>
              SELL ≈ <b>{fillTxt(rtSell)}</b> {!rtSell.entry.complete ? '· book too thin' : rtSell.entry.slipTicks >= 0.05 ? `· slip ${rtSell.entry.slipTicks.toFixed(1)}t` : '· no slip'}
            </span>
          )}
          {breakEven !== undefined && (
            <span
              className={ddLeft > 0 && breakEven * units > 0.1 * ddLeft ? 'neg' : ''}
              title="points price must move your way to cover crossing the spread both ways, slippage and both taker fees"
            >
              break-even <b>{breakEven.toFixed(2)} pts</b> (${(breakEven * units).toFixed(2)}{ddLeft > 0 ? ` · ${(((breakEven * units) / ddLeft) * 100).toFixed(0)}% of DD left` : ''})
            </span>
          )}
          {edge !== undefined && (
            <span className={`edge ${edge < 1.5 ? 'bad' : edge < 2 ? 'meh' : 'good'}`} title="your TP distance as a multiple of the all-in break-even move. Under 2× the trade mostly pays the spread.">
              TP {tpPts.toFixed(dec)} pts = <b>{edge.toFixed(1)}×</b> cost
            </span>
          )}
        </div>
        <div className="buttons">
          <button
            className="buy"
            disabled={live ? bid === undefined || ask === undefined || units <= 0 || L.busy : !broker?.hasBook || m.failed || units <= 0}
            onClick={() => market('buy')}
          >
            BUY MKT
            {rtBuy && <small>≈ {fillTxt(rtBuy)}</small>}
          </button>
          <button
            className="sell"
            disabled={live ? bid === undefined || ask === undefined || units <= 0 || L.busy : !broker?.hasBook || m.failed || units <= 0}
            onClick={() => market('sell')}
          >
            SELL MKT
            {rtSell && <small>≈ {fillTxt(rtSell)}</small>}
          </button>
          <button disabled={!pos.qty} onClick={breakevenNow}>
            B/E
          </button>
          <button disabled={!pos.qty} onClick={closeHalfNow} title="close half the position at market (never blocked)">
            CLOSE HALF
          </button>
          <button disabled={!pos.qty || live} title={live ? 'reverse is paper-only for now' : undefined} onClick={reverse}>
            REVERSE
          </button>
          {/* Cancel and flatten are never disabled. */}
          <button onClick={cancelNow}>CANCEL ALL</button>
          <button className="flatten" onClick={flattenNow}>
            FLATTEN
          </button>
        </div>
      </section>
    </div>
  );
}
