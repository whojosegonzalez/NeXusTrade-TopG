# Phase 7 Planning Inputs

This handoff captures the current Phase 6 state needed to plan Phase 7: PaperExchange.

Phase 7 should consume strategy output and create simulated execution records:

```text
StrategyDecision(BUY)
+ TokenRadar(APPROVED)
+ Latest RiskAssessment
-> paper Order
-> simulated Fill
-> Position
```

Phase 7 should still remain paper-only and should not load wallets, sign transactions, submit transactions, or touch `LIVE` mode.

## Current Phase 6 Output

Phase 6 added:

- `pnpm strategy:evaluate`
- `backend/src/scripts/strategy-evaluate.ts`
- `backend/src/strategy/StrategyConfig.ts`
- `backend/src/strategy/StrategyCandidateSelector.ts`
- `backend/src/strategy/StrategyScoringService.ts`
- `backend/src/strategy/StrategyEvaluationService.ts`
- `backend/src/strategy/StrategyRunner.ts`
- rule modules under `backend/src/strategy/rules`

The strategy engine writes `StrategyDecision` rows and updates TokenRadar to `APPROVED` only after stored BUY decisions.

## StrategyDecision Repository Surface

Methods:

- `createStrategyDecision(input)`
- `getStrategyDecisionById(id)`
- `listStrategyDecisions(sessionId, filter)`
- `listDecisionsForMint(sessionId, mintAddress)`

Phase 7 can query BUY decisions with:

```ts
repositories.strategyDecisions.listStrategyDecisions(sessionId, { decision: "BUY" });
```

## Order Schema And Repository Surface

Order fields:

- `id`
- `sessionId`
- `mode`
- `side`
- `mintAddress`
- `status`
- `createdAtMs`
- `updatedAtMs`
- `requestedSolLamports`
- `requestedTokenAmount`
- `quoteSource`
- `quoteId`
- `strategyDecisionId`
- `reason`
- `rawOrderJson`

Order enum values:

- `side`: `BUY`, `SELL`
- `status`: `CREATED`, `QUOTED`, `FILLED`, `PARTIALLY_FILLED`, `REJECTED`, `FAILED`, `CANCELLED`

Repository methods:

- `createOrder(input)`
- `getOrderById(id)`
- `listOrders(sessionId, filter)`
- `updateOrderStatus(id, status, context?)`
- `linkOrderToQuote(id, input)`

Current filters:

- `mintAddress`
- `status`
- `limit`

Phase 7 can create a BUY order in `CREATED` or `QUOTED`, link compact simulated quote context, then mark it `FILLED` after the fill row is stored.

## Fill Schema And Repository Surface

Fill fields:

- `id`
- `orderId`
- `sessionId`
- `filledAtMs`
- `fillPriceSol`
- `fillPriceUsd`
- `tokensFilled`
- `solSpentLamports`
- `solReceivedLamports`
- `estimatedBaseFeeLamports`
- `estimatedPriorityFeeLamports`
- `estimatedSlippageLamports`
- `priceImpactBps`
- `quoteSource`
- `rawQuoteJson`
- `createdAtMs`

Repository methods:

- `createFill(input)`
- `getFillById(id)`
- `listFillsForOrder(orderId)`
- `listFillsForSession(sessionId)`

Phase 7 can use `solSpentLamports`, fee fields, slippage, and `tokensFilled` for simulated BUY fills. SELL simulation can use `solReceivedLamports` later.

## Position Schema And Repository Surface

Position fields:

- `id`
- `sessionId`
- `mintAddress`
- `status`
- `openedAtMs`
- `closedAtMs`
- `avgEntryPriceSol`
- `avgExitPriceSol`
- `tokensHeld`
- `costBasisLamports`
- `proceedsLamports`
- `realizedPnlLamports`
- `realizedPnlBps`
- `feesPaidLamports`
- `createdAtMs`
- `updatedAtMs`

Position status enum values:

- `OPEN`
- `CLOSING`
- `CLOSED`
- `ERROR`

Repository methods:

- `openPosition(input)`
- `getPositionById(id)`
- `getOpenPositionByMint(sessionId, mintAddress)`
- `listOpenPositions(sessionId)`
- `listClosedPositions(sessionId)`
- `updatePositionAfterFill(id, input)`
- `closePosition(id, input)`

Phase 7 can enforce duplicate protection with `getOpenPositionByMint(sessionId, mintAddress)`.

## Session Schema And Cash Updates

Session fields most relevant to Phase 7:

- `id`
- `mode`
- `status`
- `startedAtMs`
- `endedAtMs`
- `startingBalanceLamports`
- `currentCashLamports`
- `targetProfitLamports`
- `targetProfitBps`
- `maxDrawdownLamports`
- `realizedPnlLamports`
- `unrealizedPnlLamports`
- `terminationReason`
- `configSnapshotJson`
- `createdAtMs`
- `updatedAtMs`

