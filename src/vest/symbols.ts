import type { SymbolInfo } from './types.js';

// Vest's UI and docs say "NQ-PERP", but the API only answers to the wire symbol
// "NDX-USD-PERP" — asking for NQ-PERP returns {"code":1121,"msg":"unknown symbol"}.
// Always resolve through exchangeInfo; never hardcode the wire name at a call site.

export interface SymbolTable {
  /** Accepts either the display symbol ("NQ-PERP") or the wire symbol ("NDX-USD-PERP"). */
  resolve(name: string): SymbolInfo | undefined;
  all(): SymbolInfo[];
}

export function buildSymbolTable(infos: SymbolInfo[]): SymbolTable {
  const byName = new Map<string, SymbolInfo>();
  for (const info of infos) {
    byName.set(info.symbol.toUpperCase(), info);
    if (info.displaySymbol) {
      const key = info.displaySymbol.toUpperCase();
      // A display name that collides with another symbol's wire name must not shadow it.
      if (!byName.has(key)) byName.set(key, info);
    }
  }
  return {
    resolve: (name) => byName.get(name.trim().toUpperCase()),
    all: () => infos.slice(),
  };
}

/** The finest tick the venue accepts. Falls back to priceDecimals when no tick list is sent. */
export function tickSizeOf(info: SymbolInfo): number {
  const t = Number(info.minTickSize ?? info.defaultTickSize ?? info.tickSizes?.[0]);
  if (Number.isFinite(t) && t > 0) return t;
  return 10 ** -info.priceDecimals;
}
