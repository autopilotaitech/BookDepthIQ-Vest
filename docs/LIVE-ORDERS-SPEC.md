# Live orders: build spec

**Status: BUILT in v0.5.0, SHAPES UNVERIFIED (2026-10-08).** No HAR was captured. On 2026-10-08
the owner waived §0.1 and accepted the terms risk (§0.2), so the §3 shapes were built as written. They
are verified on §6.2 and §6.3 against the panel's LIVE request/response log. The code is in
`src/vest/tradingShapes.ts` (every body and reader, in one place), `src/vest/trading.ts` (HTTP and
auth), `src/live/` (rules and session), and `web/public/vest-*.js` (token hook). Read `DESIGN.md`
and `CLAUDE.md` first.

The person who builds this owns its correctness. Every request shape below is **unverified**:
Vest publishes no trading API docs ("coming soon" on docs.vestmarkets.com). The shapes are facts
read from Vest's own web app traffic as used by the public `xAmped/Vest-Copier` script. Facts only;
do not copy that script's code, because its license forbids edited copies.

---

## 0. Before writing code

1. **Capture ground truth.** Open next.vestmarkets.com, then DevTools → Network. Place ONE
   minimum-size market order with TP and SL on Vest's own ticket, move the SL once, and close.
   Save as HAR. Every shape in §3 must be checked against this file before it is trusted.
2. **Terms risk is the owner's call.** Vest's Prop Terms treat APIs as a feature they control
   (§2A), and §2 allows one account per person. Trading through a third-party panel may be
   treated as unauthorized use. Decide that before building.
3. **Official API.** If Vest has published one by the time you read this, use it instead and
   discard §2–§3.

## 1. Architecture

```
next.vestmarkets.com tab (user logged in)
  └─ content script, MAIN world, document_start
       observes the page's own requests → user JWT → window.postMessage
  └─ content script, isolated world: relays → chrome.runtime.sendMessage
background service worker: verifies sender.url, stores token in chrome.storage.session
  (memory only: never disk, never localStorage, gone when Chrome closes)
panel (extension page): reads storage.session → VestTrading client → api-gateway
```

- Manifest additions: `"permissions": ["storage"]`, host permission
  `https://next.vestmarkets.com/*`, and two `content_scripts` entries (MAIN-world hook plus
  isolated relay).
- The hook must only **observe** headers. It must never send requests, never read cookies, and
  only forward a **user** token: a JWT with `userId`, no `accountId`, and an `exp`.
- REST base `https://api-gateway.hz.vestmarkets.com`. CORS reflects the origin, and the extension
  host permission covers it.

## 2. Auth

| step | request | notes |
|---|---|---|
| user token | captured from the page's `Authorization: Bearer …` | claims `userId`, no `accountId` |
| account token | `POST /v3/auth/account-token` `{ "accountId": "<id>" }` with the user token | response `accessToken` or `apiKey`, plus `accessExpiresAtMs` (~15 min). Claim `canTrade` must be true before any order |
| cache | reuse until 60 s before expiry; re-mint on 401 once | |

Every order request carries the **account** token and a fresh `Idempotency-Key: <uuid>` header.

## 3. Endpoints (unverified until the HAR matches)

Reads:

| purpose | request | fields used |
|---|---|---|
| accounts | `GET /v3/capital/accounts/active` (user token) | `id, initial_capital, max_drawdown_limit` (= fail floor), `max_leverage` |
| balances | `GET /v3/accounts` (user token) | `account_id, amount` |
| saved leverage | `GET /v3/user-state` (user token) | `accounts[].accountId, leverages[].symbol/leverage` |
| positions | `GET /v3/positions/opened` (account token) | `positionId, symbol, side (long/short), quantity, openPrice, takeProfits[]/stopLosses[] {id, triggerPrice}` |
| resting orders | `GET /v3/positions/opened-orders` (account token) | `orderId \| order_id \| id, reduceOnly` |

Writes (REAL ORDERS):

