# NeXusTrade Phase 7.5 Detailed Checklist

PaperExchange SELL Engine + Realized P/L

Last updated: June 2026

Status: Complete. The detailed checklist below is retained as the original implementation plan; the
completed implementation summary captures the shipped Phase 7.5 surface.

Mode: `PAPER` only.

## Executive Summary

Phase 7.5 implements the dedicated SELL side of PaperExchange.

Phase 7 created the BUY path:

```text
BUY Decision
-> BUY Order
-> BUY Fill
-> OPEN Position
```

Phase 7.5 creates the SELL path:

```text
OPEN Position
+ fresh quote or refreshed price
-> SELL Order
-> SELL Fill
-> Position(CLOSED)
-> Session cash update
-> realized P/L
-> TokenRadar(WATCHING)
```

Phase 7.5 does not implement automatic target-profit exits, stop-loss automation, trailing stops,
full session governance, or session completion. Those belong to Phase 8.

The first implementation should be audit-grade but migration-light. Do not require a database
migration unless the project later decides to promote SELL audit details into first-class queryable
columns.

## Locked Clarifications

- [x] Do not require a database migration for the first pass.
- [x] Store SELL audit details in existing JSON fields where practical.
- [x] Use `Order.requestedTokenAmount` for the token quantity being sold.
- [x] Use `Order.rawOrderJson` for `positionId`, trigger context, selection context, and sell
      metadata.
- [x] Use `Fill.solReceivedLamports` for net sell proceeds.
- [x] Use `Fill.rawQuoteJson` for gross proceeds, fees, slippage, quote timestamp, provider
      details, and fallback details.
- [x] Add first-class columns only in a later migration if repeated querying proves necessary.
- [x] Plain `pnpm paper:sell --once` must fail clearly unless an explicit sell trigger is supplied.
- [x] Supported explicit triggers are `--sell-all` and `--mint=<mint>`.
- [x] Do not close all positions by default from plain `--once`.
- [x] Prefer a fresh MarketDataService sell quote when decimals and quote path are available.
- [x] Fall back to refreshed price when exact quote construction is unavailable.
- [x] Fall back to cached TokenRadar price only when explicitly allowed and not stale.
- [x] Missing quote or missing usable price must produce `Order(REJECTED)`.
- [x] Position snapshots remain out of scope until Phase 8.
- [ ] Add a small repository transaction boundary if practical.
- [x] If a transaction wrapper is not practical immediately, preserve deterministic ordered writes
      and document the limitation.

## Completed Implementation Summary

- [x] Added `pnpm paper:sell` and backend `paper:sell` scripts.
- [x] Required explicit SELL triggers with `--sell-all` or `--mint=<mint>`.
- [x] Kept `pnpm paper:sell --once` rejected without an explicit trigger.
- [x] Selected only OPEN paper positions from a PAPER/RUNNING session.
- [x] Supported latest active paper session selection when `--session-id` is omitted.
- [x] Added dry-run behavior that exercises selection, quote resolution, accounting, and logs without
      writes.
- [x] Added quote/price fallback through fresh quote, refreshed price, and opt-in fresh cached
      TokenRadar price.
- [x] Created SELL orders, quote updates, SELL fills, and position close records using the existing
      schema.
- [x] Restored session cash and recorded realized P/L after successful closes.
- [x] Returned TokenRadar from `BOUGHT` to `WATCHING` after successful closes.
- [x] Created rejected order records for expected business rejections.
- [x] Preserved SELL audit context in existing JSON fields.
- [x] Added EXECUTION logs for sell close, rejection, dry-run, and unexpected failure paths.
- [x] Documented the paper sell architecture and Phase 8 handoff inputs.
- [x] Added Phase 7.5 unit/integration coverage for success, dry-run, price fallback, stale cache
      rejection, mint filtering, and repeated-run safety.

## Repository Alignment Notes

- [x] `Fill` currently has no `mintAddress` column; infer mint through the related `Order` and store
      mint in `Fill.rawQuoteJson`.
