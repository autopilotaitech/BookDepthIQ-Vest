// The colour scheme (owner, 2026-10-13, as in the NT DOM): every colour the panel draws is a named token,
// a CSS custom property on :root (styles.css holds the defaults, which are the panel's own colours). The
// user can change any of them in Settings › Colours; applyTheme writes the overrides onto <html>, so the
// whole panel repaints live. Each token also gets an "r, g, b" twin (--bid-rgb) for translucent fills.

export interface Token {
  key: string;
  group: string;
  label: string;
  def: string;
  tip?: string;
}

export const TOKENS: Token[] = [
  { key: 'bg', group: 'Surfaces', label: 'Background', def: '#0b0e13' },
  { key: 'panel', group: 'Surfaces', label: 'Header & panels', def: '#121722' },
  { key: 'card', group: 'Surfaces', label: 'Cards', def: '#0f141d' },
  { key: 'field', group: 'Surfaces', label: 'Input fields', def: '#0a0e15' },
  { key: 'edge', group: 'Surfaces', label: 'Card & field borders', def: '#1c2433' },
  { key: 'line', group: 'Surfaces', label: 'Dividers', def: '#1f2633' },
  { key: 'row-line', group: 'Surfaces', label: 'Ladder row lines', def: '#161b25' },
  { key: 'hover', group: 'Surfaces', label: 'Hover cell', def: '#1a2130' },

  { key: 'text', group: 'Text', label: 'Text', def: '#d7dde8' },
  { key: 'muted', group: 'Text', label: 'Labels', def: '#7b8597' },
  { key: 'accent', group: 'Text', label: 'Accent', def: '#38bdf8', tip: 'brand, selected controls' },
  { key: 'seg-on', group: 'Text', label: 'Selected background', def: '#16324a' },

  { key: 'bid', group: 'Market', label: 'Bid / buyers', def: '#22d3ee' },
  { key: 'ask', group: 'Market', label: 'Ask / sellers', def: '#fb923c' },
  { key: 'pos', group: 'Market', label: 'Profit / up', def: '#34d399' },
  { key: 'neg', group: 'Market', label: 'Loss / down', def: '#f87171' },
  { key: 'warn', group: 'Market', label: 'Warning', def: '#fbbf24' },
  { key: 'last', group: 'Market', label: 'Last price outline', def: '#facc15' },

  { key: 'vwap', group: 'Chart lines', label: 'VWAP + σ bands', def: '#c084fc' },
  { key: 'npoc', group: 'Chart lines', label: 'Naked POC', def: '#f472b6' },
  { key: 'or-high', group: 'Chart lines', label: 'OR high + EXT up', def: '#00bfff' },
  { key: 'or-low', group: 'Chart lines', label: 'OR low + EXT down', def: '#ff4500' },
  { key: 'or-mid', group: 'Chart lines', label: 'OR mid', def: '#ffd700' },
  { key: 'st-up', group: 'Chart lines', label: 'SuperTrend up', def: '#22c55e' },
  { key: 'st-dn', group: 'Chart lines', label: 'SuperTrend down', def: '#ef4444' },
  { key: 'no-chase', group: 'Chart lines', label: 'No-chase line', def: '#f59e0b' },
  { key: 'range', group: 'Chart lines', label: 'Chop range lines', def: '#fbbf24' },
  { key: 'stack-buy', group: 'Chart lines', label: 'Buy stack zone', def: '#38bdf8' },
  { key: 'stack-sell', group: 'Chart lines', label: 'Sell stack zone', def: '#f59e5b' },
  { key: 'br-in', group: 'Chart lines', label: 'Entry line', def: '#94a3b8' },

  { key: 'prof-bar', group: 'Profile · Δ · heat', label: 'Profile bars', def: '#606a7a' },
  { key: 'prof-va', group: 'Profile · Δ · heat', label: 'Profile value area', def: '#96a0b2' },
  { key: 'prof-poc', group: 'Profile · Δ · heat', label: 'Profile POC', def: '#e4e8f0' },
  { key: 'delta-up', group: 'Profile · Δ · heat', label: 'Δ buyers', def: '#22d3ee' },
  { key: 'delta-dn', group: 'Profile · Δ · heat', label: 'Δ sellers', def: '#fb923c' },
  { key: 'heat-bid', group: 'Profile · Δ · heat', label: 'Heat bid size', def: '#22d3ee' },
  { key: 'heat-ask', group: 'Profile · Δ · heat', label: 'Heat offer size', def: '#fb923c' },
  { key: 'heat-hot', group: 'Profile · Δ · heat', label: 'Heat wall', def: '#fde68a' },

  { key: 'buy-btn', group: 'Buttons', label: 'BUY MKT', def: '#0e3a44' },
  { key: 'sell-btn', group: 'Buttons', label: 'SELL MKT', def: '#44250e' },
  { key: 'flat-btn', group: 'Buttons', label: 'FLATTEN', def: '#4a1414' },
  { key: 'kill-btn', group: 'Buttons', label: 'KILL', def: '#5a1414' },
  { key: 'btn', group: 'Buttons', label: 'Other buttons', def: '#1a2130' },

  { key: 'big-buy', group: 'Tape & log', label: 'Big buy print', def: '#38bdf8' },
  { key: 'big-sell', group: 'Tape & log', label: 'Big sell print', def: '#f59e5b' },
  { key: 'log-ok', group: 'Tape & log', label: 'Log: sent / filled', def: '#2ec4b6' },
  { key: 'log-blocked', group: 'Tape & log', label: 'Log: warned / blocked', def: '#f0b429' },
  { key: 'log-bad', group: 'Tape & log', label: 'Log: refused', def: '#ff5c5c' },
];

