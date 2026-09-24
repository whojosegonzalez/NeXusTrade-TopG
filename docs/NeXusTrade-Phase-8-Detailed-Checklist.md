# NeXusTrade Phase 8 Detailed Checklist

SessionManager + Snapshots + Target/Drawdown Control

Last updated: June 2026

Status: Complete.

Mode: `PAPER` only.

## Executive Summary

Phase 8 introduces `SessionManager`.

Phase 8 consumes the complete paper lifecycle created by prior phases:

```text
Scanner
-> Risk
-> Strategy
-> Paper BUY
-> OPEN Position
-> Paper SELL
-> CLOSED Position
```

Phase 8 adds:

- `SessionManager`
- `EquitySnapshot` generation
- `PositionSnapshot` generation
- unrealized P/L tracking
- equity tracking
- target-profit tracking
- drawdown tracking
- session-level BUY gating
- audit logs

Phase 8 does not:

- auto-sell positions
- trigger stop losses
- trigger trailing stops
- trigger liquidation
- call `PaperSellRunner`
- load wallets
- sign transactions
- submit transactions

Automatic exits are deferred to Phase 8.5.

## Locked Clarifications

- [x] `SessionManager` is a standalone runtime.
- [x] Root command is `pnpm session:manage --once`.
- [x] Backend script is `backend/src/scripts/session-manage.ts`.
- [x] No first-pass DB migration is required.
- [x] One `EquitySnapshot` is created per SessionManager cycle.
- [x] One `PositionSnapshot` is created per OPEN position per SessionManager cycle.
- [x] Target tracking supports SOL and percent inputs.
- [x] Drawdown tracking supports SOL and percent inputs.
- [x] Target reached gates future BUY activity.
- [x] Drawdown reached gates future BUY activity.
- [x] Open positions remain OPEN.
- [x] Manual SELL remains available through `paper:sell`.
- [x] No automatic SELL execution occurs in Phase 8.
- [x] Exit automation belongs to Phase 8.5.
- [x] Keep the current development PAPER database through Phase 8.
- [x] Archive or reset the PAPER database after Phase 8 before the first clean real-mint run.

## Schema Alignment

Phase 8 must fit the current schema.

Use existing session status values only:

```text
CREATED
RUNNING
PAUSED
COMPLETED
FAILED
CANCELLED
```

Do not add these as session statuses in Phase 8:

```text
TARGET_REACHED
DRAWDOWN_REACHED
```

Use existing termination reasons as the session gate reason:

```text
TARGET_REACHED
MAX_DRAWDOWN
NOT_TERMINATED
```

Phase 8 target/drawdown behavior:

```text
Session.status remains RUNNING
Session.terminationReason changes from NOT_TERMINATED to TARGET_REACHED or MAX_DRAWDOWN
Paper BUY rejects or skips gated sessions
Snapshots continue for RUNNING sessions even when terminationReason is not NOT_TERMINATED
Manual paper SELL remains available
```

This avoids a migration while preserving the accounting and governance boundary.

## Runtime Commands

Supported:

```bash
pnpm session:manage --once
pnpm session:manage --once --dry-run
pnpm session:manage --once --session-id=session_123
pnpm session:manage --once --target-sol=0.25
pnpm session:manage --once --target-pct=5
pnpm session:manage --once --max-drawdown-sol=0.10
pnpm session:manage --once --max-drawdown-pct=3
```

Rejected:

```bash
pnpm session:manage
pnpm session:manage --target-sol=-1
pnpm session:manage --target-pct=-1
pnpm session:manage --max-drawdown-sol=-1
pnpm session:manage --max-drawdown-pct=-1
```

## Runtime Defaults

- `mode`: `PAPER`
- `once`: required for Phase 8
- `dryRun`: `false`
- `snapshotInterval`: one cycle
- `quoteSource`: `MarketDataService`
- `allowCachedRadarPrice`: `true` for snapshots
- `allowEntryPriceFallback`: `true` for snapshots
- `allowCostBasisFallback`: `true` for snapshots

## Session Selection

When `--session-id` is supplied:

- [ ] Session must exist.
- [ ] Session must be `PAPER`.
- [ ] Session must be `RUNNING`.
- [ ] Session may already have `terminationReason != NOT_TERMINATED`.
- [ ] SessionManager still creates snapshots for gated running sessions.

When `--session-id` is omitted:

- [ ] Use the latest `PAPER` session with `status = RUNNING`.
- [ ] Do not require BUY candidates.
- [ ] Do not require OPEN positions.
- [ ] Do not auto-create a session.
- [ ] Fail clearly when no `PAPER/RUNNING` session exists.

## Session Lifecycle Rules

Phase 8 may update:

- [ ] `Session.unrealizedPnlLamports`
- [ ] `Session.terminationReason`
- [ ] `Session.updatedAtMs`

Phase 8 must not update:

- [ ] `Session.status` to `COMPLETED`
- [ ] `Session.endedAtMs`
- [ ] `Session.currentCashLamports`
- [ ] `Session.realizedPnlLamports`

Phase 8 status behavior:

```text
RUNNING + NOT_TERMINATED
-> RUNNING + TARGET_REACHED

RUNNING + NOT_TERMINATED
-> RUNNING + MAX_DRAWDOWN

RUNNING + TARGET_REACHED
-> RUNNING + TARGET_REACHED

RUNNING + MAX_DRAWDOWN
-> RUNNING + MAX_DRAWDOWN
```

If target and drawdown are both reached in the same cycle:

```text
MAX_DRAWDOWN has priority while terminationReason is NOT_TERMINATED.
```

If `terminationReason` is already not `NOT_TERMINATED`, do not overwrite it in Phase 8.

## Target Control Rules

Target sources:

- [ ] `Session.targetProfitLamports`
- [ ] `Session.targetProfitBps`
- [ ] runtime `--target-sol`
- [ ] runtime `--target-pct`

Runtime target flags are evaluation overrides for the current run. They do not require persistence in
Phase 8.

Conversion:

```text
targetProfitLamports from --target-sol =
SOL amount * 1_000_000_000

targetProfitLamports from --target-pct =
ceil(startingBalanceLamports * targetPct / 100)
```

Target reached:

```text
totalEquityLamports >= startingBalanceLamports + targetProfitLamports
```

When target is reached and session is not already gated:

- [ ] Set `terminationReason = TARGET_REACHED`.
- [ ] Keep `status = RUNNING`.
- [ ] Log target reached.
- [ ] Continue snapshots.
- [ ] Block future paper BUY activity.
- [ ] Do not sell positions.

## Drawdown Control Rules

Drawdown sources:

- [ ] `Session.maxDrawdownLamports`
- [ ] runtime `--max-drawdown-sol`
- [ ] runtime `--max-drawdown-pct`

The current schema has no `maxDrawdownBps` column. Runtime `--max-drawdown-pct` is converted to
lamports for this run:

```text
maxDrawdownLamports =
ceil(startingBalanceLamports * maxDrawdownPct / 100)
```

Peak equity:

```text
peakEquityLamports =
max(
  session.startingBalanceLamports,
  previous EquitySnapshot.totalEquityLamports values,
  current totalEquityLamports
)
```

Current drawdown:

```text
drawdownLamports =
max(0, peakEquityLamports - totalEquityLamports)
```

Drawdown reached:

```text
drawdownLamports >= maxDrawdownLamports
```

When drawdown is reached and session is not already gated:

- [ ] Set `terminationReason = MAX_DRAWDOWN`.
- [ ] Keep `status = RUNNING`.
- [ ] Log drawdown reached.
- [ ] Continue snapshots.
- [ ] Block future paper BUY activity.
- [ ] Do not sell positions.

## BUY Gating Rules

Paper BUY must be updated so target/drawdown gates block future entries.

Add a clear guard to Phase 7 BUY selection/validation:

```text
if session.terminationReason !== NOT_TERMINATED:
  reject explicit session with SESSION_BUY_GATED
  skip implicit sessions when selecting latest eligible paper session
```

Expected behavior:

- [ ] `paper:execute --session-id=<gated-session>` fails clearly.
- [ ] `paper:execute --once` skips gated running sessions.
- [ ] Existing `StrategyDecision(BUY)` rows may remain.
- [ ] Existing `TokenRadar(APPROVED)` rows may remain.
- [ ] No new BUY orders/fills/positions are created for gated sessions.
- [ ] Manual `paper:sell` remains allowed for gated sessions while status is `RUNNING`.

Suggested rejection code:

```text
SESSION_BUY_GATED
```

Suggested message:

```text
Paper BUY is gated for session <id>: terminationReason=<reason>.
```

## Position Valuation Rules

Phase 8 needs mark-to-market values for every OPEN position.