- [x] `Fill` currently has no `side` column; infer side through the related `Order`.
- [x] `Order` currently has no `positionId` column; store `positionId` in `Order.rawOrderJson`.
- [x] Backend package script should use `tsx src/scripts/paper-sell.ts`, matching existing backend
      scripts.
- [x] Tests should live under `backend/src/paper/*.test.ts`, matching the current Vitest setup.
- [x] `MarketDataService` currently exposes `enrichToken(...)`; Phase 7.5 should add a
      PaperSellQuoteService wrapper instead of assuming a direct `getSellQuote(...)` method exists.
- [x] `PositionRepository.closePosition(...)` exists; add `markPositionClosing(...)` only if the
      implementation uses the `OPEN -> CLOSING -> CLOSED` transition.

## Goal

Build the first complete paper SELL execution path.

- [ ] Select existing open paper positions.
- [ ] Require an explicit human/developer sell trigger.
- [ ] Refresh pricing or quote evidence.
- [ ] Validate sellability assumptions.
- [ ] Create SELL orders.
- [ ] Create SELL fills.
- [ ] Close positions.
- [ ] Restore paper session cash.
- [ ] Calculate realized P/L.
- [ ] Update TokenRadar status back to `WATCHING`.
- [ ] Produce logs sufficient to debug every exit.
- [ ] Preserve audit details in existing schema fields.
- [ ] Keep the implementation paper-only.
- [ ] Avoid wallet loading.
- [ ] Avoid transaction signing.
- [ ] Avoid transaction submission.

## Scope

In scope:

- [ ] SELL order creation.
- [ ] SELL fill creation.
- [ ] Open position selection.
- [ ] Position close operation.
- [ ] Session cash restoration.
- [ ] Realized P/L calculation.
- [ ] Basic quote/price refresh.
- [ ] Dry-run sell simulation.
- [ ] Rejection handling.
- [ ] Structured logging.
- [ ] Existing-schema audit storage.

Out of scope:

- [ ] Target-profit automation.
- [ ] Stop-loss automation.
- [ ] Trailing-stop automation.
- [ ] Automatic liquidation.
- [ ] Session completion.
- [ ] Position snapshots.
- [ ] Equity snapshots.
- [ ] Live swap transactions.
- [ ] Wallet loading.
- [ ] Transaction signing.
- [ ] Transaction submission.
- [ ] DB migration unless explicitly chosen later.

## Definition Of Done

- [x] `paper:sell` script exists.
- [x] CLI parsing exists.
- [x] Plain `--once` without trigger fails safely.
- [x] `--sell-all` trigger exists.
- [x] `--mint=<mint>` trigger exists.
- [x] `--session-id=<id>` filter exists.
- [x] `--dry-run` exists.
- [x] Candidate selector finds open positions.
- [x] Candidate selector rejects non-open positions.
- [x] Sell validation exists.
- [x] Quote refresh layer exists.
- [x] Price fallback layer exists.
- [x] SELL order creation exists.
- [x] SELL fill creation exists.
- [x] Position close behavior exists.
- [x] Session cash update exists.
- [x] Realized P/L calculation exists.
- [x] TokenRadar `WATCHING` transition exists.
- [x] Rejection taxonomy is implemented.
- [x] Logs are written.
- [x] Tests pass.
- [x] Documentation is updated.
- [x] `Structure.md` is updated.

## Runtime Commands

Supported:

```bash
pnpm paper:sell --once --sell-all
pnpm paper:sell --once --mint=<mint>
pnpm paper:sell --once --session-id=session_123 --sell-all
pnpm paper:sell --once --session-id=session_123 --mint=<mint>
pnpm paper:sell --once --sell-all --dry-run
pnpm paper:sell --once --mint=<mint> --dry-run
```

Rejected:

```bash
pnpm paper:sell --once
```

- [ ] Reject plain `--once` without `--sell-all` or `--mint`.
- [ ] Print a clear error for missing explicit trigger.
- [ ] Exit non-zero for missing trigger.
- [ ] Do not silently sell all positions.
- [ ] Do not silently choose the latest position.
- [ ] Require operator intent for every SELL run.

