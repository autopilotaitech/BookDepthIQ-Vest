# To do

Ideas parked for later. Each needs the owner's go before it is built.

## Panel-held stop entries (buy stop / sell stop)

**Why:** place a buy stop above a down-trend line (or a sell stop below an up-trend line) so the
entry fires when price comes back through the line. Vest has no stop entry type: its app offers
market and limit only, and its stops exist only as SL legs on an open position.

**How it would work:** shift-click arms a stop at a price (dashed **STP** chip). The panel watches
Vest's last trade price and, on the cross, sends a market order (or a stop-limit with a few ticks
of slippage cap — a setting) with the usual TP/SL legs. One-shot. Same entry checks as any entry.
Disarms if the panel leaves LIVE, loses its Vest connection, or the login lapses.

**Blocker:** it sends an entry without a click at the moment it fires, which is an exception to
CLAUDE.md rule 2 ("no auto-entry"). It also only exists while the panel is open — Vest holds
nothing. Needs the owner's explicit OK and a choice of market vs stop-limit default.
