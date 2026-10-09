# Contributing to BookDepthIQ-Vest

Thanks for helping. This is a **beta** trading tool that sends real orders, so the bar for changes
that touch LIVE is high. Everything else (UI, ladder, paper sim, docs) is open to ideas.

## Ways to help

- **Bug reports.** Open an [issue](https://github.com/autopilotaitech/BookDepthIQ-Vest/issues)
  that says what you clicked, what you expected and what happened. Attach the copied **LIVE LOG**
  and screenshots of the panel and of Vest's screen. The log already blanks out your login, but
  read it before posting and remove anything personal (account IDs, balances) you don't want
  public.
- **Feature ideas.** Open an issue first, so we can agree on the shape before you write code.
- **Pull requests.** Fixes, UI improvements, tests and docs are all welcome.

## Setup

```bash
git clone https://github.com/autopilotaitech/BookDepthIQ-Vest.git
cd BookDepthIQ-Vest
npm install
npm run build        # dist/ = the unpacked Chrome extension
```

Load `dist/` in `chrome://extensions` (Developer mode → Load unpacked) to test the real extension.
After each rebuild, press reload on the extension and reopen the panel.

## Before you open a PR

```bash
npm test             # must pass
npm run typecheck    # must pass
```

- Keep PRs small and focused, one change per PR.
- Add or update tests for any logic change. LIVE changes **must** have tests in
  `tests/trading.test.ts` using the fake Vest (no network).
- Match the surrounding style: TypeScript, small pure functions, and comments that say *why*.
- Update `README.md` if you change how something is used.

## Rules for anything that touches LIVE trading

These are not negotiable. A PR that breaks one will not be merged.

1. **Manual only.** No algos, no auto-entry, no copy-trading, and no multi-account features. Vest's
   Prop Terms allow one account per person. Every order must come from a user click or an armed
   hotkey. The single exception is the panel-held stop entry the user arms on the ladder
   (`src/live/stops.ts`); don't add other orders that fire without a click.
2. **Never guess a request body.** Vest has no public trading API. A new order shape must come from
   Vest's own web app: captured traffic from your own session, or Vest's web-app code. Put the
   source in the PR description. All request bodies live in **one file**,
   `src/vest/tradingShapes.ts`, with a matching test.
3. **FLATTEN and CANCEL are never blocked.** No mode, guard, failed read or expiring login may stop
   them, and there are tests that prove it. Keep those tests green.
4. **Brackets are the user's numbers.** No hard-coded TP/SL distances.
5. **The login token stays in memory.** Never log it, store it, or send it anywhere except Vest's
   own API. Logs go through `redact()`.
6. **Never test against a live Vest write endpoint without the account owner's explicit OK**, and
   use the smallest size Vest allows.
7. **Do not copy code from `xAmped/Vest-Copier`.** Its license forbids edited copies. Facts such as
   endpoint names are fine.

## Engineering notes

- Wire symbol ≠ display symbol (`NQ-PERP` is `NDX-USD-PERP` on the wire). Resolve through
  `buildSymbolTable` and never hardcode either name at a call site.
- Prices are integer ticks internally (`src/book/book.ts`).
- Measure before you pick a threshold: `npm run probe -- <SYM> <secs>`.
- Design and measurements: [`docs/DESIGN.md`](docs/DESIGN.md). LIVE shapes and safety rules:
  [`docs/LIVE-ORDERS-SPEC.md`](docs/LIVE-ORDERS-SPEC.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