## Runtime Defaults

```text
mode=PAPER
once=false
dryRun=false
limit=10
slippageBps=100
baseFeeLamports=5000
priorityFeeLamports=0
allowCachedRadarPrice=false
maxCachedPriceAgeMs=60000
quoteSource=MarketDataService
```

- [ ] Keep `PAPER` mode mandatory.
- [ ] Keep cached TokenRadar price fallback disabled by default.
- [ ] Validate numeric runtime options.
- [ ] Reject negative limits.
- [ ] Reject negative slippage.
- [ ] Reject invalid mint values.
- [ ] Reject conflicting trigger combinations if needed.

## Session Policy

Explicit session:

```bash
--session-id=session_123
```

No session supplied:

```text
Find latest PAPER RUNNING session with eligible OPEN positions.
```

Rules:

- [ ] Validate session exists.
- [ ] Validate session mode is `PAPER`.
- [ ] Validate session status is `RUNNING`.
- [ ] Validate session has eligible open positions.
- [ ] Do not auto-create sessions.
- [ ] Do not complete sessions.
- [ ] Do not modify target settings.
- [ ] Keep session lifecycle status unchanged.
- [ ] Log selected session.
- [ ] Reject `LIVE` sessions.
- [ ] Reject `BACKTEST` sessions for this phase.

## Explicit Trigger Policy

- [ ] Require `--sell-all` or `--mint=<mint>`.
- [ ] Treat missing trigger as a configuration error.
- [ ] Treat `--sell-all` as permission to sell all eligible positions in selected session scope.
- [ ] Treat `--mint` as permission to sell one open position for that mint.
- [ ] If multiple open positions for one mint exist, reject with `AMBIGUOUS_MINT_POSITION`.
- [ ] Log trigger type.
- [ ] Include trigger type in `Order.rawOrderJson`.
- [ ] Include sanitized CLI arguments in run context.

## Candidate Selection

Create:

```text
backend/src/paper/PaperSellCandidateSelector.ts
```

Responsibilities:

- [ ] Select open positions.
- [ ] Apply session filter.
- [ ] Apply mint filter.
- [ ] Apply sell-all trigger.
- [ ] Enforce limit.
- [ ] Return deterministic order.
- [ ] Return structured selection summary.
- [ ] Avoid provider calls.
- [ ] Avoid accounting logic.
- [ ] Avoid persistence writes beyond logs when needed.

Eligible position:

```text
Position.status = OPEN
```

Required fields:

- [ ] Position ID exists.
- [ ] Session ID exists.
- [ ] Mint address exists.
- [ ] `tokensHeld` exists.
- [ ] `tokensHeld` is greater than zero.
- [ ] `costBasisLamports` exists.
- [ ] `feesPaidLamports` exists or safely defaults to zero.
- [ ] Position belongs to selected paper session.
- [ ] Position is not `CLOSED`.
- [ ] Position is not `CLOSING` unless retry policy explicitly supports it.

## Position Validation Rejections

- [ ] `POSITION_NOT_FOUND`
- [ ] `POSITION_NOT_OPEN`
- [ ] `POSITION_ALREADY_CLOSED`
- [ ] `INVALID_POSITION_SIZE`
- [ ] `INVALID_SESSION`
- [ ] `MISSING_COST_BASIS`
- [ ] `MISSING_TOKEN_AMOUNT`
- [ ] `AMBIGUOUS_MINT_POSITION`
- [ ] `SESSION_NOT_RUNNING`
- [ ] `SESSION_NOT_PAPER`

## Quote And Price Fallback

Required fallback hierarchy:

```text
1. Fresh sell quote when decimals and quote path are available.
2. Fresh/refreshed token price when exact quote cannot be constructed.
3. Cached TokenRadar.priceSol only if explicitly allowed and not stale.
4. Reject if no usable pricing exists.
```