Valuation fallback hierarchy:

1. Fresh exact sell quote through `MarketDataService` when token decimals and amount are available.
2. Refreshed provider price through `MarketDataService`.
3. Cached `TokenRadar.priceSol`.
4. `Position.avgEntryPriceSol`.
5. `Position.costBasisLamports` with no mark price and warning.

The fallback source must be stored in `PositionSnapshot.rawQuoteJson`.

Suggested valuation sources:

```text
SELL_QUOTE
REFRESHED_PRICE
CACHED_RADAR_PRICE
ENTRY_PRICE
COST_BASIS
UNAVAILABLE
```

Seeded fake mints are expected to use entry-price or cost-basis fallback because providers cannot
resolve fake assets.

## Equity Calculation Rules

Per-position market value:

```text
positionMarketValueLamports =
value from valuation fallback hierarchy
```

Per-position unrealized P/L:

```text
unrealizedPnlLamports =
positionMarketValueLamports - position.costBasisLamports - position.feesPaidLamports
```

Session open position value:

```text
openPositionValueLamports =
sum(positionMarketValueLamports)
```

Session unrealized P/L:

```text
unrealizedPnlLamports =
sum(positionUnrealizedPnlLamports)
```

Session total equity:

```text
totalEquityLamports =
session.currentCashLamports + openPositionValueLamports
```

Use integer lamports for all final accounting fields.

## Snapshot Schema Mapping

`EquitySnapshot` fields:

- [ ] `sessionId`
- [ ] `timestampMs`
- [ ] `cashLamports = Session.currentCashLamports`
- [ ] `openPositionValueLamports`
- [ ] `totalEquityLamports`
- [ ] `realizedPnlLamports = Session.realizedPnlLamports`
- [ ] `unrealizedPnlLamports`
- [ ] `drawdownLamports`

`PositionSnapshot` fields:

- [ ] `positionId`
- [ ] `sessionId`
- [ ] `timestampMs`
- [ ] `markPriceSol`
- [ ] `sellQuoteLamports = positionMarketValueLamports`
- [ ] `unrealizedPnlLamports`
- [ ] `unrealizedPnlBps`
- [ ] `liquidityUsd`
- [ ] `rawQuoteJson`

The current `PositionSnapshot` schema does not have dedicated columns for:

- [ ] `mintAddress`
- [ ] `quantity`
- [ ] `marketValue`

No migration is needed. Store or infer them as follows:

```text
mintAddress -> Position.mintAddress
quantity -> Position.tokensHeld
marketValue -> PositionSnapshot.sellQuoteLamports
```

Include compact context in `rawQuoteJson`:

- [ ] mint address
- [ ] token quantity
- [ ] valuation source
- [ ] provider warnings
- [ ] cached price age when applicable
- [ ] fallback reason

## Snapshot Persistence Rules

- [ ] Create one `EquitySnapshot` per non-dry-run cycle.
- [ ] Create one `PositionSnapshot` per OPEN position per non-dry-run cycle.
- [ ] Skip CLOSED positions.
- [ ] Skip snapshot writes in dry-run.
- [ ] Still calculate and print/log dry-run summary.
- [ ] Continue snapshotting gated `RUNNING` sessions.

## Repository Changes

Expected existing repositories:

- [x] `SessionRepository`
- [x] `PositionRepository`
- [x] `SnapshotRepository`
- [x] `TokenRadarRepository`
- [x] `SystemLogRepository`

Add or extend:

- [ ] `SessionRepository.getLatestRunningPaperSession()`
- [ ] `SessionRepository.updateSessionGovernance(...)`
- [ ] `SessionRepository.markTerminationReason(...)`
- [ ] `SnapshotRepository.getPeakEquitySnapshot(sessionId)`

Use existing:

- [ ] `PositionRepository.listOpenPositions(sessionId)`
- [ ] `SnapshotRepository.createEquitySnapshot(...)`
- [ ] `SnapshotRepository.createPositionSnapshot(...)`
- [ ] `TokenRadarRepository.findRadarEntryByMint(sessionId, mintAddress)`
- [ ] `SystemLogRepository.createLog(...)`

## Service Planning

Add:

