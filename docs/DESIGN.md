# BookDepthIQ-Vest — design

A scalping execution panel for Vest Markets perps, starting with NQ-PERP. **Separate project
from BookDepthIQ.** BookDepthIQ stays futures + Rithmic only, and nothing here ships inside
BookDepthIQ.exe.

Status as of 2026-10-08 (v0.9.0): **phases 0–3 are done.** The panel starts in PAPER on every
launch. Its LIVE mode **places, moves and cancels real orders at Vest** using the request shapes in
`src/vest/tradingShapes.ts`, read from Vest's own web app. No HAR was captured (the owner's call);
every LIVE path was then **verified in real trading on 2026-10-08**. Phase 4 (CME depth from BookDepthIQ) is next.

---

## 1. What Vest actually is (measured, not assumed)

| fact | how it was established |
|---|---|
| The UI says `NQ-PERP`; the API only accepts **`NDX-USD-PERP`** | `GET /v3/exchangeInfo`. Asking for `NQ-PERP` returns `{"code":1121,"msg":"unknown symbol"}` |
| Tick 0.25, `sizeDecimals` 4, taker 0.25 bps, maker 0 | exchangeInfo |
| PnL is linear in USDC, 1:1, so **qty 1.0 = $1/pt**. 20.0 ≈ 1 NQ, 2.0 ≈ 1 MNQ | docs "Perpetual Contract Specifications". Derived, so **verify on the first paper fill** |
| Public REST: `/v3/exchangeInfo`, `/v3/ticker/latest`, `/v3/ticker/24hr`, `/v3/trades` | live calls. `/v3/depth` and `/v3/klines` return 404 |
| Public WS `wss://ws.hz.vestmarkets.com/ws?version=1.0`: `@depth`, `@trades`, `@ticker` | `SUBSCRIBE` answers per stream. `@kline_1m`, `@orderbook` and `@book` are `invalid_stream` |
| `@depth` is a **full snapshot every message**, 20–40 levels a side, no order ids | probe |
| Official API docs: **none** ("Coming soon") | docs.vestmarkets.com |

### The book is one quoter's ladder, not organic liquidity

These numbers are from `npm run probe -- NQ-PERP 60`, run twice on 2026-10-07:

```
depth msgs/s     ~2.6     gap ms p50 300, p90 800
levels/side      p50 40
spread ticks     p10 2, p50 4-6, max 6-7       (CME NQ is 1 tick)
top-of-book size p50 4.8135 — the same number on both sides, every snapshot
ladder score     p50 0.95  (share of resting sizes that are whole multiples of one 1.6045 unit)
trades/min       0.7 – 7
mark vs index    +8.7 bps, very steady
```

Sizes come in exact multiples (3.209, 4.8135, 6.418, 9.627, 12.836, …). They are symmetric on
both sides and re-quoted wholesale every ~300 ms around the index price. That is a market
maker's quoting curve. **BookDepthIQ's whole edge (MBO heatmap, absorption, iceberg, queue
position) reads organic order flow, and there is none on this book.** A heatmap of Vest's depth
would draw the maker's curve and nothing else.

Vest's own 24 h stats agree. NQ `quoteVolume` was ~$55M "live" against ~$5.5B "funded" and
~$11B "eval". Almost all activity is prop accounts trading against the house.

### So the useful design is: read CME, execute on Vest

