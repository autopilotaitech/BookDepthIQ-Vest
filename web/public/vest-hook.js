// MAIN-world content script on next.vestmarkets.com (document_start). LIVE-ORDERS-SPEC §1.
//
// It only OBSERVES the Authorization header the Vest page itself puts on its own api-gateway
// requests. It never sends a request, never alters one, never reads cookies or storage, and only
// forwards a USER token (claims: userId, no accountId, an unexpired exp). The token goes to the
// isolated relay via window.postMessage, and to the extension panel when it asks via peek().
(() => {
  // Re-injected after an extension reload: the hook already in the page keeps observing and
  // re-announces what it has to the new relay (Vest sends its token mostly at page load).
  if (window.__bdiqvestHook) {
    if (window.__bdiqvestHook.announce) window.__bdiqvestHook.announce();
    return;
  }
  const API = 'https://api-gateway.hz.vestmarkets.com/';
  const TAG = 'bdiqvest-hook';
  let last = null;
  // Re-sends the last accepted (still unexpired) token and the status. Called on re-injection and
  // when a relay says hello, so the panel recovers without waiting for Vest's next request.
  function announce() {
    lastStat = '';
    report();
    if (!last) return;
    const c = claims(last);
    if (c && typeof c.exp === 'number' && c.exp * 1000 > Date.now()) window.postMessage({ source: TAG, kind: 'user-token', token: last }, window.location.origin);
    else last = null;
  }
  // peek(): read by the extension PANEL itself via chrome.scripting (MAIN world), so LIVE does not
  // depend on the relay → service worker → storage chain. Same token the page already holds.
  function peek() {
    let token = null;
    if (last) {
      const c = claims(last);
      if (c && typeof c.exp === 'number' && c.exp * 1000 > Date.now()) token = last;
    }
    return { token, status: { ...stat } };
  }
  // Vest's OWN order writes (its ticket), recorded so the panel can copy their exact shape instead
  // of guessing (CLAUDE.md rule 3). Path, body and Vest's reply only; secret-looking keys and
  // anything JWT-shaped are blanked. Never headers, never auth endpoints. Last 30 in memory.
  const writes = [];
  const SECRET = /token|apikey|api_key|secret|authorization|password|signature/i;
  function scrub(text) {
    let out = String(text ?? '');
    try {
      const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x === 'string' ? '<redacted>' : walk(x)])) : v);
      out = JSON.stringify(walk(JSON.parse(out)));
    } catch {
      /* not JSON */
    }
    return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>').slice(0, 3000);
  }
  function recordWrite(method, url, body) {
    try {
      const m = String(method || 'GET').toUpperCase();
      const u = String(url);
      if (m === 'GET' || !u.startsWith(API)) return null;
      const path = u.slice(API.length - 1).replace(/\?.*/, '');
      if (!/^\/v3\/positions\//.test(path)) return null; // order writes only — no market-hours noise
      const rec = { at: Date.now(), method: m, path, body: typeof body === 'string' ? scrub(body) : body == null ? '' : '<non-text body>', status: 0, resp: '' };
      writes.push(rec);
      if (writes.length > 30) writes.shift();
      return rec;
    } catch {
      return null;
    }
  }
  Object.defineProperty(window, '__bdiqvestHook', {
    value: { announce: () => announce(), peek: () => peek(), writes: () => writes.map((w) => ({ ...w })) },
  });
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.source === 'bdiqvest-relay' && ev.data.kind === 'hello') announce();
  });

  function claims(token) {
    try {
      const part = token.split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch {
      return null;
    }
  }

  // Diagnostics for the panel: counts and claim NAMES only, never a token or a claim value.
  const stat = { apiCalls: 0, bearer: 0, accepted: 0, rejectedKeys: [], reason: '' };
  let lastStat = '';
  function report() {
    const j = JSON.stringify(stat);
    if (j === lastStat) return;
    lastStat = j;
    window.postMessage({ source: TAG, kind: 'hook-status', status: { ...stat } }, window.location.origin);
  }

  function consider(url, auth) {
    try {
      if (!String(url).startsWith(API)) return;
      stat.apiCalls++;
      if (stat.apiCalls === 1) report(); // proves the hook is running on this tab
      if (typeof auth !== 'string' || !/^Bearer\s+/i.test(auth)) return;
      stat.bearer++;
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token === last) return;
      const c = claims(token);
      const isUser = c && c.userId != null && !('accountId' in c) && typeof c.exp === 'number' && c.exp * 1000 > Date.now();
      if (!isUser) {
        stat.rejectedKeys = c ? Object.keys(c).slice(0, 30) : [];
        stat.reason = !c ? 'not a JWT' : c.userId == null ? 'no userId claim' : 'accountId' in c ? 'has accountId (account token)' : typeof c.exp !== 'number' ? 'no exp claim' : 'expired';
        report();
        return;
      }
      last = token;
      stat.accepted++;
      stat.reason = '';
      report();
      window.postMessage({ source: TAG, kind: 'user-token', token }, window.location.origin);
    } catch {
      /* observing must never break the page */
    }
  }

  function headerOf(h, name) {
    if (!h) return undefined;
    if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) ?? undefined;
    if (Array.isArray(h)) {
      const e = h.find((p) => String(p[0]).toLowerCase() === name.toLowerCase());
      return e ? e[1] : undefined;
    }
    for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return h[k];
    return undefined;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const url = isReq ? input.url : String(input);
      const auth = headerOf(init && init.headers, 'authorization') ?? (isReq ? input.headers.get('authorization') ?? undefined : undefined);
      consider(url, auth);
      const rec = recordWrite((init && init.method) || (isReq ? input.method : 'GET'), url, init && init.body);
      if (rec) {
        const p = Reflect.apply(origFetch, this, arguments);
        p.then((res) => res.clone().text().then((t) => { rec.status = res.status; rec.resp = scrub(t); })).catch(() => {});
        return p;
      }
    } catch {
      /* ignore */
    }
    return Reflect.apply(origFetch, this, arguments);
  };

  const urls = new WeakMap();
  const methods = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      urls.set(this, String(url));
      methods.set(this, String(method));
    } catch {
      /* ignore */
    }
    return Reflect.apply(origOpen, this, arguments);
  };
  const authed = new WeakSet();
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === 'authorization') {
      authed.add(this);
      consider(urls.get(this), value);
    }
    return Reflect.apply(origSet, this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (!authed.has(this)) consider(urls.get(this), undefined);
    try {
      const rec = recordWrite(methods.get(this), urls.get(this), body);
      if (rec) this.addEventListener('loadend', () => { rec.status = this.status; rec.resp = scrub(this.responseText); });
    } catch {
      /* observing must never break the page */
    }
    return Reflect.apply(origSend, this, arguments);
  };
})();