- [ ] Attempt fresh quote first.
- [ ] Resolve token decimals when needed.
- [ ] Use refreshed metadata if decimals are missing.
- [ ] Use refreshed price if quote cannot be built.
- [ ] Use cached price only when allowed.
- [ ] Enforce stale-price limits.
- [ ] Store quote path used in audit JSON.
- [ ] Store fallback reason in audit JSON.
- [ ] Reject missing price as `MISSING_SELL_PRICE`.
- [ ] Reject quote unavailable as `QUOTE_UNAVAILABLE`.

## Token Decimal Handling

SELL quote construction may require token decimal information.

Sources:

- [ ] TokenRadar raw enrichment JSON.
- [ ] MarketDataService metadata refresh.
- [ ] Helius metadata/account adapter.
- [ ] Jupiter token metadata adapter where available.

Rules:

- [ ] Do not assume decimals when unknown.
- [ ] Do not convert decimal token amount to atomic amount without decimals.
- [ ] If decimals are unavailable, use refreshed price fallback.
- [ ] If refreshed price is unavailable, use allowed non-stale cached price.
- [ ] If no price is available, reject order.
- [ ] Store decimal source in raw quote/order JSON.

## Pricing Freshness

- [ ] Fresh quote should include fetched-at timestamp.
- [ ] Refreshed price should include fetched-at timestamp.
- [ ] Cached TokenRadar price should use `updatedAtMs`, `discoveredAtMs`, or source timestamp when
      available.
- [ ] Stale cached prices should be rejected.
- [ ] Default cached fallback should be disabled.
- [ ] If cached fallback is enabled, store that decision in raw audit JSON.
- [ ] Store price age in raw quote JSON.
- [ ] Store quote age in raw quote JSON.
- [ ] Log stale quote rejection.
- [ ] Log cached fallback usage.

## Liquidity Validation

- [ ] Check quote output exists when using quote path.
- [ ] Check price exists when using price path.
- [ ] Check output amount is positive.
- [ ] Check estimated price impact if available.
- [ ] Reject impossible fills.
- [ ] Reject zero proceeds.
- [ ] Reject negative proceeds.
- [ ] Record missing liquidity evidence as warning when using price fallback.
- [ ] Use `INSUFFICIENT_LIQUIDITY` when quote indicates no viable route.
- [ ] Do not invent liquidity assumptions beyond configured model.

## SELL Order Lifecycle

Successful:

```text
CREATED -> QUOTED -> FILLED
```

Business rejection:

```text
CREATED -> REJECTED
```

Unexpected failure:

```text
CREATED -> FAILED
```

- [ ] Create order before fill.
- [ ] Store validation context.
- [ ] Store quote context.
- [ ] Store rejection reason when rejected.
- [ ] Store failure reason when failed.
- [ ] Do not create fill for rejected order.
- [ ] Do not close position for rejected order.
- [ ] Do not update cash for rejected order.
- [ ] Do not update TokenRadar for rejected order.

## Existing-Schema Storage

SELL order:

- [ ] `Order.side = SELL`
- [ ] `Order.sessionId = selected session`
- [ ] `Order.mintAddress = position.mintAddress`
- [ ] `Order.requestedTokenAmount = position.tokensHeld`
- [ ] `Order.status = CREATED | QUOTED | FILLED | REJECTED | FAILED`
- [ ] `Order.rawOrderJson.positionId = position.id`
- [ ] `Order.rawOrderJson.triggerType = SELL_ALL | MINT`
- [ ] `Order.rawOrderJson.selectionContext = sanitized selection details`
- [ ] `Order.rawOrderJson.positionContext = compact position details`
- [ ] `Order.rawOrderJson.priceSourcePolicy = quote fallback policy`
- [ ] `Order.rawOrderJson.rejectionCode = code when rejected`
- [ ] `Order.rawOrderJson.failureCode = code when failed`

SELL fill:

