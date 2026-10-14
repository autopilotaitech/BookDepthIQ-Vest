import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from './settings';
import { parseBands, type IndicatorCfg } from '../src/panel/indicators';
import { EVAL_PACKAGES, INSTANT_MAX_LEV, INSTANT_PACKAGES } from '../src/panel/riskcalc';
import { normHex, overridesOf, PRESETS, resolved, TOKENS } from './theme';

// Settings, flight-panel style (owner, 2026-10-13, as in the NT DOM): a section rail on the left, one
// section at a time as cards of rows — name and a one-line hint on the left, the control on the right.
// Every change applies at once (the panel's settings always have); colours preview live.

type Upd = (p: Partial<Settings>) => void;

interface Props {
  s: Settings;
  update: Upd;
  ind: IndicatorCfg;
  setInd: (p: Partial<IndicatorCfg>) => void;
  profileNote: string;
  resetPaper: () => void;
  onClose: () => void;
}

function Row(p: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="sv-row">
      <div className="sv-l">
        <span>{p.label}</span>
        {p.hint && <small>{p.hint}</small>}
      </div>
      <div className="sv-c">{p.children}</div>
    </div>
  );
}

function Card(p: { title: string; children: ReactNode }) {
  return (
    <div className="sv-card">
      <div className="sv-ct">{p.title}</div>
      {p.children}
    </div>
  );
}

function Switch(p: { on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button className={`sv-sw ${p.on ? 'on' : ''}`} disabled={p.disabled} onClick={() => p.set(!p.on)}>
      {p.on ? 'ON' : 'OFF'}
    </button>
  );
}

