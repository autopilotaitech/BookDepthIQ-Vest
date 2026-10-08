# BookDepthIQ-Vest — agent rules

Separate project from BookDepthIQ (`autopilotaitech/BookDepthIQ`). Do not edit BookDepthIQ from
here, and do not add Vest code to BookDepthIQ. Read `docs/DESIGN.md` before changing anything.

## Trading safety — absolute

1. **No order is sent without the owner's explicit go.** That covers every path, paper included. A
   test that would hit a Vest write endpoint needs the same go.
2. **Manual only.** No algo, no auto-entry, **no copier**. Vest's Prop Terms §2 allow one
   account per person.
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
