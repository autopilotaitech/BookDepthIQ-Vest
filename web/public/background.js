// Clicking the toolbar icon opens the panel in its own window (or focuses the one already open).
let panelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch {
      panelWindowId = null; // it was closed
    }
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 760,
    height: 980,
  });
  panelWindowId = w.id ?? null;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

// ── Vest user token (LIVE-ORDERS-SPEC §1, §5.5) ──
// Kept in chrome.storage.session only: memory, never disk, gone when Chrome closes, and readable
// only by extension pages (not content scripts). Never logged.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// An extension reload wipes storage.session and orphans the hook in Vest tabs that are already
// open, so LIVE would lose the login until the user reloads Vest. Re-inject the same two content
// scripts into those tabs instead; the hook then picks up the token from Vest's next request.
async function reinjectVestTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://next.vestmarkets.com/*' });
    for (const t of tabs) {
      if (t.id === undefined) continue;
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['vest-hook.js'], world: 'MAIN' }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['vest-relay.js'] }).catch(() => {});
    }
  } catch {
    /* no Vest tab open: the manifest content scripts cover the next one */
  }
}
chrome.runtime.onInstalled.addListener(() => void reinjectVestTabs());
chrome.runtime.onStartup.addListener(() => void reinjectVestTabs());

function userClaims(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only our own content script, running in a next.vestmarkets.com tab.
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab || !String(sender.url || '').startsWith('https://next.vestmarkets.com/')) return;
  if (msg.type === 'vest-hook-status') {
    // Counts and claim NAMES only — rebuilt field by field so nothing else can ride along.
    const st = msg.status || {};
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const keys = Array.isArray(st.rejectedKeys) ? st.rejectedKeys.slice(0, 30).map((k) => String(k).slice(0, 40)) : [];
    chrome.storage.session
      .set({ vestHookStatus: { at: Date.now(), apiCalls: n(st.apiCalls), bearer: n(st.bearer), accepted: n(st.accepted), rejectedKeys: keys, reason: String(st.reason || '').slice(0, 60) } })
      .catch(() => {});
    return;
  }
  if (msg.type !== 'vest-user-token' || typeof msg.token !== 'string') return;
  const c = userClaims(msg.token);
  if (!c || c.userId == null || 'accountId' in c || typeof c.exp !== 'number' || c.exp * 1000 <= Date.now()) return;
  chrome.storage.session.set({ vestUserToken: msg.token }).catch(() => {});
});
