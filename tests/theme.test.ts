import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyTheme, normHex, overridesOf, PRESETS, resolved, rgbOf, TOKENS } from '../web/theme';

describe('colour scheme', () => {
  it('normalises hex and makes rgb twins', () => {
    expect(normHex('22D3EE')).toBe('#22d3ee');
    expect(normHex('#abc')).toBeUndefined();
    expect(normHex('nope')).toBeUndefined();
    expect(rgbOf('#22d3ee')).toBe('34, 211, 238');
  });

  it('resolves overrides on top of the defaults and saves only the differences', () => {
    const r = resolved({ bid: '#00E5FF', junk: '#123456', ask: 'bad' });
    expect(r.bid).toBe('#00e5ff');
    expect(r.ask).toBe(TOKENS.find((t) => t.key === 'ask')!.def);
    expect(overridesOf(r)).toEqual({ bid: '#00e5ff' });
  });

  it('writes every token and its -rgb twin onto the element', () => {
    const set = new Map<string, string>();
    const el = { style: { setProperty: (k: string, v: string) => set.set(k, v) } } as unknown as HTMLElement;
    applyTheme({ neg: '#ff0000' }, el);
    expect(set.get('--neg')).toBe('#ff0000');
    expect(set.get('--neg-rgb')).toBe('255, 0, 0');
    expect(set.size).toBe(TOKENS.length * 2);
  });

  it('every token has a :root default in styles.css equal to theme.ts, and presets name real tokens', () => {
    const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
    for (const t of TOKENS) expect(css).toContain(`--${t.key}: ${t.def};`);
    const keys = new Set(TOKENS.map((t) => t.key));
    for (const p of PRESETS) for (const k of Object.keys(p.colors)) expect(keys.has(k)).toBe(true);
  });

  it('every var(--x) the stylesheet uses is a token (no typo leaves a colour unset)', () => {
    const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
    const keys = new Set(TOKENS.flatMap((t) => [t.key, `${t.key}-rgb`]));
    const extra = new Set(['row-h', 'stc1', 'stc2']);
    const used = [...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.filter((u) => !keys.has(u) && !extra.has(u))).toEqual([]);
  });
});