- [ ] `backend/src/session/SessionManagerConfig.ts`
- [ ] `backend/src/session/SessionCandidateSelector.ts`
- [ ] `backend/src/session/PositionValuationService.ts`
- [ ] `backend/src/session/EquityCalculationService.ts`
- [ ] `backend/src/session/TargetTrackingService.ts`
- [ ] `backend/src/session/DrawdownTrackingService.ts`
- [ ] `backend/src/session/SnapshotService.ts`
- [ ] `backend/src/session/SessionManagerService.ts`
- [ ] `backend/src/session/SessionManagerRunner.ts`
- [ ] `backend/src/scripts/session-manage.ts`

## Runtime Config

`SessionManagerConfig.ts` should parse:

- [ ] `--once`
- [ ] `--dry-run`
- [ ] `--session-id=<id>`
- [ ] `--target-sol=<decimal SOL>`
- [ ] `--target-pct=<percent>`
- [ ] `--max-drawdown-sol=<decimal SOL>`
- [ ] `--max-drawdown-pct=<percent>`

Validation:

- [ ] `--once` is required.
- [ ] SOL values must be positive decimals.
- [ ] Percent values must be positive decimals.
- [ ] Percent values should be capped at a practical upper bound, recommended `1000`.
- [ ] Unknown options fail clearly.
- [ ] Conflicting target sources are allowed, with runtime flags taking precedence over session fields.

## Logging Requirements

Use `SystemLog.scope = SESSION`.

Log:

- [ ] SessionManager started.
- [ ] Session selected.
- [ ] Position valuation warnings.
- [ ] Equity calculated.
- [ ] Position snapshots created.
- [ ] Equity snapshot created.
- [ ] Target progress.
- [ ] Drawdown progress.
- [ ] BUY gate reason set.
- [ ] SessionManager summary.
- [ ] SessionManager failure.

## CLI Summary

Print:

```text
MODE=PAPER
SessionManager once=yes
SessionManager dry-run=<yes|no>
Session=<id>
Open positions=<count>
Position snapshots=<count>
Equity snapshot=<created|skipped>
cash=<lamports>
openPositionValue=<lamports>
equity=<lamports>
realized=<lamports>
unrealized=<lamports>
drawdown=<lamports>
terminationReason=<reason>
buyGated=<yes|no>
wallet loaded=no
transaction signing=disabled
transaction submission=disabled
```

## Failure Handling

Expected failure/rejection codes:

```text
SESSION_NOT_FOUND
SESSION_NOT_PAPER
SESSION_NOT_RUNNING
NO_RUNNING_PAPER_SESSION
INVALID_TARGET_CONFIG
INVALID_DRAWDOWN_CONFIG
POSITION_VALUATION_UNAVAILABLE
SNAPSHOT_WRITE_FAILED
SESSION_UPDATE_FAILED
```

Phase 8 failure behavior:

- [ ] Config failures stop before DB writes.
- [ ] Session selection failures stop before DB writes.
- [ ] Dry-run never writes snapshots or session updates.
- [ ] Individual position valuation failures produce warning context and fallback valuation when possible.
- [ ] Snapshot write failure logs an error and fails the run.
- [ ] Session update failure logs an error and fails the run.
- [ ] Do not mark the session `FAILED` for a single SessionManager runtime error in Phase 8 unless
      the failure corrupts state.

## Dry Run Behavior

Allowed:

- [ ] session selection
- [ ] position loading
- [ ] provider refresh
- [ ] valuation fallback
- [ ] equity calculation
- [ ] target evaluation
- [ ] drawdown evaluation
- [ ] console summary

Forbidden:

- [ ] `EquitySnapshot` writes
- [ ] `PositionSnapshot` writes
- [ ] `Session` updates
- [ ] `Order` writes
- [ ] `Fill` writes
- [ ] `Position` close/open writes
- [ ] `TokenRadar` updates
- [ ] wallet activity
- [ ] signing
- [ ] submission

## Acceptance Tests

Config tests:

- [ ] Parses `--once`.
- [ ] Parses `--dry-run`.
- [ ] Parses `--session-id`.
- [ ] Parses target SOL and percent.
- [ ] Parses drawdown SOL and percent.
- [ ] Rejects missing `--once`.
- [ ] Rejects invalid numeric values.
- [ ] Rejects unknown flags.

Equity calculation tests:

- [ ] Calculates total equity from cash plus open position values.
- [ ] Calculates per-position unrealized P/L.
- [ ] Calculates session unrealized P/L.
- [ ] Uses integer lamports.

Target tests:

- [ ] Uses session target lamports.
- [ ] Converts target percent to lamports.
- [ ] Runtime target overrides session target.
- [ ] Sets target gate when reached.
- [ ] Does not overwrite an existing gate reason.

Drawdown tests:

- [ ] Computes peak equity from starting balance, prior snapshots, and current equity.
- [ ] Computes current drawdown.
- [ ] Converts drawdown percent to lamports.
- [ ] Sets max-drawdown gate when reached.
- [ ] Gives max drawdown priority over target when both trigger in a fresh session.

Snapshot tests:

- [ ] Creates one equity snapshot per non-dry-run cycle.
- [ ] Creates one position snapshot per OPEN position.
- [ ] Skips CLOSED positions.
- [ ] Stores market value in `sellQuoteLamports`.
- [ ] Stores valuation source and warnings in `rawQuoteJson`.
- [ ] Writes no snapshots in dry-run.

BUY gating tests:

- [ ] `paper:execute --session-id=<gated>` rejects with `SESSION_BUY_GATED`.
- [ ] `paper:execute --once` skips gated running sessions.
- [ ] Gated sessions still allow `paper:sell` selection while `status = RUNNING`.
- [ ] No BUY order/fill/position is created for gated sessions.

Safety boundary tests:

- [ ] No SELL orders are created.
- [ ] No SELL fills are created.
- [ ] No positions are closed.
- [ ] No wallets are loaded.
- [ ] No transactions are signed.
- [ ] No transactions are submitted.

Integration tests:

- [ ] SessionManager dry-run calculates without writes.
- [ ] SessionManager creates snapshots and updates `Session.unrealizedPnlLamports`.
- [ ] SessionManager gates target reached.
- [ ] SessionManager gates max drawdown reached.
- [ ] SessionManager continues snapshots after a session is already gated.
- [ ] Seeded fake positions use fallback valuation and still snapshot.

## Documentation Plan

Update:

- [x] `docs/Structure.md`
- [x] `docs/ROADMAP.md`
- [x] `docs/DECISIONS.md`
- [x] `docs/Phase-8-Planning-Inputs.md`
- [x] `docs/architecture/paper-exchange.md`

Create:

- [x] `docs/architecture/session-manager.md`

## Verification Commands

```bash
pnpm session:manage --once --dry-run
pnpm session:manage --once
pnpm paper:execute --once --session-id=<gated-session>
pnpm verify
```

Use non-dry `session:manage` only when it is acceptable to create local snapshots and possibly set
the session BUY gate.

## Phase 8.5 Handoff

Phase 8.5 should decide how automatic exits consume Phase 8 output:

```text
EquitySnapshot
PositionSnapshot
terminationReason
target progress
drawdown progress
-> deterministic exit decision
-> shared PaperSell service-layer call
```

Phase 8.5 owns:

- automatic target-profit liquidation
- automatic max-drawdown liquidation
- stop-loss exits
- trailing-stop exits
- max-hold exits
- liquidity-collapse exits
- session completion after exits

## Definition Of Done

Phase 8 is complete when:

- [x] `pnpm session:manage --once` exists.
- [x] SessionManager is PAPER-only.
- [x] Equity snapshots are created.
- [x] Position snapshots are created.
- [x] Session unrealized P/L is updated.
- [x] Target tracking works.
- [x] Drawdown tracking works.
- [x] BUY gating works through `terminationReason`.
- [x] Gated running sessions continue snapshotting.
- [x] No automatic SELLs occur.
- [x] No DB migration was required.
- [x] Tests pass.
- [x] Documentation is updated.

## Phase Notes

- 2026-06-21: Implemented `pnpm session:manage` with `--once`, `--dry-run`,
  `--session-id`, `--target-sol`, `--target-pct`, `--max-drawdown-sol`, and
  `--max-drawdown-pct`.
- 2026-06-21: Added SessionManager services for session selection, position valuation, equity
  calculation, target tracking, drawdown tracking, snapshot persistence, and summary logging.
- 2026-06-21: Added no-migration snapshot mapping using existing `EquitySnapshot` and
  `PositionSnapshot` fields.
- 2026-06-21: Added Phase 8 BUY gating to PaperExchange through
  `Session.terminationReason != NOT_TERMINATED`.
- 2026-06-21: Added tests for config parsing, snapshot creation, dry-run behavior, target gating,
  drawdown gating, existing gate preservation, fallback valuation, and paper BUY gate behavior.
