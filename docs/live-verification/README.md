# LIVE verification record (LIVE-ORDERS-SPEC §6)

The request shapes are **unverified**: no HAR was captured. The owner waived the HAR on 2026-10-08.
These checks are the verification. Do them in order, and **do not raise the LIVE size cap until
steps 2–5 pass.**

For each step, save the panel's LIVE log here (press **copy** next to "LIVE log", then paste into
`step-N-log.txt`) and a screenshot of Vest's own screen (`step-N.png`). The log is already redacted,
but check it for tokens before you commit it.

| # | step | pass when | log | screenshot |
|---|---|---|---|---|
| 1 | `npm test` (offline bodies, headers, guards, flatten with the guard failing) | all green | n/a | n/a |
| 2 | LIVE switch on, no orders | account, balance, floor (`max_drawdown_limit`) and any open position match Vest's screen. The log shows the first response of each read: check the field names against `src/vest/tradingShapes.ts` | | |
| 3 | BUY or SELL **0.001** with TP and SL set | Vest shows the position and both legs at the panel's prices. The `/open` response has `positionId` | | |
| 4 | B/E | the stop moves on Vest's screen | | |
| 5 | FLATTEN | flat on Vest, with no legs or orders resting | | |
| 6 | raise the cap (settings → LIVE size cap) | only after 2–5 pass | n/a | n/a |

If any response field differs from the spec (wrapper object, field name, id type), fix it in
`src/vest/tradingShapes.ts` and the matching expectation in `tests/trading.test.ts`, then repeat
the step.