- [ ] `Fill.orderId = sell order id`
- [ ] `Fill.sessionId = session id`
- [ ] `Fill.tokensFilled = sold quantity`
- [ ] `Fill.solReceivedLamports = netSellProceedsLamports`
- [ ] `Fill.rawQuoteJson.mintAddress = mint`
- [ ] `Fill.rawQuoteJson.side = SELL`
- [ ] `Fill.rawQuoteJson.grossProceedsLamports = computed gross proceeds`
- [ ] `Fill.rawQuoteJson.netSellProceedsLamports = computed net proceeds`
- [ ] `Fill.rawQuoteJson.sellFeesLamports = fees`
- [ ] `Fill.rawQuoteJson.sellSlippageLamports = slippage`
- [ ] `Fill.rawQuoteJson.priceImpactBps = price impact when available`
- [ ] `Fill.rawQuoteJson.quoteFetchedAtMs = quote timestamp`
- [ ] `Fill.rawQuoteJson.quoteProvider = provider name`
- [ ] `Fill.rawQuoteJson.fallbackUsed = true/false`
- [ ] `Fill.rawQuoteJson.priceSource = quote | refreshed_price | cached_radar_price`

Position close:

- [ ] Set status to `CLOSED`.
- [ ] Set closed timestamp.
- [ ] Set exit price when existing field supports it.
- [ ] Set proceeds.
- [ ] Set realized P/L.
- [ ] Update `feesPaidLamports` to include buy + sell fees.
- [ ] Preserve `costBasisLamports`.
- [ ] Preserve original open details.
- [ ] Store additional close details in related order/fill JSON.

## Optional Future Migration Notes

Do not implement these in the first pass unless explicitly chosen:

- [ ] `Order.positionId`
- [ ] `Fill.grossProceedsLamports`
- [ ] `Fill.netProceedsLamports`
- [ ] `Fill.sellFeesLamports`
- [ ] `Fill.sellSlippageLamports`
- [ ] `Fill.priceSource`
- [ ] `Fill.quoteProvider`
- [ ] `Fill.quoteFetchedAtMs`
- [ ] `Position.exitOrderId`
- [ ] `Position.exitFillId`

Migration decision rule:

- [ ] Add migration only if reporting/querying needs justify it.
- [ ] Keep first implementation simple and stable.

## Position Lifecycle And Transaction Policy

Target lifecycle:

```text
OPEN -> CLOSING -> CLOSED
```

Preferred:

- [ ] Add `markPositionClosing()` repository method if using the `CLOSING` step.
- [ ] Use `closePosition()` for final close.
- [ ] Wrap order/fill/position/session/radar updates in a transaction if practical.

Fallback:

- [ ] Use deterministic ordered writes like Phase 7.
- [ ] Create order.
- [ ] Create fill.
- [ ] Close position.
- [ ] Update session cash.
- [ ] Update TokenRadar.
- [ ] Log any partial failure clearly.

Transaction scope if practical:

```text
Create SELL order
Create SELL fill
Close position
Update session cash
Update TokenRadar
Write critical logs
```

Rules:

- [ ] Never update session cash before fill creation.
- [ ] Never close position before fill creation.
- [ ] Never mark TokenRadar `WATCHING` before position close succeeds.
- [ ] Document non-transactional fallback if used.

## Accounting Model

Mandatory formulas:

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

At close:

```text
position.feesPaidLamports =
buyFees + sellFees
```

- [ ] Use lamports for SOL accounting.
- [ ] Avoid floating-point errors where practical.
- [ ] Convert decimal prices carefully.
- [ ] Store intermediate values in raw quote JSON.
- [ ] Test profitable close.
- [ ] Test losing close.
- [ ] Test break-even close.
- [ ] Test fee-heavy close.
- [ ] Test slippage-heavy close.

Gross proceeds:

- [ ] Compute gross proceeds before fees.
- [ ] Compute gross proceeds before slippage deduction.
- [ ] Store gross proceeds in `Fill.rawQuoteJson`.
- [ ] Reject zero gross proceeds.
- [ ] Reject negative gross proceeds.
- [ ] Preserve calculation inputs.

Net proceeds:

- [ ] Compute net proceeds after sell fees.
- [ ] Compute net proceeds after sell slippage.
- [ ] Store net proceeds in `Fill.solReceivedLamports`.
- [ ] Store net proceeds in `Fill.rawQuoteJson`.
- [ ] Reject negative net proceeds unless explicitly modeling catastrophic exit.
- [ ] Add net proceeds to session cash.
- [ ] Do not add gross proceeds to session cash.
- [ ] Use net proceeds for realized P/L.

## Fee, Slippage, And Price Impact

Fee defaults:

```text
baseFeeLamports = 5000
priorityFeeLamports = 0
```

Slippage default:

```text
slippageBps = 100
```

Formula:

```text
sellSlippageLamports =
grossProceedsLamports * slippageBps / 10000
```

Rules:

- [ ] Include base fee in sell fees.
- [ ] Include priority fee in sell fees.
- [ ] Store fee assumptions in raw quote JSON.
- [ ] Apply slippage against seller.
- [ ] Preserve provider price impact when available.
- [ ] Store price impact bps in raw quote JSON.
- [ ] Do not require price impact when using refreshed price fallback.
- [ ] Reject only if configured max impact is exceeded.
- [ ] Keep strategy-level impact decisions deferred to Phase 8 unless necessary.

## Session Cash And P/L

Cash update:

```text
session.currentCashLamports += netSellProceedsLamports
```

Rules:

- [ ] Update cash only after successful SELL fill.
- [ ] Use net proceeds only.
- [ ] Do not update cash for rejected orders.
- [ ] Do not update cash for failed orders.
- [ ] Keep session status `RUNNING`.
- [ ] Do not evaluate target profit.
- [ ] Do not complete session.
- [ ] Store realized P/L on `Position`.
- [ ] Store realized P/L in SystemLog.
- [ ] Leave P/L rollups for Phase 8+.

## TokenRadar Transition

After successful close:

```text
BOUGHT -> WATCHING
```

- [ ] Update TokenRadar only after position close succeeds.
- [ ] Do not update TokenRadar for rejected order.
- [ ] Do not update TokenRadar for failed order.
- [ ] Preserve radar history.
- [ ] Do not create new radar statuses for Phase 7.5.
- [ ] Log transition.

## Rejection Taxonomy

Required codes:

```text
MISSING_SELL_PRICE
POSITION_NOT_FOUND
POSITION_ALREADY_CLOSED
POSITION_NOT_OPEN
INVALID_POSITION_SIZE
INSUFFICIENT_LIQUIDITY
QUOTE_UNAVAILABLE
INVALID_SESSION
SESSION_NOT_RUNNING
SESSION_NOT_PAPER
AMBIGUOUS_MINT_POSITION
MISSING_EXPLICIT_TRIGGER
STALE_PRICE
MISSING_DECIMALS
```

- [ ] Every rejection has a code.
- [ ] Every rejection has a human-readable message.
- [ ] Every rejection is written to order raw JSON if order exists.
- [ ] Pre-order configuration rejections may exit before order creation.
- [ ] Do not create fills for rejected orders.
- [ ] Log rejection summary.

## Failure Handling And Idempotency

Business rejections:

- [ ] Missing price.
- [ ] Missing quote.
- [ ] Stale price.
- [ ] Closed position.
- [ ] Invalid size.

Unexpected failures:

- [ ] Database write failure.
- [ ] Serialization failure.
- [ ] Repository failure.
- [ ] Provider exception.
- [ ] Math/conversion failure.

Rules:

- [ ] Mark order `FAILED` for unexpected failure after order creation.
- [ ] Avoid double-closing positions.
- [ ] Avoid double-adding cash.
- [ ] Prevent selling an already closed position.
- [ ] Prevent selling a `CLOSING` position unless retry policy supports it.
- [ ] Check for existing filled SELL order for same position if practical.
- [ ] Make retry behavior explicit.
- [ ] Add tests for repeated command execution.

## Dry Run

Dry run may:

- [ ] Select positions.
- [ ] Refresh quote/price.
- [ ] Calculate gross proceeds.
- [ ] Calculate fees.
- [ ] Calculate slippage.
- [ ] Calculate net proceeds.
- [ ] Calculate realized P/L.
- [ ] Print/log summary.

