# Phase 8 Planning Inputs

This handoff captures the Phase 7.5 state needed to plan SessionManager, target control, and
snapshot behavior.

Phase 7.5 now provides the complete paper execution loop:

```text
BUY Decision
-> BUY Order
-> BUY Fill
-> OPEN Position
-> SELL trigger
-> SELL Order
-> SELL Fill
-> CLOSED Position
-> realized P/L
-> cash update
```

## Current Phase 7.5 Output

Phase 7.5 added:

- `pnpm paper:sell`
- `backend/src/scripts/paper-sell.ts`
- `backend/src/paper/PaperSellConfig.ts`
- `backend/src/paper/PaperSellCandidateSelector.ts`
- `backend/src/paper/PaperSellValidationService.ts`
- `backend/src/paper/PaperSellQuoteService.ts`
- `backend/src/paper/PaperSellAccountingService.ts`
- `backend/src/paper/PaperSellOrderFactory.ts`
- `backend/src/paper/PaperSellFillFactory.ts`
- `backend/src/paper/PaperSellExecutionService.ts`
- `backend/src/paper/PaperSellRunner.ts`

## Runtime Behavior

- `paper:sell --once` fails without an explicit trigger.
- `--sell-all` sells eligible open positions in the selected session scope.
- `--mint=<mint>` sells one open position for the supplied mint.
- `--dry-run` performs no writes.
- Cached TokenRadar price fallback is disabled by default.

## Execution Records

Successful SELL creates:

- `Order(SELL, FILLED)`
- `Fill` with `solReceivedLamports`
- `Position(CLOSED)`
- `SystemLog(EXECUTION)` entries

Successful SELL updates:

- `Session.currentCashLamports`
- `Session.realizedPnlLamports`
- `TokenRadar.status = WATCHING`

## Accounting Model

```text
grossProceedsLamports =
tokensHeld * sellPrice

netSellProceedsLamports =
grossProceedsLamports
- sellFeesLamports
- sellSlippageLamports

realizedPnlLamports =
netSellProceedsLamports
- position.costBasisLamports
- position.feesPaidLamports
```

## Current Limitations

- Position and equity snapshots are still deferred.
- Target-profit, stop-loss, trailing-stop, and max-hold automation are not implemented.
- Session completion is not implemented.
- The first SELL implementation uses ordered writes rather than a repository-level transaction
  wrapper.
- Some SELL audit fields are stored in JSON rather than dedicated columns.

## Current Paper DB Hygiene

The current local paper database may contain development artifacts from earlier phases:

- seeded Phase 2 paper sessions
- fake mints such as `Fake111111111111111111111111111111111111111`
- fake DexScreener pair addresses
- smoke-test positions
- provider health and execution logs from manual verification

Those rows are useful for shape testing, but they are not clean market history. Fake seeded mints
cannot produce fresh DexScreener pairs, Jupiter prices or quotes, or Helius metadata because they are
not real Solana assets.

After Phase 8 implements snapshots and session/equity accounting, archive or reset the local PAPER
database before the first clean end-to-end run. The clean run should use real token mint addresses and
the modern pipeline only:

```text
scanner
-> risk
-> strategy
-> paper BUY
-> Phase 8 snapshots/session manager
-> paper SELL
```

Do not reset the database casually before Phase 8 unless the seeded fixtures are no longer needed for
local validation.

## Phase 8 Decisions To Make

- Should SessionManager run as `pnpm session:run --once` or extend existing scanner/risk/strategy/paper commands?
- Should Phase 8 create `EquitySnapshot` every cycle?
- Should Phase 8 create `PositionSnapshot` for each open position every cycle?
- What target-profit and max-drawdown thresholds should be supported first?
- Should stop-loss and trailing-stop exits be introduced in Phase 8 or deferred to Phase 8.5?
- Should SessionManager call `paper:sell` internally or share a service layer directly? Resolved:
  defer all automatic SELL integration to Phase 8.5.
- Should Phase 8 add a transaction helper for multi-record execution updates?

## Recommended Phase 8 Direction

- Keep Phase 8 paper-only.
- Add a SessionManager orchestration command.
- Evaluate session-level target and drawdown controls.
- Generate equity snapshots.
- Generate position snapshots.
- Do not trigger internal SELL actions in Phase 8.
- Complete sessions only through SessionManager, not PaperExchange.
- Plan a post-Phase 8 PAPER database archive/reset before the first clean real-mint paper run.
