# Phase 7.5 Planning Inputs

This handoff captures the Phase 7 state needed to plan PaperExchange SELL execution, position closing, and P/L.

Phase 7 currently opens positions only:

```text
StrategyDecision(BUY)
+ TokenRadar(APPROVED)
-> Order(BUY)
-> Fill(BUY)
-> Position(OPEN)
-> Session.currentCashLamports decrement
-> TokenRadar(BOUGHT)
```

## Current Phase 7 Output

Phase 7 added:

- `pnpm paper:execute`
- `backend/src/scripts/paper-execute.ts`
- `backend/src/paper/PaperExchangeConfig.ts`
- `backend/src/paper/PaperExecutionCandidateSelector.ts`
- `backend/src/paper/PaperExecutionService.ts`
- `backend/src/paper/PaperOrderFactory.ts`
- `backend/src/paper/PaperFillFactory.ts`
- `backend/src/paper/PaperPositionFactory.ts`
- `backend/src/paper/PaperRunner.ts`
- `backend/src/paper/PaperMath.ts`

## Runtime Defaults

- Default buy size: `0.01 SOL`
- Default candidate limit: `10`
- Base fee: `5000` lamports
- Priority fee: `0` lamports
- Slippage: `100` bps
- Quote source: `TOKEN_RADAR_PRICE`

## Session Policy

Paper execution:

- runs only in `PAPER`
- requires `RUNNING` sessions
- does not auto-create sessions
- uses the latest active session with approved BUY candidates when no `--session-id` is supplied

## Current Rejection Reasons

- `MISSING_PRICE_SOL`
- `INSUFFICIENT_CASH`
- `OPEN_POSITION_EXISTS`

Expected rejections create `Order(REJECTED)` and do not create fills, positions, cash updates, or TokenRadar status changes.

## Current Position State

Phase 7 creates `OPEN` positions with:

- `sessionId`
- `mintAddress`
- `openedAtMs`
- `avgEntryPriceSol`
- `tokensHeld`
- `costBasisLamports`
- `feesPaidLamports`

Phase 7 does not close positions.

## Current Fill Fields Used

BUY fills currently use:

- `orderId`
- `sessionId`
- `filledAtMs`
- `fillPriceSol`
- `fillPriceUsd`
- `tokensFilled`
- `solSpentLamports`
- `estimatedBaseFeeLamports`
- `estimatedPriorityFeeLamports`
- `estimatedSlippageLamports`
- `priceImpactBps`
- `quoteSource`
- `rawQuoteJson`

SELL fills can later use the existing `solReceivedLamports` field.

## Phase 7.5 Decisions To Make

- Should Phase 7.5 use `pnpm paper:sell --once`, extend `pnpm paper:execute`, or introduce `pnpm paper:manage --once`?
- Should SELL candidates come from explicit sell strategy decisions, target P/L rules, stop-loss rules, or all three?
- Should Phase 7.5 refresh quotes before SELL simulation instead of relying on stored TokenRadar prices?
- How should unrealized P/L be represented before a position closes?
- Should `PositionSnapshot` be created in Phase 7.5 or deferred to Phase 8 SessionManager?
- Should successful SELL update TokenRadar to `WATCHING`, `IGNORED`, or a new status in a later migration?

## Recommended Phase 7.5 Direction

- Keep Phase 7.5 paper-only.
- Add SELL simulation without wallet loading, signing, or submission.
- Consume `OPEN` positions and fresh quote evidence.
- Create `Order(SELL)` and `Fill(SELL)` records.
- Update `Position` to `CLOSED`.
- Update `Session.currentCashLamports`.
- Populate `realizedPnlLamports` and `realizedPnlBps`.
- Leave full run-level target control to Phase 8.