function Segs<T extends string | number>(p: { value: T; options: Array<[T, string]>; set: (v: T) => void }) {
  return (
    <div className="seg sv-seg">
      {p.options.map(([v, l]) => (
        <button key={String(v)} className={v === p.value ? 'on' : ''} onClick={() => p.set(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** A number box that keeps its own text while typing and commits valid numbers. */
function Num(p: { value: number; set: (v: number) => void; step?: number; min?: number; wide?: boolean }) {
  const [t, setT] = useState(String(p.value));
  useEffect(() => setT(String(p.value)), [p.value]);
  return (
    <input
      className={`sv-in num ${p.wide ? 'wide' : ''}`}
      type="number"
      step={p.step ?? 1}
      min={p.min}
      value={t}
      onChange={(e) => {
        setT(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(v)) p.set(p.min !== undefined ? Math.max(p.min, v) : v);
      }}
    />
  );
}

/** A text box committed on blur / Enter. */
function Txt(p: { value: string; set: (v: string) => void; placeholder?: string; width?: number }) {
  const [t, setT] = useState(p.value);
  useEffect(() => setT(p.value), [p.value]);
  return (
    <input
      className="sv-in"
      style={{ width: p.width ?? 110 }}
      value={t}
      placeholder={p.placeholder}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => p.set(t.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** One colour: native picker + hex box + reset to default. Live. */
function Colour(p: { k: string; def: string; value: string; set: (k: string, hex: string) => void }) {
  const [t, setT] = useState(p.value);
  useEffect(() => setT(p.value), [p.value]);
  const commit = (raw: string) => {
    const h = normHex(raw);
    if (h) p.set(p.k, h);
    else setT(p.value);
  };
  return (
    <div className="sv-col">
      <input type="color" value={p.value} onChange={(e) => p.set(p.k, e.target.value)} aria-label="pick a colour" />
      <input className="sv-in hex" value={t} onChange={(e) => setT(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)} />
      <button className="sv-mini" title={`default ${p.def}`} onClick={() => p.set(p.k, p.def)}>
        ↺
      </button>
    </div>
  );
}

const SECTIONS = ['Account', 'Fees & warnings', 'Protect my day', 'Ladder', 'Indicators', 'Opening range', 'Colours'] as const;
type Section = (typeof SECTIONS)[number];

const BLURB: Record<Section, string> = {
  Account: "The PAPER account (copy your Vest screen) and the LIVE size cap. LIVE reads the real account from Vest.",
  'Fees & warnings': 'Warnings never block: one click always sends; the warning shows in the ticket and the order log.',
  'Protect my day': 'Limits apply to NEW entries only. FLATTEN, CANCEL and KILL always work. The day starts 17:00 Chicago.',
  Ladder: 'What the ladder shows and tracks. Drag a column header divider to resize; double-click resets.',
  Indicators: 'VWAP, profile, footprint and big trades: one set for every instrument.',
  'Opening range': 'BookDepthIQ PAXOR, NQ and ES: OR = high/low of the first seconds after the bell, kept until the next weekday bell; EXT rungs every step beyond it.',
  Colours: 'Every colour the panel draws. Changes show at once; ↺ puts one back, RESET puts them all back.',
};

export function SettingsView({ s, update, ind, setInd, profileNote, resetPaper, onClose }: Props) {
  const [sec, setSec] = useState<Section>('Account');
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const colors = resolved(s.colors);
  const setColor = (k: string, hex: string) => update({ colors: overridesOf({ ...colors, [k]: hex }) });
  const presetOn = PRESETS.findIndex((p) => JSON.stringify(overridesOf(resolved(p.colors))) === JSON.stringify(overridesOf(colors)));

  const body: Record<Section, () => ReactNode> = {
    Account: () => (
      <>
        <Card title="PAPER ACCOUNT">
          <Row label="Vest Instant" hint="start value, static drawdown, 25x max">
            <div className="chips">
              {INSTANT_PACKAGES.map((x) => (
                <button key={x.start} className={s.startEquity === x.start && s.maxDrawdownUsd === x.dd ? 'on' : ''} onClick={() => update({ startEquity: x.start, maxDrawdownUsd: x.dd, leverage: INSTANT_MAX_LEV })}>
                  {x.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Vest Capital funding" hint="start value, 6% static drawdown">
            <div className="chips">
              {EVAL_PACKAGES.map((x) => (
                <button key={x.start} className={s.startEquity === x.start && s.maxDrawdownUsd === x.dd ? 'on' : ''} onClick={() => update({ startEquity: x.start, maxDrawdownUsd: x.dd })}>
                  {x.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Start value" hint="$">
            <Num value={s.startEquity} step={0.01} min={0} set={(v) => update({ startEquity: v })} />
          </Row>
          <Row label="Max drawdown" hint="$ to the fail floor">
            <Num value={s.maxDrawdownUsd} step={0.01} min={0} set={(v) => update({ maxDrawdownUsd: v })} />
          </Row>
          <Row label="Leverage" hint="× (paper only)">
            <Num value={s.leverage} min={1} set={(v) => update({ leverage: Math.max(1, v) })} />
          </Row>
          <Row label="Reset the paper account" hint="back to the start value, no positions">
            <button className="sv-btn" onClick={resetPaper}>
              RESET
            </button>
          </Row>
        </Card>
        <Card title="LIVE">
          <Row label="LIVE size cap" hint="largest size a LIVE entry may send, units (0 = off: trading power is the limit)">
            <Num value={s.liveSizeCap} step={0.001} min={0} set={(v) => update({ liveSizeCap: v })} />
          </Row>
        </Card>
      </>
    ),
    'Fees & warnings': () => (
      <Card title="WARNINGS">
        <Row label="Far from market" hint="points; a limit or stop this far warns (0 = 4 × ATR)">
          <Num value={s.ffFarPts} min={0} set={(v) => update({ ffFarPts: v })} />
        </Row>
        <Row label="Size × your normal" hint="a size this many × your last 20 trades warns">
          <Num value={s.ffSizeMult} step={0.5} min={1} set={(v) => update({ ffSizeMult: v })} />
        </Row>
        <Row label="Risk buttons" hint="the one-click $ risk buttons next to the size box">
          <Txt value={s.riskPresets.join(', ')} width={160} set={(v) => update({ riskPresets: v.split(/[\s,]+/).map(Number).filter((x) => x > 0).slice(0, 6) })} />
        </Row>
      </Card>
    ),
    'Protect my day': () => (
      <>
        <Card title="LIMITS">
          <Row label="Daily loss limit" hint="$ (0 = off)">
            <Num value={s.dayLossUsd} min={0} set={(v) => update({ dayLossUsd: v })} />
          </Row>
          <Row label="Max trades a day">
            <Segs value={s.maxTradesDay} options={[[0, 'OFF'], [3, '3'], [5, '5'], [10, '10']]} set={(v) => update({ maxTradesDay: v })} />
          </Row>
          <Row label="Cooldown after a loss">
            <Segs value={s.cooldownSec} options={[[0, 'OFF'], [30, '30 S'], [60, '1 MIN'], [300, '5 MIN']]} set={(v) => update({ cooldownSec: v })} />
          </Row>
        </Card>
        <Card title="AUTO-CLOSE · ACTS WITHOUT A CLICK">
          <Row label="Close open trades at the limit" hint="needs a daily loss limit">
            <Switch on={s.closeAtDayLimit} disabled={!s.dayLossUsd} set={(v) => update({ closeAtDayLimit: v })} />
          </Row>
          <Row label="Close before the weekend lock" hint="5 min before Vest's lock (crypto has none); only while this window is open">
            <Switch on={s.weekendClose} set={(v) => update({ weekendClose: v })} />
          </Row>
        </Card>
      </>
    ),
    Ladder: () => (
      <>
        <Card title="SHOW">
          <Row label="Sizes as" hint="units, or USD notional like Vest's book">
            <Segs value={s.ladderUsd ? 'usd' : 'u'} options={[['u', 'UNITS'], ['usd', 'USD']]} set={(v) => update({ ladderUsd: v === 'usd' })} />
          </Row>
          <Row label="Heat · pull/stack column">
            <Switch on={s.showHeat} set={(v) => update({ showHeat: v })} />
          </Row>
          <Row label="Δ delta column">
            <Switch on={s.showDelta} set={(v) => update({ showDelta: v })} />
          </Row>
          <Row label="SuperTrend lines + badge">
            <Switch on={s.showTrend} set={(v) => update({ showTrend: v })} />
          </Row>
          <Row label="Index marker ◆" hint="index-implied mid; lags Vest by ~600 ms, reference only">
            <Switch on={s.showIndexRef} set={(v) => update({ showIndexRef: v })} />
          </Row>
          <Row label="Canvas ladder (beta)" hint="sharper ladder drawn on one canvas, clicks unchanged; PAPER only — LIVE always uses the standard ladder">
            <Switch on={s.canvasLadder} set={(v) => update({ canvasLadder: v })} />
          </Row>
          <Row label="Fit the bracket on screen" hint="widens the rows so stop and targets show (moves where a click lands)">
            <Switch on={s.fitBracket} set={(v) => update({ fitBracket: v })} />
          </Row>
        </Card>
        <Card title="HEAT · nPOC">
          <Row label="Heat · pull/stack window" hint="how far back the heatmap reaches">
            <Segs value={s.heatMinutes ?? 5} options={[[5, '5M'], [15, '15M'], [30, '30M'], [60, '60M']]} set={(v) => update({ heatMinutes: v })} />
          </Row>
          <Row label="Naked POC lines" hint="each period's POC, drawn only while naked">
            <Switch on={s.npocOn !== false} set={(v) => update({ npocOn: v })} />
          </Row>
          <Row label="nPOC period">
            <Segs value={s.npocMinutes ?? 15} options={[[5, '5M'], [15, '15M'], [30, '30M'], [60, '60M']]} set={(v) => update({ npocMinutes: v })} />
          </Row>
        </Card>
      </>
    ),
    Indicators: () => (
      <>
        <Card title="VWAP">
          <Row label="VWAP + σ bands">
            <Switch on={ind.vwapOn} set={(v) => setInd({ vwapOn: v })} />
          </Row>
          <Row label="Session start" hint="HH:MM">
            <Txt value={ind.vwapStart} width={80} set={(v) => setInd({ vwapStart: v })} />
          </Row>
          <Row label="Session end" hint="HH:MM (earlier than start = crosses midnight)">
            <Txt value={ind.vwapEnd} width={80} set={(v) => setInd({ vwapEnd: v })} />
          </Row>
          <Row label="Time zone">
            <Segs value={ind.vwapTz} options={[['America/New_York', 'NEW YORK'], ['America/Chicago', 'CHICAGO'], ['Europe/London', 'LONDON'], ['UTC', 'UTC']]} set={(v) => setInd({ vwapTz: v })} />
          </Row>
          <Row label="Bands" hint="σ, comma separated (blank = none)">
            <Txt value={ind.vwapBands.join(', ')} width={90} set={(v) => setInd({ vwapBands: parseBands(v) })} />
          </Row>
        </Card>
        <Card title="PROFILE · Δ · FOOTPRINT">
          <Row label="Start time" hint={`HH:MM in the VWAP zone; blank = when the panel opened · ${profileNote}`}>
            <Txt value={ind.profileStart} width={80} placeholder="open" set={(v) => setInd({ profileStart: v })} />
          </Row>
          <Row label="Backfill from history" hint="off = live prints only; on = Vest's public trades from the start time">
            <Switch on={ind.profileHistory} set={(v) => setInd({ profileHistory: v })} />
          </Row>
        </Card>
        <Card title="FOOTPRINT IMBALANCES">
          <Row label="Imbalances">
            <Switch on={ind.fpOn} set={(v) => setInd({ fpOn: v })} />
          </Row>
          <Row label="Ratio" hint="3 = 3:1 diagonal">
            <Num value={ind.fpRatio} step={0.5} min={1.5} set={(v) => setInd({ fpRatio: v })} />
          </Row>
          <Row label="Min row volume" hint="% of the busiest row">
            <Num value={ind.fpMinPct} min={0} set={(v) => setInd({ fpMinPct: v })} />
          </Row>
          <Row label="Stack" hint="imbalances in a row that make a zone">
            <Num value={ind.fpStack} min={2} set={(v) => setInd({ fpStack: Math.round(v) })} />
          </Row>
          <Row label="Stack zones as lines">
            <Switch on={ind.fpLines} set={(v) => setInd({ fpLines: v })} />
          </Row>
        </Card>
        <Card title="BIG TRADES">
          <Row label="Big trades on the tape">
            <Switch on={ind.bigOn} set={(v) => setInd({ bigOn: v })} />
          </Row>
          <Row label="Big trade" hint="≥ units (one set for every market: retune when you switch)">
            <Num value={ind.bigMin} step={0.5} min={0} set={(v) => setInd({ bigMin: v })} />
          </Row>
        </Card>
      </>
    ),
    'Opening range': () => (
      <>
        <Card title="OPENING RANGE">
          <Row label="Opening range on the ladder" hint="OR H (blue), OR L (red), dashed while forming">
            <Switch on={ind.orOn} set={(v) => setInd({ orOn: v })} />
          </Row>
          <Row label="Mid line" hint="OR MID (gold)">
            <Switch on={ind.orMid} set={(v) => setInd({ orMid: v })} />
          </Row>
        </Card>
        <Card title="WINDOW">
          <Row label="Bell" hint="HH:MM:SS (default 08:30:00)">
            <Txt value={ind.orStart} width={90} set={(v) => setInd({ orStart: v })} />
          </Row>
          <Row label="Window" hint="seconds after the bell (default 30)">
            <Num value={ind.orSec} min={1} set={(v) => setInd({ orSec: Math.round(v) })} />
          </Row>
          <Row label="Time zone" hint="default Chicago">
            <Segs value={ind.orTz} options={[['America/Chicago', 'CHICAGO'], ['America/New_York', 'NEW YORK'], ['UTC', 'UTC']]} set={(v) => setInd({ orTz: v })} />
          </Row>
        </Card>
        <Card title="EXT RUNGS">
          <Row label="NQ step" hint="points (default 65)">
            <Num value={ind.orNqPts} min={1} set={(v) => setInd({ orNqPts: v })} />
          </Row>
          <Row label="ES step" hint="points (default 15)">
            <Num value={ind.orEsPts} min={1} set={(v) => setInd({ orEsPts: v })} />
          </Row>
        </Card>
      </>
    ),
    Colours: () => (
      <>
        <Card title="SCHEME">
          <Row label="Preset" hint="a starting point; tune any colour below">
            <Segs value={presetOn} options={PRESETS.map((p, i) => [i, p.name.toUpperCase()] as [number, string])} set={(i) => update({ colors: overridesOf(resolved(PRESETS[i]!.colors)) })} />
          </Row>
          <Row label="Reset all" hint="back to the panel's own colours">
            <button className="sv-btn" onClick={() => update({ colors: {} })}>
              RESET
            </button>
          </Row>
        </Card>
        {[...new Set(TOKENS.map((t) => t.group))].map((g) => (
          <Card key={g} title={g.toUpperCase()}>
            {TOKENS.filter((t) => t.group === g).map((t) => (
              <Row key={t.key} label={t.label} hint={t.tip}>
                <Colour k={t.key} def={t.def} value={colors[t.key]!} set={setColor} />
              </Row>
            ))}
          </Card>
        ))}
      </>
    ),
  };

  return (
    <div className="sv" role="dialog" aria-label="Settings">
      <nav className="sv-rail">
        <b>SETTINGS</b>
        {SECTIONS.map((x) => (
          <button key={x} className={x === sec ? 'on' : ''} onClick={() => setSec(x)}>
            {x.toUpperCase()}
          </button>
        ))}
      </nav>
      <main className="sv-main">
        <header className="sv-head">
          <div>
            <h2>{sec}</h2>
            <p>{BLURB[sec]}</p>
          </div>
          <button className="sv-done" onClick={onClose} title="Esc">
            DONE
          </button>
        </header>
        <div className="sv-body">{body[sec]()}</div>
      </main>
    </div>
  );
}