Session status enum values:

- `CREATED`
- `RUNNING`
- `PAUSED`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

Repository methods relevant to Phase 7:

- `getSessionById(id)`
- `listSessions(filter)`
- `getActivePaperSessions()`
- `updateSessionPnl(id, input)`
- `completeSession(id, terminationReason)`
- `failSession(id, errorContext)`

There is no dedicated `updateCash()` method. `SessionRepository.updateSessionPnl()` can update `currentCashLamports`, `realizedPnlLamports`, and `unrealizedPnlLamports`, so Phase 7 can use it to decrement paper cash after simulated BUY fills.

## TokenRadar Statuses For Phase 7

Phase 7 should consume:

- `TokenRadar.status = APPROVED`
- matching `StrategyDecision.decision = BUY`

Phase 7 should not consume:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

`BOUGHT` should become a PaperExchange-owned transition after a simulated buy is successfully recorded.

## Sample StrategyDecision Row

The first local non-dry Phase 6 smoke run produced a `SKIP` decision, which is acceptable because WATCH/SKIP may dominate early real data:

```json
{
  "id": "decision_8fc2e332-4482-47f9-bf56-69faeab78a1b",
  "sessionId": "session_3e2830d0-1bb0-496c-b8f0-772215840996",
  "mintAddress": "GTtNj9FEqkP9Xtw4y2bFxMXVMM1iDcFKKBE2zQSzpump",
  "decidedAtMs": 1782085534119,
  "decision": "SKIP",
  "strategyName": "phase6_first_pass",
  "score": 35,
  "reason": "SKIP: score=35 risk=WARN liquidity=10288.32 volume1h=26381.97 ageSeconds=7661",
  "createdAtMs": 1782085534121
}
```

Matching TokenRadar row remained `WATCHING` because SKIP does not update status:

```json
{
  "id": "radar_ac1d4651-9f0a-4c2c-a62b-834f183176df",
  "sessionId": "session_3e2830d0-1bb0-496c-b8f0-772215840996",
  "mintAddress": "GTtNj9FEqkP9Xtw4y2bFxMXVMM1iDcFKKBE2zQSzpump",
  "symbol": "LOL",
  "status": "WATCHING",
  "liquidityUsd": "11071.32",
  "volume1hUsd": "26381.97",
  "ageSeconds": 7661
}
```

## Phase 7 Decisions To Make

Before implementing PaperExchange:

- Should Phase 7 command be `pnpm paper:execute --once` or `pnpm paper:trade --once`?
- Should it consume only `APPROVED` + `BUY`, or also allow explicit `--decision-id`?
- What is the default simulated buy size?
- How should slippage and fee assumptions be modeled?
- Should PaperExchange update TokenRadar from `APPROVED` to `BOUGHT` only after order, fill, and position rows all succeed?
- Should PaperExchange prevent multiple open positions for the same session and mint?
- How should failed paper execution be represented: failed order only, or TokenRadar `ERROR` too?
- Should `PositionSnapshot` be created in Phase 7 or deferred?
- Should Phase 7 execute only BUY decisions, or also prepare SELL simulation structure?

## Recommended Phase 7 Defaults

- Standalone command: `pnpm paper:execute --once`
- Paper-only mode.
- No auto-created sessions.
- Explicit sessions must be `PAPER` + `RUNNING`.
- Consume `StrategyDecision(BUY)` and `TokenRadar(APPROVED)`.
- Execute only BUY decisions in Phase 7.
- Leave SELL simulation structure to a later phase, while preserving compatibility with the existing BUY/SELL order side enum.
- Prevent duplicate open positions per session and mint.
- Default buy size should come from session/config, not hardcoded into StrategyDecision.
- Create order first, then fill, then position.
- Update TokenRadar to `BOUGHT` only after all simulated execution records are stored.
- Use `SessionRepository.updateSessionPnl()` to decrement `currentCashLamports`.
- Defer `PositionSnapshot` creation to Phase 8 unless Phase 7 needs a minimal initial snapshot for audit.
- Record failed order first; set TokenRadar `ERROR` only for unrecoverable mapping or persistence errors.
- Keep wallet loading, signing, submission, and live trading disabled.

## Migration Assessment

No DB migration appears necessary for Phase 7.

The existing schema already supports:

- BUY/SELL order sides
- order lifecycle status
- strategy decision linkage from order
- simulated fill economics
- open position state
- session cash/P&L updates
- TokenRadar `BOUGHT` status

Possible later hardening:

- database-level uniqueness for one open position per session and mint
- first-class execution configuration table
- richer quote/slippage model fields
- dedicated cash ledger if paper accounting needs full transaction history
