# BookDepthIQ-Vest

A depth-ladder (DOM) scalping panel for **[Vest Markets](https://vestmarkets.com)** perps, starting
with NQ. It runs as a Chrome extension next to your logged-in Vest tab. You get a price ladder with
live Vest book, tape and volume, one-click market and limit entries with TP/SL brackets, draggable
orders, B/E and one-key flatten.

> ## ⚠️ BETA — read this before you trade
>
> - **It works, and it is still beta.** Every LIVE action has been in real use on Vest since
>   2026-10-08: market entries, ladder limit orders, order drag, TP/SL drag, B/E, FLATTEN and
>   CANCEL ALL. Beta means it hasn't been tested on many accounts or setups yet. Confirm your
>   first trades on Vest's own screen.
> - **Vest publishes no trading API.** The panel sends the same requests Vest's own web app sends,
>   using your existing login. If Vest changes its app, things can break without warning. Watch the
>   result bar under the LIVE banner and keep Vest's own tab open to confirm every order.
> - **Prop-account terms are your responsibility.** Vest's Prop Terms treat API access as a feature
>   Vest controls and allow one account per person. Using a third-party panel may be treated as
>   unauthorized use. Read the terms and decide for yourself.
> - **Manual trading only.** The panel has no algos, no auto-entry and no copier. Nothing is sent
>   without your click or an armed hotkey.
> - Not financial advice. No warranty (MIT). Start with the smallest size Vest allows.

---

## What you need

- Google Chrome (or another Chromium browser that supports Manifest V3 extensions)
- A Vest account you can log into at **https://next.vestmarkets.com**
- [Node.js](https://nodejs.org) 20 or newer, to build the extension once

## Install

**Easy way (no Node needed):**

1. Download the latest `BookDepthIQ-Vest-vX.Y.Z.zip` from
   [**Releases**](https://github.com/autopilotaitech/BookDepthIQ-Vest/releases/latest).
2. Unzip it to a folder you'll keep, for example `C:\BookDepthIQ-Vest`.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Pin the **BookDepthIQ-Vest** icon in the toolbar.

**To update:** download the new zip, unzip it over the same folder, press reload on the extension
in `chrome://extensions`, then reopen the panel.

**From source:**

```bash
git clone https://github.com/autopilotaitech/BookDepthIQ-Vest.git
cd BookDepthIQ-Vest
npm install
npm run build        # creates dist/ — load this folder with "Load unpacked"
```

## First run: PAPER

1. Click the toolbar icon. The panel opens in its own window.
2. It always starts in **PAPER**. Orders fill locally in this window and nothing goes to Vest.
   The banner says so.
3. Pick a market (NQ-PERP by default) and learn the ladder in PAPER first.

## Going LIVE

1. Open **https://next.vestmarkets.com** in the **same Chrome** as the panel and log in.
   **Keep only one Vest tab open** (see Troubleshooting).
2. Open the panel and wait a few seconds. The red **"no Vest login"** text next to the switch
   should disappear.
3. Press **LIVE**. The panel reads your Vest account and asks:
   *"LIVE: orders go to &lt;account&gt;. Continue?"*
4. The banner turns red: **LIVE — &lt;account&gt; — real orders**. The account row shows your Vest
   balance, the fail floor (`max_drawdown_limit`), leverage, trading power and sync status.

Every LIVE launch starts in PAPER again. LIVE is never remembered.

## Using the ladder

| Action | PAPER | LIVE (real orders on Vest) |
|---|---|---|
| **BUY MKT / SELL MKT** buttons | market fill | market order, with TP/SL legs if BRACKET is on |
| Click the **BUY** / **SELL** column at a price | limit order | **limit order** (GTC) with TP/SL legs at your points from that price |
| **Shift+click** the BUY / SELL column | stop order | not available: Vest has no stop entry orders |
| Click an **LMT** chip | cancel | cancel on Vest |
| Drag an **LMT** chip to another row | move | move on Vest (cancel, then re-place the unfilled size at the new price; TP/SL shift with it) |
| Drag a **TP** / **SL** chip | move the leg | move the leg on Vest |
| **B/E** | stop to entry ± offset | moves (or adds) the Vest stop |
| **FLATTEN** / **F** | close all | closes the Vest position, then cancels its resting orders |
| **CANCEL ALL** / **Esc** | cancel all | cancels every resting Vest order on the symbol |
| REVERSE / adding to an open position | yes | not yet (paper only) |

**Sizing and brackets** (bottom bar)
- **Size** can be in units, USD notional (like Vest's own ticket) or $ risk at the stop. The
  equivalent CME contracts, notional, leverage and round-trip cost are shown underneath.
- **TP pts / SL pts**: distances in points. They're your numbers; the panel has no built-in
  defaults. 0 means no leg. **BRACKET ON/OFF** toggles legs for new entries.
- **B/E + pts**: the offset used by B/E.

**Hotkeys**
- **F** = flatten and **Esc** = cancel all. Both always work.
- **B** buy, **S** sell, **E** B/E and **R** reverse work only while **HOTKEYS ARMED** is on. Click
  the toggle to arm them.
- **Space** re-centres the ladder.
- Wheel over the PRICE column changes the price grouping: 1, 2, 4, 8, 20, 40 or 100 ticks per row.

**The result bar.** Every LIVE action shows its result right under the LIVE banner: green ✓ when
Vest accepted it, red ✗ with the reason when it was refused. The full request/response log is in
the **LIVE LOG** pane. Its **copy** button copies it with your login already blanked out.

## Safety rules built in

- **FLATTEN and CANCEL are never blocked.** No mode, guard, failed read or expiring login stops them.
- **Entry checks:** the size must fit your trading power, the account must be above its fail
  floor, positions must be freshly synced from Vest, and there must be no position already open on
  the symbol. These are the same limits Vest's own ticket enforces.
- **Optional size cap:** settings → *LIVE size cap*. 0 means off.
- **Vest is the source of truth.** Positions, orders and balance come from Vest and are never
  computed locally. Vest pushes account changes over its private socket, and the panel re-reads
  them at once (the account row shows **Vest ⚡ live**). If the push drops, it falls back to
  reading every 1.5 s (**Vest synced (polling)**).
- **Your login stays in memory.** The extension reads the token your Vest tab already uses. It is
  never written to disk, never logged, and never sent anywhere except Vest's own API.

## Troubleshooting

| You see | Do this |
|---|---|
| **"no Vest login — no next.vestmarkets.com tab is open in THIS Chrome…"** | Open Vest and log in in the same Chrome window set (same profile) as the panel. |
| **"no Vest login"** after reloading the extension | Reload the Vest tab once, then wait about 3 s. |
| Login flickers, or LIVE behaves oddly | **Close extra Vest tabs.** Keep one. |
| Pressing LIVE seems to do nothing | Read the red text next to the PAPER/LIVE switch. It says exactly why. |
| An order is refused | Read the red result bar under the LIVE banner. |
| Something looks wrong on Vest | Press **FLATTEN**, check Vest's own screen, then open an issue with the copied LIVE log. |

## Reporting bugs

Open an issue at https://github.com/autopilotaitech/BookDepthIQ-Vest/issues with:
- what you clicked and what you expected
- the **copied LIVE LOG** (your login is already blanked out, but read it before posting)
- a screenshot of the panel and of Vest's screen

## Contributing

Feedback, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the rules for anything that touches LIVE trading.

## For developers

```bash
npm test             # unit tests (request bodies, guards, flatten-always-works, readers)
npm run typecheck
npm run dev          # panel in a normal browser tab (PAPER only: no Vest login outside the extension)
npm run probe -- NQ-PERP 60   # measure the live Vest book for 60 s
```

Design notes are in [`docs/DESIGN.md`](docs/DESIGN.md), and the LIVE request shapes and safety
rules are in [`docs/LIVE-ORDERS-SPEC.md`](docs/LIVE-ORDERS-SPEC.md). All Vest request bodies live
in one file, `src/vest/tradingShapes.ts`.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with or endorsed by Vest Markets.
