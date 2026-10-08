import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { bestAsk, bestBid } from '../src/book/book';
import { PanelModel } from '../src/panel/model';
import { formatPrice, tickDecimals, type Result, type Side, type WorkingOrder } from '../src/sim/paper';
import { failPrice, leverageUsed, marginUsed, maxUnits, riskUsd, unitsForNotional, unitsForRisk } from '../src/sim/account';
import { aggregate, bracketPreview, bucketOf, offscreen, roundTripCost, rowPnlUsd, stepGroup } from '../src/panel/ladderMath';
import { loadSettings, saveSettings, type Settings, type SizeMode } from './settings';
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
  const [hover, setHover] = useState<{ t: number; side: Side } | null>(null);
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
  const paperOnly = (what: string) => act({ ok: false, message: `LIVE v1: ${what} is paper-only` });

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
  // Hover preview: where an entry from this row would fill, and where its bracket would land.
  const preview = (() => {
    if (!hover || pos.qty !== 0 || units <= 0 || bid === undefined || ask === undefined) return null;
    const entry = hover.side === 'buy' ? Math.min(hover.t, ask) : Math.max(hover.t, bid);
    const br = s.bracketsOn ? bracketPreview(hover.side, entry, units, s.tpTicks, s.slTicks, tick) : {};
    const room = equity - floor;
    const failT = room > 0 ? Math.round(entry + ((hover.side === 'buy' ? -1 : 1) * room) / units / tick) : undefined;
    return { side: hover.side, entry, ...br, failT };
  })();
  const pnlAt = (t: number): number | undefined =>
    pos.qty !== 0
      ? rowPnlUsd(pos.qty, pos.avgTicks, t, tick)
      : preview
        ? rowPnlUsd(preview.side === 'buy' ? units : -units, preview.entry, t, tick)
        : undefined;
  const failRow = failTicksPos ?? preview?.failT;
  const implied = s.showIndexRef && m.impliedTicks !== undefined ? Math.round(m.impliedTicks) : undefined;
  const markers = [
    ...orders.map((o) => ({ label: o.leg ? o.leg.toUpperCase() : o.type === 'stop' ? 'STP' : 'LMT', ticks: o.priceTicks })),
    ...(failRow !== undefined ? [{ label: 'FAIL', ticks: failRow }] : []),
    ...(preview?.tpTicks !== undefined ? [{ label: 'TP?', ticks: preview.tpTicks }] : []),
    ...(preview?.slTicks !== undefined ? [{ label: 'SL?', ticks: preview.slTicks }] : []),
  ];
  const pinned = center === null ? [] : offscreen(markers, lo, hi);
  const pinRow = (p: (typeof pinned)[number]) => {
    const pnl = pnlAt(p.ticks);
    return (
      <div
        key={`${p.label}${p.ticks}`}
        className={`pin ${p.label.startsWith('FAIL') ? 'fail' : p.label.startsWith('TP') ? 'tp' : p.label.startsWith('SL') ? 'sl' : ''}`}
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
  const rt = spread !== undefined && refPx ? roundTripCost(units, spread, tick, refPx, Number(m.info?.takerFee ?? 0) || 0) : undefined;

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
          className={`ladder ${pos.qty || preview ? '' : 'no-pnl'} ${s.showDelta ? 'with-delta' : ''}`}
          onMouseLeave={() => setHover(null)}
          onWheel={(e) => {
            if (center === null) return;
            detachBriefly();
            setCenter(center + (e.deltaY < 0 ? 2 : -2) * g);
          }}
        >
          <div
            className="lrow head"
            title="click = limit · shift+click = stop · chip: click cancel / drag move · wheel scroll · space recentre · F flatten · Esc cancel"
          >
            <span>buy</span>
            <span>bid</span>
            <span title="wheel over the price column to group rows">
              {follow ? (
                <>price{g > 1 ? ` ×${g} (${(g * tick).toFixed(dec)})` : ''}</>
              ) : (
                <button className="follow-pill" onClick={resumeFollow} title="back to the market now (Space); resumes by itself 3 s after you stop scrolling">
                  ▶ FOLLOW
                </button>
              )}
            </span>
            <span>ask</span>
            <span>sell</span>
            <span>{pos.qty ? 'P&L' : preview ? 'if…' : 'P&L'}</span>
            <span title="volume traded at each price since the panel opened · bright = POC · lighter = 70% value area">vol</span>
            {s.showDelta && (
              <span title="Δ = aggressive buys − aggressive sells at each price (cyan +, orange −). Header = session cumulative delta. Click to hide." className={`dhead ${m.cumDelta >= 0 ? 'up' : 'dn'}`} onClick={() => update({ showDelta: false })}>
                Δ {`${m.cumDelta >= 0 ? '+' : ''}${m.cumDelta.toFixed(2)}`}
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
            const pnl = pnlAt(t);
            const cls = [
              'lrow',
              t === bk(bid) ? 'best-bid' : '',
              t === bk(ask) ? 'best-ask' : '',
              t === bk(m.lastTradeTicks) ? 'last' : '',
              t === bk(avgRow) ? 'avg' : '',
              t === bk(failRow) ? 'fail' : '',
              preview && t === bk(preview.entry) ? 'pv-entry' : '',
              preview && t === bk(preview.tpTicks) ? 'pv-tp' : '',
              preview && t === bk(preview.slTicks) ? 'pv-sl' : '',
              bid !== undefined && ask !== undefined && t > bk(bid)! && t + g - 1 < ask ? 'inside' : '',
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
            const enterBuy = () => setHover({ t, side: 'buy' });
            const enterSell = () => setHover({ t, side: 'sell' });
            return (
              <div key={t} className={cls} onPointerUp={drop}>
                <span className="orders buy" title={live ? 'LIVE: click = limit order on Vest (shift-click stops are paper-only: Vest has no stop entries)' : undefined} onMouseEnter={enterBuy} onClick={(e) => place('buy', t, e.shiftKey)}>
                  {ordersAt(t, 'buy').map(orderChip)}
                </span>
                <span className="size bid" onMouseEnter={enterBuy} onClick={(e) => place('buy', t, e.shiftKey)}>
                  {b !== undefined && <i style={{ width: `${(b / maxSize) * 100}%` }} />}
                  <em>{b !== undefined ? (s.ladderUsd ? fmtK(b * t * tick) : b.toFixed(2)) : ''}</em>
                </span>
                <span
                  className="price"
                  onMouseEnter={() => setHover(null)}
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
                </span>
                <span className="size ask" onMouseEnter={enterSell} onClick={(e) => place('sell', t, e.shiftKey)}>
                  {a !== undefined && <i style={{ width: `${(a / maxSize) * 100}%` }} />}
                  <em>{a !== undefined ? (s.ladderUsd ? fmtK(a * t * tick) : a.toFixed(2)) : ''}</em>
                </span>
                <span className="orders sell" title={live ? 'LIVE: click = limit order on Vest (shift-click stops are paper-only: Vest has no stop entries)' : undefined} onMouseEnter={enterSell} onClick={(e) => place('sell', t, e.shiftKey)}>
                  {ordersAt(t, 'sell').map(orderChip)}
                </span>
                <span className={`pnl ${pnl === undefined ? '' : pnlClass(pnl)}`}>{pnl === undefined ? '' : fmtUsd(pnl)}</span>
                <span className={`vol ${volCls}`} title={t === prof.poc ? 'POC — most traded price this session' : volCls === 'va' ? 'inside the 70% value area' : undefined}>
                  {v !== undefined && <i style={{ width: `${(v / maxVol) * 100}%` }} />}
                  <em>{v !== undefined ? v.toFixed(2) : ''}</em>
                </span>
                {s.showDelta && (
                  <span className={`delta ${dl === undefined ? '' : dl >= 0 ? 'up' : 'dn'}`}>
                    {dl !== undefined && dl !== 0 && <i style={{ width: `${(Math.abs(dl) / maxDelta) * 50}%` }} />}
                    <em>{dl !== undefined && Math.abs(dl) >= 0.005 ? `${dl > 0 ? '+' : ''}${dl.toFixed(2)}` : ''}</em>
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
              {!s.showDelta && (
                <button className="mini" title="show the Δ (delta) column on the ladder" onClick={() => update({ showDelta: true })}>
                  Δ
                </button>
              )}
            </h4>
            {m.tape.slice(0, s.showLog ? 40 : 120).map((r) => (
              <div key={r.id} className={`trow ${r.side}`}>
                <span>{new Date(r.time).toLocaleTimeString([], { hour12: false })}</span>
                <span>{formatPrice(r.priceTicks, tick)}</span>
                <span>{r.qty.toFixed(4)}</span>
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
          {rt && units > 0 && (
            <span className={ddLeft > 0 && rt.totalUsd / ddLeft > 0.1 ? 'neg' : ''} title={`spread $${rt.spreadUsd.toFixed(2)} + 2 × taker fee $${(rt.feesUsd / 2).toFixed(2)}`}>
              round trip ${rt.totalUsd.toFixed(2)}
              {ddLeft > 0 ? ` (${((rt.totalUsd / ddLeft) * 100).toFixed(0)}% of DD left)` : ''}
            </span>
          )}
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
        <div className="buttons">
          <button
            className="buy"
            disabled={live ? bid === undefined || ask === undefined || units <= 0 || L.busy : !broker?.hasBook || m.failed || units <= 0}
            onClick={() => market('buy')}
          >
            BUY MKT
          </button>
          <button
            className="sell"
            disabled={live ? bid === undefined || ask === undefined || units <= 0 || L.busy : !broker?.hasBook || m.failed || units <= 0}
            onClick={() => market('sell')}
          >
            SELL MKT
          </button>
          <button disabled={!pos.qty} onClick={breakevenNow}>
            B/E
          </button>
          <button disabled={!pos.qty || live} title={live ? 'paper-only in LIVE v1' : undefined} onClick={reverse}>
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
