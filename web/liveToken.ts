// Reads the Vest user token that background.js keeps in chrome.storage.session (memory only).
// Outside the extension (vite dev server) there is no token and LIVE stays unavailable.

type SessionArea = {
  get(key: string): Promise<Record<string, unknown>>;
};
type ChromeLike = {
  storage?: {
    session?: SessionArea;
    onChanged?: { addListener(fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void; removeListener(fn: unknown): void };
  };
};

const KEY = 'vestUserToken';
const STATUS_KEY = 'vestHookStatus';

/** What the Vest-tab hook has seen: counts and claim NAMES only, never a token. */
export interface HookStatus {
  at: number;
  apiCalls: number;
  bearer: number;
  accepted: number;
  rejectedKeys: string[];
  reason: string;
}

export function watchHookStatus(cb: (s: HookStatus | null) => void): () => void {
  const chrome = (globalThis as { chrome?: ChromeLike }).chrome;
  const area = chrome?.storage?.session;
  const onChanged = chrome?.storage?.onChanged;
  if (!area || !onChanged) {
    cb(null);
    return () => {};
  }
  area
    .get(STATUS_KEY)
    .then((r) => cb((r[STATUS_KEY] as HookStatus | undefined) ?? null))
    .catch(() => cb(null));
  const fn = (changes: Record<string, { newValue?: unknown }>, name: string) => {
    if (name === 'session' && STATUS_KEY in changes) cb((changes[STATUS_KEY]!.newValue as HookStatus | undefined) ?? null);
  };
  onChanged.addListener(fn);
  return () => onChanged.removeListener(fn);
}

export function watchUserToken(cb: (token: string | null) => void): () => void {
  const chrome = (globalThis as { chrome?: ChromeLike }).chrome;
  const area = chrome?.storage?.session;
  const onChanged = chrome?.storage?.onChanged;
  if (!area || !onChanged) {
    cb(null);
    return () => {};
  }
  area
    .get(KEY)
    .then((r) => cb(typeof r[KEY] === 'string' ? (r[KEY] as string) : null))
    .catch(() => cb(null));
  const fn = (changes: Record<string, { newValue?: unknown }>, name: string) => {
    if (name !== 'session' || !(KEY in changes)) return;
    const v = changes[KEY]!.newValue;
    cb(typeof v === 'string' ? v : null);
  };
  onChanged.addListener(fn);
  return () => onChanged.removeListener(fn);
}

// ── Direct read from open Vest tabs ──
// The panel asks each next.vestmarkets.com tab's hook for its token itself (chrome.scripting,
// MAIN world), so LIVE does not depend on the relay → service worker → storage.session chain.
// A tab without the hook (opened before the extension loaded) gets it injected; it captures the
// token on Vest's next request.

type TabsLike = { query(q: { url: string }): Promise<{ id?: number }[]> };
type ScriptingLike = {
  executeScript(o: { target: { tabId: number }; world?: 'MAIN' | 'ISOLATED'; func?: () => unknown; files?: string[] }): Promise<{ result?: unknown }[]>;
};

export interface VestTabsRead {
  /** Open next.vestmarkets.com tabs in THIS Chrome profile. */
  tabs: number;
  /** Tabs whose hook answered. */
  hooked: number;
  token: string | null;
  status: HookStatus | null;
  /** Vest's own ticket writes seen in the tabs (path, redacted body, reply). */
  writes: VestWrite[];
  error?: string;
}

export interface VestWrite {
  at: number;
  method: string;
  path: string;
  body: string;
  status: number;
  resp: string;
}

function peekInPage(): unknown {
  const h = (window as unknown as { __bdiqvestHook?: { peek?: () => object; writes?: () => unknown[] } }).__bdiqvestHook;
  return h && h.peek ? { ...h.peek(), writes: h.writes ? h.writes() : [] } : null;
}

async function readVestTabs(): Promise<VestTabsRead> {
  const chrome = (globalThis as { chrome?: { tabs?: TabsLike; scripting?: ScriptingLike } }).chrome;
  if (!chrome?.tabs || !chrome.scripting) return { tabs: 0, hooked: 0, token: null, status: null, writes: [], error: 'not running as the extension (no chrome.scripting)' };
  const tabs = await chrome.tabs.query({ url: 'https://next.vestmarkets.com/*' });
  const out: VestTabsRead = { tabs: tabs.length, hooked: 0, token: null, status: null, writes: [] };
  for (const t of tabs) {
    if (t.id === undefined) continue;
    try {
      let r = (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: peekInPage }))[0]?.result as
        | { token: string | null; status: Omit<HookStatus, 'at'>; writes?: VestWrite[] }
        | null
        | undefined;
      if (!r) {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', files: ['vest-hook.js'] });
        r = (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: peekInPage }))[0]?.result as typeof r;
      }
      if (!r) continue;
      out.hooked++;
      if (Array.isArray(r.writes)) out.writes.push(...r.writes);
      if (!out.status || r.token) out.status = { at: Date.now(), ...r.status };
      if (r.token && !out.token) out.token = r.token;
    } catch (e) {
      out.error = (e as Error).message;
    }
  }
  return out;
}

export function watchVestTabs(cb: (r: VestTabsRead) => void, everyMs = 3000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const r = await readVestTabs();
      if (!stopped) cb(r);
    } catch (e) {
      if (!stopped) cb({ tabs: 0, hooked: 0, token: null, status: null, writes: [], error: (e as Error).message });
    }
    if (!stopped) timer = setTimeout(run, everyMs);
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
