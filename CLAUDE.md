# BookDepthIQ-Vest — agent rules

Separate project from BookDepthIQ (`autopilotaitech/BookDepthIQ`). Do not edit BookDepthIQ from
here, and do not add Vest code to BookDepthIQ. Read `docs/DESIGN.md` before changing anything.

## Trading safety — absolute

1. **No order is sent without the owner's explicit go.** That covers every path, paper included. A
   test that would hit a Vest write endpoint needs the same go.
2. **Manual only.** No algo, no auto-entry, **no copier**. Vest's Prop Terms §2 allow one
   account per person. **One exception, approved by the owner on 2026-10-09:** panel-held stop
   entries (`src/live/stops.ts`). The user arms a buy/sell stop at their own price, size and
   brackets; on a trade at or through it the panel sends ONE market entry through the normal entry
   checks. Since 2026-10-12 (owner's OK) the user may instead arm it to fire only on a one-minute
   CLOSE at or through the price (`confirm: 'close'`); same one entry, same checks. They disarm on PAPER, instrument switch, lost market data or an expired login.
   **Second exception, approved by the owner on 2026-10-11:** B/E after TP1 (`src/live/targets.ts`).
   Ticked by the user on an entry with 2+ targets; when TP1 fills the panel sends ONE stop move to
   entry ± the user's B/E offset. Same disarm rules as the stops.
   **Third set, approved by the owner on 2026-10-12** ("1-9 do it"), each OFF until the user turns
   it on, and none of them ever opens a position: trailing stop (moves the stop only in the user's
   favour, `src/live/manage.ts`), stop recovery (re-places a stop that vanished from a Vest
   position, at its last price), close at the user's daily loss limit, and close 5 min before
   Vest's weekend lock. Nothing else may send an order without a click.
3. **Never guess an endpoint payload.** Order shapes come from a HAR captured in the owner's own
   session. Vest has no public API docs.
4. **Brackets are the user's numbers.** No hard-coded TP/SL distances.
5. **Flatten and cancel are never gated.**
6. **Never copy code from `xAmped/Vest-Copier`.** Its license forbids edited copies. Facts such
   as endpoint names are fine.

## Engineering

- Wire symbol ≠ display symbol (`NQ-PERP` is `NDX-USD-PERP`). Resolve through `buildSymbolTable`
  and never hardcode either name at a call site.
- Prices are integer ticks internally (`src/book/book.ts`).
- Measure before choosing a threshold: `npm run probe -- <SYM> <secs>`.
- `npm test` and `npm run typecheck` must pass before a commit.