The real NQ order flow lives on CME, and Vest's index tracks it. The panel should show **CME
depth and tape** (from BookDepthIQ's Rithmic feed, read-only over localhost) and **route orders
to Vest**. Prices map through a **live-sampled basis**, Vest mark minus CME front month. That
basis is never a constant: it carries futures carry plus Vest's own ±25 bps band, the same
lesson as BookDepthIQ's GEX basis (§4B there).

Without BookDepthIQ running, the panel falls back to Vest's own ladder and tape, labelled as
such.

---

### Perp / prop-account mechanics the panel now models (v0.2)

These come from the owner's Vest screen on 2026-10-07 and Vest's docs. Note that **1 MNQ = 2 units
and 1 NQ = 20 units is now confirmed** by the "Cross Margin & Leverage" page.

- **Fail price, not liquidation, is the binding limit.** A Vest Capital account closes
  permanently the instant equity *including open PnL* drops below its drawdown floor. On a $500
  Instant account the floor is $10 under the start. Exchange liquidation (maintenance margin)
  sits hundreds of points further away and never matters first.
- **Trading power = equity × leverage**, so 25x on $506 = $12.66K, which is about **0.40 units
  (0.02 NQ) maximum** on NQ. Entries beyond it are refused, the same way Vest refuses them.
  Exits are never refused.
- **Sizing modes:** units, USD notional (Vest's ticket), or $ risk at the SL.
- **An SL at or inside the spread stops out on entry.** The stop is measured from the fill, and a
  buy fills at the ask. The panel warns about this. Open question: does Vest trigger TP/SL on the
  bid, mid or mark? The paper sim uses bid/ask.
- Not modelled yet: hourly funding accrual and the 20:00 ET daily-loss reset (evaluation
  accounts only).

### Does Vest's index lead its book? No (measured 2026-10-08)

`npm run leadlag -- NQ-PERP 300` over a 5-minute window, using local receive time for both series:

```
index publishes every 750 ms (p50), 1.33/s; depth ~6.5/s
cross-correlation of 100 ms changes: PEAK at −600 ms (r=0.19) → Vest's MID moves FIRST
index move ≥2t in 1s: 184 events · mid followed 104 · went against first 80   (57/43)
index move ≥4t in 1s:  78 events · mid followed 44  · went against first 34
```

The published index is a lagging snapshot of what Vest's maker is already quoting from. It has
no lead value, so the ◆ index-implied marker is **off by default** and labelled as a reference.
This supports the phase-4 plan: if anything leads Vest, it is the CME book itself (via
BookDepthIQ), not Vest's index field. That claim is unmeasured until CME data is wired in. One
5-minute evening sample, so re-run it in RTH before treating the result as settled.

### Sweeps: shipped in v0.3, removed in v0.4.4

Aggressors do take several levels in one print. One example was a 13-level sell for 44 units.
A structural detector (same ms, same side, ≥2 prices) marked them on the ladder and the tape.
The owner judged it clutter on the DOM, so it was removed. The raw tape still shows every print.

## 2. Execution path (phases 2–3 done, verified live 2026-10-08 — spec: LIVE-ORDERS-SPEC.md)

Vest's trading API is undocumented. The endpoints below are what Vest's own web app calls, as
seen in the public `xAmped/Vest-Copier` script. They were **read for facts only — none of that
code is copied here** (its license forbids edited copies).

- Auth: the web session's user JWT mints a short-lived (~15 min) **account token** via
  `POST /v3/auth/account-token`. Orders carry the account token.
- Read: `GET /v3/positions/opened`, `/v3/positions/opened-orders`, `/v3/executions`,
  `/v3/user-state`.
- Write: `/v3/positions/open`, `/append`, `/reduce`, `/close`, `/stop-loss`, `/take-profit`,
  `/cancel-order`. Note the API is **position-shaped**: TP/SL attach to a position rather than
  being free OCO orders.

**Before any order code is written:** capture the exact request/response bodies from the owner's own
logged-in session (Chrome DevTools → Network → "Save all as HAR", with a minimum-size paper
order). Never guess a payload at a live endpoint. That is the same rule as never guessing a
Rithmic template id.

Delivery form: a **Chrome extension (MV3)**. A content script on `next.vestmarkets.com` reads
the session the user is already logged into. The panel runs in its own window. That avoids
storing credentials anywhere and survives Vest UI redesigns better than DOM-clicking.

---

## 3. Phases

| # | scope | orders? | gate |
|---|---|---|---|
| 0 | market-data client, probe, tests | no | **done** |
| 1 | panel UI on public data: price ladder, tape, spread, basis, size in NQ-equivalents, plus a LOCAL paper sim (`src/sim/paper.ts`) for click-to-trade, brackets, B/E, flatten | no (local only) | **done** |
| 2 | auth + read-only account: position, working orders, fills, P&L | no | **done** (v0.5.0; account reads verified live 2026-10-08; v0.6.0 adds Vest's private push socket) |
| 3 | click-to-trade: market/limit entry, TP/SL in ticks from the panel's boxes, cancel, flatten, B/E, drag stop | **yes** | **done** (market + ladder limit entries with TP/SL, B/E, flatten, cancel, order and leg drag; verified live 2026-10-08). Stop entries do not exist on Vest. Adds/reverse still paper-only |
| 4 | CME depth/tape overlay from BookDepthIQ over localhost, live basis mapping | no | BookDepthIQ exposes a read-only feed for it |

---

## 4. Rules (carried over from BookDepthIQ, plus Vest's own)

1. **No order is ever sent without the owner's explicit go.** That covers every path, paper included.
2. **Manual trading only.** No algo, no auto-entry, **no trade copier**.
3. **Vest's Prop Terms §2 allow ONE account per person** ("strictly prohibited from creating or
   controlling multiple Accounts"). §5.12–13 also bar trading "through other accounts, bots" and
   "multiple identities or Accounts". A multi-account copier is a ToS violation on this venue, not
   just a risk.
4. **Brackets are the user's numbers.** TP/SL come only from the panel's boxes. No hard-coded
   distances.
5. **Flatten and cancel are always reachable**, even when anything else is broken or disabled.
6. **Thresholds are measured, never chosen.** Run `npm run probe` and read the distribution
   first.