Dry run must not:

- [ ] Create orders.
- [ ] Create fills.
- [ ] Close positions.
- [ ] Update session cash.
- [ ] Update TokenRadar.
- [ ] Create snapshots.

## Logging And Summary

SystemLog scope:

```text
EXECUTION
```

Log events:

- [ ] SELL runner startup.
- [ ] CLI config parsed.
- [ ] Missing trigger rejection.
- [ ] Session selected.
- [ ] Candidates selected.
- [ ] Quote refresh attempt.
- [ ] Quote fallback used.
- [ ] Order created.
- [ ] Order rejected.
- [ ] Fill created.
- [ ] Position closed.
- [ ] Session cash updated.
- [ ] TokenRadar updated.
- [ ] Realized P/L summary.
- [ ] Runner completion.

End-of-run summary:

- [ ] selected count
- [ ] quoted count
- [ ] refreshed price count
- [ ] cached fallback count
- [ ] rejected count
- [ ] failed count
- [ ] closed count
- [ ] total gross proceeds
- [ ] total net proceeds
- [ ] total realized P/L
- [ ] total sell fees
- [ ] total slippage
- [ ] dry-run indicator

## Repository Planning

Likely repository usage:

- [ ] `SessionRepository`
- [ ] `PositionRepository`
- [ ] `OrderRepository`
- [ ] `FillRepository`
- [ ] `TokenRadarRepository`
- [ ] `SystemLogRepository`

Recommended additions:

- [ ] `PositionRepository.markPositionClosing()` if practical.
- [ ] Transaction helper if practical.

Existing methods likely sufficient:

- [ ] `PositionRepository.listOpenPositions(sessionId)`
- [ ] `PositionRepository.getOpenPositionByMint(sessionId, mintAddress)`
- [ ] `PositionRepository.closePosition(id, input)`
- [ ] `SessionRepository.updateSessionPnl(id, input)`
- [ ] `OrderRepository.createOrder(input)`
- [ ] `OrderRepository.linkOrderToQuote(id, input)`
- [ ] `OrderRepository.updateOrderStatus(id, status, context?)`
- [ ] `FillRepository.createFill(input)`

## Service Planning

Create:

```text
backend/src/paper/PaperSellConfig.ts
backend/src/paper/PaperSellCandidateSelector.ts
backend/src/paper/PaperSellValidationService.ts
backend/src/paper/PaperSellQuoteService.ts
backend/src/paper/PaperSellAccountingService.ts
backend/src/paper/PaperSellOrderFactory.ts
backend/src/paper/PaperSellFillFactory.ts
backend/src/paper/PaperSellExecutionService.ts
backend/src/paper/PaperSellRunner.ts
backend/src/scripts/paper-sell.ts
```

Responsibilities:

- [ ] Config parses CLI options.
- [ ] Candidate selector finds positions.
- [ ] Validator checks sellability.
- [ ] Quote service gets quote/price/fallback evidence.
- [ ] Accounting service computes proceeds and P/L.
- [ ] Order factory builds SELL order payload.
- [ ] Fill factory builds SELL fill payload.
- [ ] Execution service orchestrates close.
- [ ] Runner handles CLI lifecycle.

## Testing Matrix

Unit tests:

- [ ] Config parsing.
- [ ] Missing trigger rejection.
- [ ] Sell-all selection.
- [ ] Mint selection.
- [ ] Ambiguous mint rejection.
- [ ] Position validation.
- [ ] Quote fallback selection.
- [ ] Cached fallback disabled.
- [ ] Cached fallback stale.
- [ ] Gross proceeds.
- [ ] Net proceeds.
- [ ] Realized P/L.
- [ ] Fee calculation.
- [ ] Slippage calculation.
- [ ] Raw JSON payload construction.

Integration tests:

- [ ] SELL order creation.
- [ ] SELL fill creation.
- [ ] Position close.
- [ ] Session cash update.
- [ ] TokenRadar transition.
- [ ] Rejected order produces no fill.
- [ ] Failed order does not close position.
- [ ] Dry run creates no writes.