/** Starting points; choosing one replaces the user's colours (then any token can be tuned). */
export const PRESETS: Array<{ name: string; colors: Record<string, string> }> = [
  { name: 'Default', colors: {} },
  {
    name: 'Midnight',
    colors: { bg: '#05070c', panel: '#0b1020', card: '#0a0f1c', field: '#060914', edge: '#18213a', line: '#1a2440', 'row-line': '#0f1526', hover: '#141d36', accent: '#60a5fa', 'seg-on': '#142a52', btn: '#141d36' },
  },
  {
    name: 'Graphite',
    colors: { bg: '#121212', panel: '#1b1b1d', card: '#18181a', field: '#101011', edge: '#2c2c30', line: '#2a2a2e', 'row-line': '#1d1d20', hover: '#252528', text: '#e6e6e6', muted: '#8e8e93', accent: '#0a84ff', 'seg-on': '#1c3352', btn: '#262629' },
  },
  {
    name: 'High contrast',
    colors: {
      bg: '#000000', panel: '#0a0a0a', card: '#050505', field: '#020202', edge: '#3a3a3a', line: '#333333', 'row-line': '#1a1a1a', hover: '#262626', text: '#ffffff', muted: '#b0b0b0',
      accent: '#00b4ff', 'seg-on': '#00324a', bid: '#00e5ff', ask: '#ff8c00', pos: '#00ff88', neg: '#ff4d4d', warn: '#ffd400', 'heat-bid': '#00e5ff', 'heat-ask': '#ff8c00', btn: '#1f1f1f',
    },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** "#22d3ee" → "34, 211, 238" (for rgba(var(--bid-rgb), a)). */
export function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** "22d3ee" or "#22D3EE" → "#22d3ee"; anything else → undefined. */
export function normHex(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  const h = t.startsWith('#') ? t : `#${t}`;
  return HEX.test(h) ? h : undefined;
}

/** The colour each token resolves to: the user's override, else the default. */
export function resolved(overrides: Record<string, string> | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of TOKENS) o[t.key] = normHex(overrides?.[t.key] ?? '') ?? t.def;
  return o;
}

/** Only the tokens that differ from their default (what Settings saves). */
export function overridesOf(colors: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of TOKENS) {
    const h = normHex(colors[t.key] ?? '');
    if (h && h !== t.def) o[t.key] = h;
  }
  return o;
}

/** Write every token (and its -rgb twin) onto <html>. Live: the panel repaints at once. */
export function applyTheme(overrides: Record<string, string> | undefined, el: HTMLElement | undefined = typeof document !== 'undefined' ? document.documentElement : undefined): void {
  if (!el) return;
  const r = resolved(overrides);
  for (const t of TOKENS) {
    el.style.setProperty(`--${t.key}`, r[t.key]!);
    el.style.setProperty(`--${t.key}-rgb`, rgbOf(r[t.key]!));
  }
}
