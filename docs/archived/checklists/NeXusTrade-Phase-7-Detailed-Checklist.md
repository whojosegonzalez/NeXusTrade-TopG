# NeXusTrade Phase 7 Detailed Checklist

PaperExchange Buy Engine - Enterprise / Codex Implementation Edition

Last updated: June 2026

Status: Complete.

## 1. Goal

Phase 7 introduces the first PaperExchange execution layer.

It consumes:

```text
StrategyDecision(BUY)
+ TokenRadar(APPROVED)
+ Latest RiskAssessment
```

It produces:

```text
Order
-> Fill
-> Position
```

It also updates paper cash and execution state.

Phase 7 is paper-only. It must not load wallets, sign transactions, submit transactions, or perform live trading.

## 2. Why Phase 7 Was Split

The original execution phase included:

- Buy simulation.
- Sell simulation.
- Position management.
- Realized P/L.
- Unrealized P/L.

Phase 7 is intentionally narrowed to BUY execution only.

Future phases:

```text
Phase 7: PaperExchange Buy Engine
Phase 7.5: PaperExchange Sell Engine + Realized / Unrealized P&L
Phase 8: SessionManager + Target Control
```

This keeps the execution layer auditable before adding close-position behavior.

## 3. Primary Outcome

The command:

```bash
pnpm paper:execute --once
```

should:

- Find approved BUY candidates.
- Create paper `Order` records.
- Create simulated `Fill` records.
- Open `Position` records.
- Decrement paper cash.
- Mark `TokenRadar` rows as `BOUGHT`.
- Preserve audit history.

## 4. Pipeline

```text
SELECT APPROVED TOKEN
-> VALIDATE SESSION
-> VALIDATE CASH
-> VALIDATE NO OPEN POSITION
-> CREATE ORDER
-> CREATE QUOTE CONTEXT
-> CREATE FILL
-> OPEN POSITION
-> UPDATE SESSION CASH
-> UPDATE TOKENRADAR TO BOUGHT
-> LOG
```

## 5. Scope

In scope:

- `Order`
- `Fill`
- `Position`
- `Session.currentCashLamports`
- `TokenRadar.status`
- `SystemLog`
- `PAPER` mode only

Out of scope:

- Closing positions.
- SELL fills.
- Realized P/L.
- Unrealized P/L.
- `PositionSnapshot`.
- `EquitySnapshot`.
- Wallet loading.
- Transaction signing.
- Transaction submission.
- Real swaps.

## 6. Definition Of Done

- [x] `paper:execute` command exists.
- [x] `PaperExchangeConfig` exists.
- [x] `PaperExecutionCandidateSelector` exists.
- [x] Approved BUY selection exists.
- [x] Order creation exists.
- [x] Fill creation exists.
- [x] Position opening exists.
- [x] Session cash decrement exists.
- [x] TokenRadar `BOUGHT` transition exists.
- [x] Dry-run behavior exists.
- [x] Duplicate position protection exists.
- [x] Insufficient cash rejection exists.
- [x] Missing price rejection exists.
- [x] Safety boundary tests exist.
- [x] Documentation is updated.
- [x] Verification commands pass.

## 7. Runtime Command

Main command:

```bash
pnpm paper:execute --once
```

Supported forms:

```bash
pnpm paper:execute --once
pnpm paper:execute --dry-run
pnpm paper:execute --session-id=session_123
pnpm paper:execute --buy-sol=0.01
pnpm paper:execute --limit=10
```

## 8. Defaults

```text
buySol = 0.01
limit = 10
dryRun = false
once = false
```

## 9. Session Policy

Explicit `--session-id`:

- Session must exist.
- Session must be `PAPER`.
- Session must be `RUNNING`.
- Otherwise fail with a clear message.

If `--session-id` is not supplied:

- Use the latest `PAPER` + `RUNNING` session that has approved execution candidates.
- Do not auto-create a session.
- If none exists, fail with a clear message.

## 10. Candidate Selection

Add:

```text
backend/src/paper/PaperExecutionCandidateSelector.ts
```

Select only candidates where:

```text
StrategyDecision.decision = BUY
TokenRadar.status = APPROVED
StrategyDecision.sessionId = TokenRadar.sessionId
StrategyDecision.mintAddress = TokenRadar.mintAddress
```

Exclude `TokenRadar` rows with these statuses:

- `DISCOVERED`
- `WATCHING`
- `REJECTED`
- `BOUGHT`
- `IGNORED`
- `ERROR`

## 11. Duplicate Position Protection

Use:

```ts
PositionRepository.getOpenPositionByMint(sessionId, mintAddress);
```

If an open position already exists:

- Create an `Order`.
- Mark the order `REJECTED`.
- Use reason `OPEN_POSITION_EXISTS`.
- Do not create a fill.
- Do not create a position.
- Do not update cash.

## 12. Buy Size

Default:

```text
0.01 SOL
```

Override:

```bash
pnpm paper:execute --buy-sol=0.05
```

Store the requested buy amount in `Order.requestedSolLamports`.

## 13. Simulated Price Source

Use:

```text
TokenRadar.priceSol
```

If `priceSol` is missing:

- Create an `Order`.
- Mark the order `REJECTED`.
- Use reason `MISSING_PRICE_SOL`.
- Do not create a fill.
- Do not create a position.
- Do not update cash.

## 14. Fee Defaults

Use:

```text
baseFeeLamports = 5000
priorityFeeLamports = 0
```

Store these values in the `Fill`.

## 15. Slippage Defaults

Use:

```text
slippageBps = 100
```

This represents 1%.

Compute:

```text
estimatedSlippageLamports = requestedSolLamports * slippageBps / 10000
```

Store this value in the `Fill`.

## 16. Price Impact

Source:

- Latest risk evidence snapshot.
- Current compact `rawProviderDataJson`.

Fallback:

```text
priceImpactBps = 0
```

Store the resolved value in the `Fill`.

## 17. Cash Validation

Require:

```text
currentCashLamports >= requestedSolLamports
  + baseFeeLamports
  + priorityFeeLamports
  + estimatedSlippageLamports
```

If available cash is insufficient:

- Create an `Order`.
- Mark the order `REJECTED`.
- Use reason `INSUFFICIENT_CASH`.
- Do not create a fill.
- Do not create a position.
- Do not update cash.

## 18. Order Lifecycle

Successful paper buy:

```text
CREATED -> QUOTED -> FILLED
```

Business-rule rejection:

```text
CREATED -> REJECTED
```

Unexpected error:

```text
CREATED -> FAILED
```

## 19. Order Creation

Create an `Order` with:

- `sessionId`
- `side = BUY`
- `mintAddress`
- `requestedSolLamports`
- `strategyDecisionId`
- `reason`
- `rawOrderJson`
- `status = CREATED`

## 20. Quote Context

After order creation, mark the order `QUOTED`.

Attach compact simulated quote context through:

```ts
OrderRepository.linkOrderToQuote(id, input);
```

Include:

- `priceSol`
- `priceUsd`
- `quoteSource`
- `priceImpactBps`
- `slippageBps`

## 21. Fill Creation

Create a `Fill` with:

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

## 22. Token Amount Calculation

Compute:

```text
tokensFilled = requestedSol / priceSol
```

Store the token amount as a decimal string.

Do not use floating-point arithmetic for final lamport accounting.

## 23. Position Creation

Create an `OPEN` `Position` with:

- `sessionId`
- `mintAddress`
- `status = OPEN`
- `openedAtMs`
- `avgEntryPriceSol`
- `tokensHeld`
- `costBasisLamports`
- `feesPaidLamports`

## 24. Cash Update

Compute:

```text
totalCostLamports = requestedSolLamports
  + baseFeeLamports
  + priorityFeeLamports
  + estimatedSlippageLamports
```

Then:

```text
currentCashLamports -= totalCostLamports
```

Use:

```ts
SessionRepository.updateSessionPnl(id, input);
```

## 25. TokenRadar Status Update

Update `TokenRadar.status` to `BOUGHT` only after all of these succeed:

- Order creation.
- Fill creation.
- Position creation.
- Cash update.

This should be the final persistence step.

## 26. Failure Handling

Expected rejections:

- `INSUFFICIENT_CASH`
- `OPEN_POSITION_EXISTS`
- `MISSING_PRICE_SOL`

Expected rejections should create an `Order` and mark it `REJECTED`.

Unexpected failures:

- Database failure.
- Serialization failure.
- Mapping failure.

Unexpected failures should mark the order `FAILED` when possible.

Only set `TokenRadar.status = ERROR` for unrecoverable persistence or mapping failures.

## 27. Dry-Run Behavior

Dry-run may perform:

- Candidate selection.
- Session validation.
- Cash checks.
- Quote simulation.
- Fill calculation.

Dry-run must skip:

- Order writes.
- Fill writes.
- Position writes.
- Session cash updates.
- TokenRadar status updates.

## 28. Logging

Log:

- Candidate count.
- Executed buys.
- Rejections.
- Failures.
- Cash updates.

Example summary:

```text
selected=10 executed=4 rejected=5 failed=1 openedPositions=4 cashUpdated=4
```

Implementation note:

- The source checklist proposed `PAPER_EXECUTION` as the log scope.
- The current schema already has an `EXECUTION` scope.
- To avoid a Phase 7 migration, use `EXECUTION` for Phase 7 paper-execution logs.
- Add a dedicated `PAPER_EXECUTION` enum later only if the log taxonomy needs that extra distinction.

## 29. File Plan

Add:

```text
backend/src/paper/PaperExchangeConfig.ts
backend/src/paper/PaperExecutionCandidateSelector.ts
backend/src/paper/PaperExecutionService.ts
backend/src/paper/PaperOrderFactory.ts
backend/src/paper/PaperFillFactory.ts
backend/src/paper/PaperPositionFactory.ts
backend/src/paper/PaperRunner.ts
backend/src/scripts/paper-execute.ts
```

Add tests under:

```text
backend/src/paper/*.test.ts
```

## 30. Testing Plan

Config tests:

- Defaults.
- CLI overrides.
- Bound checks.

Candidate tests:

- `APPROVED` filtering.
- `BUY` filtering.
- Session resolution.

Execution tests:

- Order creation.
- Fill creation.
- Position creation.
- Cash update.
- TokenRadar `BOUGHT` transition.

Rejection tests:

- Missing `priceSol`.
- Insufficient cash.
- Open position already exists.

Boundary tests:

- Creates `Order`.
- Creates `Fill`.
- Creates `Position`.
- Does not load wallet material.
- Does not sign transactions.
- Does not submit transactions.
- Does not perform live trades.

## 31. Documentation Plan

Update:

- `README.md`
- `docs/ROADMAP.md`
- `docs/DECISIONS.md`
- `docs/Structure.md`

Create:

- `docs/architecture/paper-exchange.md`
- `docs/NeXusTrade-Phase-7-Detailed-Checklist.md`
- `docs/Phase-7.5-Planning-Inputs.md`

## 32. Commit Plan

Suggested commit slices:

```text
phase7: add paper exchange runtime
phase7: add candidate selection
phase7: add order creation
phase7: add fill and position creation
phase7: add cash updates and tokenradar transitions
phase7: add tests and documentation
```

## 33. Verification Commands

Run:

```bash
corepack pnpm verify
corepack pnpm paper:execute --once --dry-run
corepack pnpm paper:execute --once
```

Expected output for a qualifying candidate:

```text
selected=1 executed=1 openedPositions=1 cashUpdated=1
```

If there are no qualifying `BUY` + `APPROVED` candidates, `paper:execute` should exit cleanly with a clear zero-selected summary.

## 34. Acceptance Criteria

`pnpm paper:execute --once` can:

- Select `APPROVED` + `BUY` candidates.
- Create `Order` records.
- Create `Fill` records.
- Create `Position` records.
- Decrement paper cash.
- Mark `TokenRadar` rows as `BOUGHT`.
- Prevent duplicate open positions.
- Reject insufficient cash.
- Reject missing prices.

It must remain paper-only and must not:

- Load wallets.
- Sign transactions.
- Submit transactions.
- Touch live trading.

## 35. Phase 7.5 Handoff

Phase 7.5 should consume:

```text
OPEN Positions
+ Live Quotes
```

It should introduce:

- SELL decisions.
- SELL orders.
- SELL fills.
- Position closing.
- Realized P/L.
- Unrealized P/L.

Phase 7 opens positions.

Phase 7.5 closes positions.

## Implementation Notes Before Coding

Phase 7 is implementable with the current schema and repository surfaces. No migration is expected if we use the existing `EXECUTION` `SystemLog` scope.

Known constraints:

- A real non-dry run needs an existing `PAPER` + `RUNNING` session with at least one `StrategyDecision(BUY)` and matching `TokenRadar(APPROVED)` row.
- The most recent local Phase 6 smoke output may contain `SKIP` rather than `BUY`, so Phase 7 verification may need a seeded fixture or fresher qualifying scanner/risk/strategy data.
- Simulated buy price depends on `TokenRadar.priceSol`; missing prices should reject orders.
- Position snapshots and SELL simulation are intentionally deferred.
- Database-level uniqueness for open positions is deferred; Phase 7 should enforce duplicate protection at the application layer.

## Phase Notes

- 2026-06-21: Implemented `pnpm paper:execute` with paper-only BUY execution, dry-run behavior, expected rejection orders, simulated fills, open positions, cash decrement, TokenRadar `BOUGHT` transition, `EXECUTION` logs, and safety boundary tests.
- 2026-06-21: `corepack pnpm verify` passed.
- 2026-06-21: `corepack pnpm paper:execute --once --dry-run` passed against the local paper database. It selected one candidate and rejected it in dry-run because an open position already exists for the same session and mint, validating duplicate-position protection without writing a new order.