Boundary tests:

- [ ] Does not load a wallet.
- [ ] Does not decrypt a wallet.
- [ ] Does not read private key material.
- [ ] Does not sign a transaction.
- [ ] Does not submit a transaction.
- [ ] Does not create live swap payload.
- [ ] Does not use live database.
- [ ] Does not create PositionSnapshot.
- [ ] Does not create EquitySnapshot.
- [ ] Does not complete session.
- [ ] Does not trigger target-profit logic.
- [ ] Does not trigger stop-loss logic.

## Documentation Plan

Update:

- [ ] `README.md`
- [ ] `docs/ROADMAP.md`
- [ ] `docs/Structure.md`
- [ ] `docs/DECISIONS.md`
- [ ] Phase 7 handoff notes.
- [ ] Phase 8 planning notes.

Create:

```text
docs/architecture/paper-sell-engine.md
docs/Phase-8-Planning-Inputs.md
```

Document:

- [ ] No-migration first-pass decision.
- [ ] Explicit trigger policy.
- [ ] Quote fallback policy.
- [ ] Existing-schema audit mapping.
- [ ] Rejection taxonomy.
- [ ] Dry-run behavior.
- [ ] Transaction-boundary limitation or implementation.

## Verification Commands

Expected commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm verify
pnpm paper:sell --once
pnpm paper:sell --once --sell-all --dry-run
pnpm paper:sell --once --mint=<mint> --dry-run
pnpm paper:sell --once --sell-all
pnpm paper:sell --once --mint=<mint>
```

Expected behavior:

- [ ] Plain `--once` fails with missing explicit trigger.
- [ ] Dry-run performs no writes.
- [ ] Sell-all closes eligible positions when not dry-run.
- [ ] Mint closes one eligible position when not dry-run.
- [ ] Rejections are visible.
- [ ] P/L is visible.
- [ ] Logs are visible.

## Phase 8 Handoff

Phase 8 consumes:

- [ ] Open positions.
- [ ] Closed positions.
- [ ] Realized P/L.
- [ ] Session cash.
- [ ] SELL orders.
- [ ] SELL fills.
- [ ] SELL rejection history.
- [ ] Quote fallback evidence.
- [ ] Fee/slippage assumptions.
- [ ] TokenRadar `WATCHING` transitions.

Phase 8 introduces:

- [ ] Target-profit control.
- [ ] Stop-loss control.
- [ ] Trailing-stop control.
- [ ] Maximum hold time exits.
- [ ] Liquidity-collapse exits.
- [ ] Session completion.
- [ ] Equity snapshots.
- [ ] Position snapshots.
- [ ] Run-level governance.

Do not implement Phase 8 logic in Phase 7.5.

## Final Implementation Statement

Phase 7.5 is ready for coding when:

- [ ] The no-migration decision is accepted.
- [ ] Existing JSON-field audit mapping is accepted.
- [ ] Explicit trigger policy is accepted.
- [ ] Quote fallback hierarchy is accepted.
- [ ] Transaction boundary approach is chosen.
- [ ] Position snapshot deferral is accepted.
- [ ] Phase 8 automation remains out of scope.

Final target:

```bash
pnpm paper:sell --once --sell-all
```

This closes eligible paper positions safely and audibly without touching live trading.

## Phase Notes

- 2026-06-21: Implemented `pnpm paper:sell` with explicit `--sell-all` and `--mint` triggers, dry-run behavior, quote/price fallback, migration-free SELL audit storage, SELL order/fill creation, position close, cash restoration, realized P/L storage, TokenRadar `WATCHING` transition, and `EXECUTION` logs.
- 2026-06-21: The first pass uses deterministic ordered writes instead of a repository-level transaction wrapper. This is documented as a Phase 8 hardening candidate.
- 2026-06-21: Backend tests passed with Phase 7.5 coverage for successful close, dry-run, missing price rejection, cached fallback disabled, stale cached fallback, mint-scoped selection, and repeated-run idempotency.