| action | request body |
|---|---|
| market entry + brackets | `POST /v3/positions/open` `{orderType:"market", leverage:"25", side:"long"\|"short", symbol:"NDX-USD-PERP", quantity:"0.001", timeInForce:"IOC", takeProfits:[{executionType:"market", triggerPrice:"…"}], stopLosses:[{executionType:"market", triggerPrice:"…"}]}` returns `positionId, orderId, takeProfitIds, stopLossIds` |
| flatten | `POST /v3/positions/close` `{symbol, positionId, orderType:"market", leverage:"25"}` (leverage required) |
| move stop / B/E | `PUT /v3/positions/stop-loss` `{positionId, executionType:"market", triggerPrice, stopLossId}` |
| add stop | `POST /v3/positions/stop-loss` `{positionId, executionType:"market", triggerPrice}` |
| move target | `PUT /v3/positions/take-profit` `{positionId, executionType:"market", triggerPrice, takeProfitId}` |
| cancel resting | `POST /v3/positions/cancel-order` `{orderId}` |

Formatting: numbers are strings with trailing zeros trimmed (`"25"`, `"0.1"`, `"31450.75"`).
Quantity uses `sizeDecimals` and price uses `priceDecimals`, both from `/v3/exchangeInfo`. Use the
**wire** symbol (`NDX-USD-PERP`), never the display one.

Known venue behaviour (per Vest-Copier, verify):
- A second `/open` on a symbol already held is accepted but never fills. Adds go through
  `/v3/positions/append`. Leave adds out of v1.
- Leverage: saved per account/symbol, otherwise `floor(1 / capitalInitMarginRatio)` (NQ: 50)
  capped at the account's `max_leverage`.
- A sized TP/SL leg below $1 notional is refused.

## 4. Panel behaviour

- **Mode pill PAPER | LIVE. PAPER on every launch, never persisted as LIVE.**
- Switching to LIVE requires a logged-in Vest tab (token present, `exp` > now) and a selected
  account with `canTrade`. It asks "LIVE: orders go to <account label>. Continue?" and turns the
  banner red: `LIVE — <account> — real orders`.
- In LIVE the account strip reads from Vest: balance, floor = `max_drawdown_limit`, leverage. The
  settings drawer values are paper-only.
- Poll positions and orders every ~1.5 s (watch `x-ratelimit-remaining`) and accounts every ~10 s.
  Vest's position is the truth; never derive it locally.
- v1 actions: BUY MKT / SELL MKT with TP/SL from the point boxes (legs priced from the expected
  fill: ask for long, bid for short), FLATTEN, B/E, CANCEL ALL. Ladder-click limit/stop entries,
  adds and reverse stay paper-only in v1, disabled in LIVE with a tooltip.
- After an entry fills, re-anchor TP/SL to `openPrice ± points` with PUT if they differ by more than
  one tick. The fill can differ from the reference price.
- Every write logs `→ request` and `← status + body` to the panel log.

## 5. Safety rules (non-negotiable)

1. **Flatten and cancel are never blocked.** That covers mode, guards, failed reads and an
   expiring token (re-mint, then send).
2. Pre-trade guard on entries only: size ≤ trading power, account not at its floor. Exits are
   never refused.
3. An optional hard size cap, a user setting. **Off (0) by default since 2026-10-08** at the owner's
   call: like Vest's own ticket, size is limited by trading power only.
4. No automation: no hotkey enters LIVE, and no order is sent without a click or an armed hotkey
   press.
5. The token never leaves memory, and is never logged, sent anywhere else, or written to disk.

## 6. Test plan

1. **Offline:** unit-test every request body against the HAR with a fake fetch, including
   headers, the idempotency key and number formatting. Also test the guards (zero qty,
   canTrade=false, over power) and that flatten works with the guard failing.
2. **Read-only live:** LIVE switch on, no orders. Account, balance, floor and an existing position
   all match Vest's own screen.
3. **First order: 0.001 units** (~$0.001/pt) with TP and SL. Confirm on Vest's screen that the
   position, both legs and their prices match the panel.
4. B/E on that position: the stop moves on Vest's screen.
5. FLATTEN: flat on Vest, with no legs or orders left resting.
6. Only then raise the size cap.

Done = all six pass, and the HAR, the request log and a screenshot of each step are saved in
`docs/live-verification/`.
