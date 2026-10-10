// Isolated-world content script on next.vestmarkets.com. Relays the user token that vest-hook.js
// observed to the extension's service worker. It accepts messages only from this same window and
// origin, and only in the hook's exact shape.
// Re-injection after an extension reload runs this again in a fresh isolated world, which is
// what we want: the old relay's chrome.runtime is dead.
window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  const d = ev.data;
  if (!d || d.source !== 'bdiqvest-hook') return;
  let msg = null;
  if (d.kind === 'user-token' && typeof d.token === 'string') msg = { type: 'vest-user-token', token: d.token };
  else if (d.kind === 'hook-status' && d.status && typeof d.status === 'object') msg = { type: 'vest-hook-status', status: d.status };
  if (!msg) return;
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* extension reloaded: this tab needs a refresh */
  }
});
// Ask the hook to re-send what it already has: this relay may be new (extension reloaded) while
// the page, and the token Vest sent at load, are old.
window.postMessage({ source: 'bdiqvest-relay', kind: 'hello' }, window.location.origin);

// The Vest Liquidity Scanner opens /trade/<SYMBOL>#bdiq-switch on a row click: ask the panel to
// switch to that market. Only that marker counts, so browsing Vest never moves the panel. The
// marker is removed so a reload does not switch again.
(() => {
  const m = /^\/trade\/([A-Za-z0-9-]{1,40})\/?$/.exec(window.location.pathname);
  if (window.location.hash !== '#bdiq-switch' || !m) return;
  try {
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
  } catch {
    /* leave the URL */
  }
  try {
    chrome.runtime.sendMessage({ type: 'scanner-switch', symbol: m[1] }).catch(() => {});
  } catch {
    /* extension reloaded: this tab needs a refresh */
  }
})();
