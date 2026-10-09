import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { bestAsk, bestBid } from '../src/book/book';
import { PanelModel } from '../src/panel/model';
import { formatPrice, tickDecimals, type Result, type Side, type WorkingOrder } from '../src/sim/paper';
import { failPrice, leverageUsed, marginUsed, maxUnits, riskUsd, unitsForNotional, unitsForRisk } from '../src/sim/account';
import { aggregate, bucketOf, offscreen, rowPnlUsd, stepGroup } from '../src/panel/ladderMath';
import { loadSettings, saveSettings, type Settings, type SizeMode } from './settings';
import { edgeRatio, roundTrip, spreadGate } from '../src/panel/cost';
import { bidShare, imbalances, walls } from '../src/panel/footprint';
import { indicatorsFor, parseBands, stackZones, type IndicatorCfg } from '../src/panel/indicators';
import { orLabel, orRoot } from '../src/panel/paxor';
import { buildProfile } from '../src/panel/profile';
import { watchHookStatus, watchUserToken, watchVestTabs } from './liveToken';
import { liveOpenPnl } from '../src/live/rules';

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

export function App() {
  const m = useModel();
  const [s, setS] = useState<Settings>(loadSettings);
  const [center, setCenter] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: number; from: number } | null>(null);
  const g = Math.max(1, s.groupTicks);
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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void m.start(s.symbol);
    return () => m.stop();
  }, [m, s.symbol]);

  // Bracket settings are the user's numbers, applied to the paper broker as they change.
  const broker = m.broker;
  useEffect(() => {
    if (broker) broker.bracket = { enabled: s.bracketsOn, tpTicks: s.tpTicks, slTicks: s.slTicks };
  }, [broker, s.bracketsOn, s.tpTicks, s.slTicks]);

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
  useEffect(() => {
    if (mid === undefined) return;
    if (follow || center === null) setCenter(bucketOf(Math.round(mid), g));
  }, [mid, follow, center, g]);
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
  const units =
    s.sizeMode === 'units'
      ? s.sizeInput
      : s.sizeMode === 'usd'
        ? refPx
          ? unitsForNotional(s.sizeInput, refPx, sizeDec)
          : 0
        : unitsForRisk(s.sizeInput, s.slTicks, tick, sizeDec);
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
        ...lpos.takeProfits.map((l, i) => ({ id: -1 - i, side: legSide, type: 'limit' as const, priceTicks: Math.round(l.triggerPrice / tick), qty: Math.abs(lpos.qty), reduceOnly: true, leg: 'tp' as const })),
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
  const orders = live ? [...liveEntries, ...liveLegs] : (broker?.orders ?? []);
  const ordersAt = (t: number, side: Side) => orders.filter((o) => bucketOf(o.priceTicks, g) === t && o.side === side);
  const pos = live ? { qty: lpos?.qty ?? 0, avgTicks: lpos ? lpos.openPrice / tick : 0 } : (broker?.position ?? { qty: 0, avgTicks: 0 });
  const avgRow = pos.qty !== 0 ? Math.round(pos.avgTicks) : undefined;

  const place = (side: Side, t: number, stop: boolean) => {
    if (live) {
      // Vest has market and limit orders only — no stop entry to send a shift-click to.
      if (stop) return act({ ok: false, message: 'LIVE: Vest has no stop entry orders (its ticket offers market and limit only) — plain click for a limit' });
      const c = m.marketCtx();
      if (c) actAsync(L.enterLimit(side, units, t, c, { bracketsOn: s.bracketsOn, tpTicks: s.tpTicks, slTicks: s.slTicks }));
      return;
    }
    if (!broker) return;
    act(m.guarded(side, units, t * tick, () => (stop ? broker.stopOrder(side, units, t) : broker.limitOrder(side, units, t))));
  };
  const market = (side: Side) => {
    if (live) {
      const c = m.marketCtx();
      if (c) actAsync(L.enter(side, units, c, { bracketsOn: s.bracketsOn, tpTicks: s.tpTicks, slTicks: s.slTicks }));
      return;
    }
    if (!broker) return;
    const p = side === 'buy' ? ask : bid;
    act(m.guarded(side, units, p === undefined ? undefined : p * tick, () => broker.marketOrder(side, units)));
  };
  const reverse = () => {
    if (live) return paperOnly('REVERSE');
    if (!broker || !pos.qty) return;
    const side: Side = pos.qty > 0 ? 'sell' : 'buy';
    const p = side === 'buy' ? ask : bid;
    act(m.guarded(side, Math.abs(pos.qty) * 2, p === undefined ? undefined : p * tick, () => broker.reverse()));
  };

  const rows: number[] = [];
  if (center !== null) for (let i = 0; i < nRows; i++) rows.push(center + (nRows / 2 - i) * g);
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
  const cols = ['0.5fr', '0.62fr', '0.9fr', '1fr', '0.9fr', '0.62fr', '0.5fr', ...(showPnl ? ['0.7fr'] : []), '1.35fr', ...(s.showDelta ? ['0.7fr'] : [])].join(' ');
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
  const implied = s.showIndexRef && m.impliedTicks !== undefined ? Math.round(m.impliedTicks) : undefined;
  // Dual SuperTrend (BookDepthIQ engine): levels in ticks, drawn as lines across their ladder rows.
  const tr = m.trendSnap;
  const st1 = s.showTrend && tr.t1.lineTicks !== undefined && tr.t1.dir !== 'neutral' ? { ticks: tr.t1.lineTicks, dir: tr.t1.dir } : undefined;
  const st2 = s.showTrend && tr.t2.lineTicks !== undefined && tr.t2.dir !== 'neutral' ? { ticks: tr.t2.lineTicks, dir: tr.t2.dir } : undefined;
  const stRef = m.lastTradeTicks ?? mid;
  const stDist = (st: typeof st1) => (st && stRef !== undefined ? (stRef - st.ticks) * tick : undefined);
  const TREND_LABEL = { strongLong: '▲▲ STRONG LONG', weakLong: '▲ WEAK LONG', chop: '◆ CHOP', weakShort: '▼ WEAK SHORT', strongShort: '▼▼ STRONG SHORT' } as const;
  const flipFresh = m.lastFlip !== null && Date.now() - m.lastFlip.at < 5000;
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
  const markers = [
    ...orders.map((o) => ({ label: o.leg ? o.leg.toUpperCase() : o.type === 'stop' ? 'STP' : 'LMT', ticks: o.priceTicks })),
    ...(failRow !== undefined ? [{ label: 'FAIL', ticks: failRow }] : []),
    ...(st1 ? [{ label: `ST1 ${st1.dir === 'up' ? 'support' : 'resistance'}`, ticks: st1.ticks }] : []),
    ...(vwapT !== undefined ? [{ label: 'VWAP', ticks: Math.round(vwapT) }] : []),
    ...orLevels.filter((l) => l.kind === 'high' || l.kind === 'low').map((l) => ({ label: orLabel(l), ticks: l.ticks })),
    ...(st2 ? [{ label: `ST2 ${st2.dir === 'up' ? 'support' : 'resistance'}`, ticks: st2.ticks }] : []),
  ];
  const pinned = center === null ? [] : offscreen(markers, lo, hi);
  const pinRow = (p: (typeof pinned)[number]) => {
    const pnl = pnlAt(p.ticks);
    return (
      <div
        key={`${p.label}${p.ticks}`}
        className={`pin ${p.label.startsWith('FAIL') ? 'fail' : p.label.startsWith('TP') ? 'tp' : p.label.startsWith('SL') ? 'sl' : p.label.startsWith('ST') ? (p.label.endsWith('support') ? 'st-up' : 'st-down') : p.label === 'VWAP' ? 'vwap' : p.label === 'OR H' ? 'or-h' : p.label === 'OR L' ? 'or-l' : ''}`}
        onClick={() => {
          detachBriefly();
          setCenter(bucketOf(p.ticks, g));
        }}
      >
        {p.above ? '▲' : '▼'} {p.label} {formatPrice(p.ticks, tick)} · {(p.distance * tick).toFixed(dec)} pts off-screen{pnl !== undefined ? ` · ${fmtUsd(pnl)}` : ''}
      </div>
    );
  };

  const orderChip = (o: WorkingOrder) => (
    <span
      key={o.id}
      className={`chip ${o.leg ?? o.type} ${o.side}`}
      title={`${o.leg ? o.leg.toUpperCase() + ' ' : ''}${o.side} ${o.type} ${o.qty} — ${live ? (o.leg ? 'on Vest: drag to move' : 'on Vest: click to cancel, drag to move') : 'click to cancel, drag to move'}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        setDrag({ id: o.id, from: o.priceTicks });
      }}
      // The row's pointer-up decides cancel (same row) vs move (other row); a chip click must never
      // reach the row underneath, which would place a new order.
      onClick={(e) => e.stopPropagation()}
    >
      {o.leg ? o.leg.toUpperCase() : o.type === 'stop' ? 'STP' : 'LMT'} {o.qty}
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
  const tpPts = s.bracketsOn ? s.tpTicks * tick : 0;
  const edge = edgeRatio(tpPts, breakEven);
  const fillTxt = (r: typeof rtBuy) => (r ? (r.entry.avgTicks * tick).toFixed(dec) : '—');

  keys.current = {
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
        <div className="paper-banner">LOCAL PAPER — orders fill in this window only. Nothing is sent to Vest.</div>
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
          <button className={live ? 'on live' : ''} disabled={liveBusy} onClick={() => void toLive()}>
            {liveBusy ? 'LIVE…' : 'LIVE'}
          </button>
        </span>
        {s.showTrend && (
          <span
            className={`trendbadge ${tr.t1.lineTicks === undefined ? 'warm' : tr.state} ${flipFresh ? 'flip' : ''}`}
            title={`Dual SuperTrend (BookDepthIQ): ST1 60s×10 ×3.6, ST2 15s×10 ×3.0, flip on price + delta.${m.lastFlip ? ` Last flip: ST${m.lastFlip.line} ${m.lastFlip.dir === 'up' ? '▲' : '▼'} ${Math.round((Date.now() - m.lastFlip.at) / 1000)} s ago.` : ''}`}
          >
            {tr.t1.lineTicks === undefined ? 'SuperTrend warming up…' : `${TREND_LABEL[tr.state]} ${tr.confidence > 0 ? '+' : ''}${tr.confidence}`}
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
          className="ladder g8"
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
                <>price{g > 1 ? ` ×${g} (${(g * tick).toFixed(dec)})` : ''}</>
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
              if (live) {
                const c = m.marketCtx();
                const same = t === bk(drag.from);
                if (c && drag.id <= -1000) {
                  const oid = liveOrderIds[-1000 - drag.id];
                  if (oid) actAsync(same ? L.cancelOrder(oid) : L.moveOrder(oid, t, c, { bracketsOn: s.bracketsOn, tpTicks: s.tpTicks, slTicks: s.slTicks }));
                } else if (c && !same && drag.id < 0) {
                  // legs: -1-i = TP, -100-i = SL. Dropping a leg on its own row does nothing.
                  actAsync(L.moveLeg(drag.id > -100 ? 'tp' : 'sl', t, c));
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
                <span className="orders buy" title={live ? 'LIVE: click = limit order on Vest (shift-click stops are paper-only: Vest has no stop entries)' : undefined} onClick={(e) => place('buy', t, e.shiftKey)}>
                  {ordersAt(t, 'buy').map(orderChip)}
                </span>
                <span className={`fp sold ${imb.sell.has(t) ? 'imb' : ''} ${imb.sellStack.has(t) ? 'stack' : ''}`}>{so ? fmtVol(so) : ''}</span>
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
                  {formatPrice(t, tick)}
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
                <span className={`fp bought ${imb.buy.has(t) ? 'imb' : ''} ${imb.buyStack.has(t) ? 'stack' : ''}`}>{bo ? fmtVol(bo) : ''}</span>
                <span className="orders sell" title={live ? 'LIVE: click = limit order on Vest (shift-click stops are paper-only: Vest has no stop entries)' : undefined} onClick={(e) => place('sell', t, e.shiftKey)}>
                  {ordersAt(t, 'sell').map(orderChip)}
                </span>
                {showPnl && <span className={`pnl ${pnl === undefined ? '' : pnlClass(pnl)}`}>{pnl === undefined ? '' : fmtUsd(pnl)}</span>}
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
        </div>

        <aside className="side">
          <div className="tape">
            <h4>
              Vest tape
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
            {m.tape.slice(0, s.showLog ? 40 : 120).map((r) => (
              <div key={r.id} className={`trow ${r.side} ${ind.bigOn && r.qty >= ind.bigMin ? (r.qty >= 3 * ind.bigMin ? 'big huge' : 'big') : ''}`}>
                <span>{new Date(r.time).toLocaleTimeString([], { hour12: false })}</span>
                <span>{formatPrice(r.priceTicks, tick)}</span>
                <span className="tq">
                  {ind.bigOn && r.qty >= ind.bigMin && <i style={{ width: `${Math.min(100, (r.qty / (4 * ind.bigMin)) * 100)}%` }} />}
                  <em>{ind.bigOn && r.qty >= ind.bigMin ? `${r.side === 'buy' ? 'B' : 'S'} ${r.qty.toFixed(2)}` : r.qty.toFixed(4)}</em>
                </span>
              </div>
            ))}
            {m.tape.length === 0 && <div className="muted">waiting for trades…</div>}
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
          <label className={s.bracketsOn ? '' : 'dim'}>
            TP pts
            <PointsInput ticks={s.tpTicks} tick={tick} onTicks={(t) => update({ tpTicks: t })} />
            <small className="pos">{s.tpTicks && units ? `+$${(units * s.tpTicks * tick).toFixed(2)}` : ''}</small>
          </label>
          <label className={s.bracketsOn ? '' : 'dim'}>
            SL pts
            <PointsInput ticks={s.slTicks} tick={tick} onTicks={(t) => update({ slTicks: t })} />
            <small className="neg">{s.slTicks && units ? `−$${(units * s.slTicks * tick).toFixed(2)}` : ''}</small>
          </label>
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
        <div className="pretrade">
          <span>
            = <b>{units.toFixed(sizeDec)}u</b> <small>{eq(units)}</small>
          </span>
          <span>{refPx ? `${fmtK(units * refPx)} notional` : ''}</span>
          {refPx && units > 0 && (
            <span title="leverage after this entry, counting what is already open">
              → <b>{leverageUsed(openNotional + units * refPx, equity).toFixed(1)}x</b> lev
            </span>
          )}
          <span>${units.toFixed(2)}/pt</span>
          <span className={s.slTicks && riskUsd(units, s.slTicks, tick) > ddLeft ? 'neg' : ''}>
            {s.bracketsOn && s.slTicks ? `risk $${riskUsd(units, s.slTicks, tick).toFixed(2)} at SL` : 'no SL'}
          </span>
          {refPx && units > 0 && (
            <span>
              fail <span className="pos">L {(refPx - (equity - floor) / units).toFixed(dec)}</span> /{' '}
              <span className="neg">S {(refPx + (equity - floor) / units).toFixed(dec)}</span>
            </span>
          )}
          {s.bracketsOn && s.slTicks > 0 && spread !== undefined && s.slTicks <= spread && (
            <span className="neg" title="The stop is measured from your fill. A buy fills at the ask, so a stop closer than the spread is already at or through the bid. In this paper sim it triggers on the bid; Vest's own trigger price (bid, mid or mark) is not yet confirmed.">
              SL {(s.slTicks * tick).toFixed(dec)} ≤ spread {(spread * tick).toFixed(dec)} — stops out on entry
            </span>
          )}
          {s.sizeMode === 'risk' && !s.slTicks && <span className="neg">set SL points to size by risk</span>}
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
