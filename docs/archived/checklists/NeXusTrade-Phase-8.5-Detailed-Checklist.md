# NeXusTrade Phase 8.5 Detailed Checklist

Automated Session-Level Paper Exits

Last updated: June 2026

Status: Complete.

Mode: `PAPER` only.

## Executive Summary

Phase 8.5 introduces an ExitManager that reacts to Phase 8 session governance signals and can
automatically close all open paper positions when explicitly configured.

Phase 8.5 consumes:

- `Session.terminationReason`
- `EquitySnapshot` context
- `PositionSnapshot` context
- `SessionManager` governance output
- `OPEN` positions

Phase 8.5 may create or update:

- `Order(SELL)`
- `Fill(SELL)`
- `Position(CLOSED)`
- `Session.currentCashLamports`
- `Session.realizedPnlLamports`
- `Session.status = COMPLETED`, only when explicitly configured
- `SystemLog`
- `TokenRadar.status = WATCHING` through the existing PaperSell service

Phase 8.5 does not introduce:

- stop-loss exits
- trailing-stop exits
- max-hold exits
- liquidity-collapse exits
- partial exits
- strategy-driven exits
- live wallet loading
- transaction signing
- transaction submission

## Implementation Review

Phase 8.5 is implementable with the current codebase.

No physical database migration is required for the first pass. The current `Order`, `Fill`,
`Position`, `Session`, `TokenRadar`, and `SystemLog` tables can represent automated paper exits.

The existing `PaperSellExecutionService` already supports:

- sell-all selection
- mint-scoped selection
- quote/price refresh
- cached price fallback when explicitly enabled
- SELL order creation
- SELL fill creation
- position close
- cash update
- realized P/L update
- TokenRadar `BOUGHT -> WATCHING`
- dry-run

The main implementation work is an orchestration layer around PaperSell, not a rewrite of SELL
accounting.

## Locked Clarifications

- [ ] Phase 8.5 is `PAPER` only.
- [ ] Add a standalone command: `pnpm exits:manage --once`.
- [ ] Reuse the existing PaperSell service layer directly.
- [ ] Do not shell out to `pnpm paper:sell`.
- [ ] `TARGET_REACHED` supports optional `sell-all`.
- [ ] `MAX_DRAWDOWN` supports optional `sell-all`.
- [ ] Observe-only is the default action.
- [ ] No automatic sell happens without explicit action configuration.
- [ ] Session completion is optional and disabled by default.
- [ ] No physical DB migration is required.
- [ ] No position-level exit logic is added.
- [ ] No stop-loss logic is added.
- [ ] No trailing-stop logic is added.
- [ ] No max-hold logic is added.
- [ ] No liquidity-collapse logic is added.

## Runtime Commands

Supported:

```bash
pnpm exits:manage --once --dry-run
pnpm exits:manage --once
pnpm exits:manage --once --session-id=session_123
pnpm exits:manage --once --target-action=sell-all
pnpm exits:manage --once --drawdown-action=sell-all
pnpm exits:manage --once --target-action=sell-all --complete-session-on-exit=true
pnpm exits:manage --once --drawdown-action=sell-all --complete-session-on-exit=true
```

Rejected:

```bash
pnpm exits:manage
pnpm exits:manage --target-action=partial
pnpm exits:manage --drawdown-action=partial
pnpm exits:manage --complete-session-on-exit=true
```

`--complete-session-on-exit=true` should be rejected unless at least one exit action is explicitly
configured as `sell-all`.

## Runtime Defaults

```text
mode=PAPER
once=required
dryRun=false
targetAction=observe
drawdownAction=observe
completeSessionOnExit=false
allowCachedRadarPrice=false
limit=250
baseFeeLamports=5000
priorityFeeLamports=0
slippageBps=100
```

Use PaperSell defaults for fee, slippage, quote, and fallback behavior unless ExitManager needs a
higher sell-all `limit`.

## Session Selection

When `--session-id` is supplied:

- [ ] Session must exist.
- [ ] Session must be `PAPER`.
- [ ] Session must be `RUNNING`.
- [ ] Session must have `terminationReason != NOT_TERMINATED`.
- [ ] `COMPLETED`, `FAILED`, `CANCELLED`, `PAUSED`, and `CREATED` sessions are rejected.

When `--session-id` is omitted:

- [ ] Select the latest `PAPER` + `RUNNING` session with `terminationReason != NOT_TERMINATED`.
- [ ] Prefer sessions with `OPEN` positions.
- [ ] If no gated running paper session exists, fail clearly.
- [ ] Do not auto-create sessions.
- [ ] Do not evaluate historical completed sessions.

## Trigger Evaluation

Source of truth:

```text
Session.terminationReason
```

Supported triggers:

```text
TARGET_REACHED
MAX_DRAWDOWN
```

Ignored reasons:

```text
NOT_TERMINATED
DURATION_EXPIRED
USER_STOP
ENGINE_ERROR
```

Phase 8.5 should not invent new trigger reasons in the first pass.

## Action Matrix

```text
TARGET_REACHED + observe
-> log and summarize only

TARGET_REACHED + sell-all
-> sell all open positions

MAX_DRAWDOWN + observe
-> log and summarize only

MAX_DRAWDOWN + sell-all
-> sell all open positions
```

If the configured action does not match the trigger, observe only.

Examples:

```text
terminationReason=TARGET_REACHED
targetAction=sell-all
drawdownAction=observe
-> sell-all

terminationReason=MAX_DRAWDOWN
targetAction=sell-all
drawdownAction=observe
-> observe
```

## Sell-All Selection

Use the existing PaperSell candidate selector with:

```text
trigger = SELL_ALL
sessionId = selected session id
```

Expected behavior:

- [ ] Select all `OPEN` positions up to the configured limit.
- [ ] Exclude `CLOSED` positions.
- [ ] Exclude non-running sessions.
- [ ] Reuse existing PaperSell validation.
- [ ] Reuse existing quote and fallback behavior.
- [ ] Reuse existing accounting.
- [ ] Reuse existing TokenRadar update behavior.

Recommended ExitManager `limit` default:

```text
250
```

This avoids accidentally leaving positions open when a session has more than the PaperSell CLI's
interactive default of 10 positions.

## PaperSell Integration

Reuse:

- [ ] `PaperSellCandidateSelector`
- [ ] `PaperSellQuoteService`
- [ ] `PaperSellValidationService`
- [ ] `PaperSellAccountingService`
- [ ] `PaperSellExecutionService`
- [ ] `PaperSellOrderFactory`
- [ ] `PaperSellFillFactory`

Do not duplicate:

- [ ] price refresh logic
- [ ] cached fallback logic
- [ ] SELL order creation
- [ ] SELL fill creation
- [ ] position close logic
- [ ] realized P/L calculation
- [ ] cash update logic

## Exit Audit Mapping

No new table is required.

Store exit audit context in `SystemLog.contextJson` and existing SELL order/fill JSON fields.

Suggested `SystemLog` context:

```json
{
  "phase": "PHASE_8_5_EXIT_MANAGER",
  "trigger": "TARGET_REACHED",
  "action": "sell-all",
  "sessionId": "session_123",
  "completeSessionOnExit": false,
  "dryRun": false
}
```

Suggested PaperSell extension:

```text
PaperSellRuntimeConfig.exitContext?: {
  source: "EXIT_MANAGER";
  trigger: "TARGET_REACHED" | "MAX_DRAWDOWN";
  action: "sell-all";
}
```

This keeps the PaperSell order/fill context self-explanatory without changing database columns.

## SystemLog Scope Decision

Preferred first pass:

```text
SystemLog.scope = EXECUTION
```

with `contextJson.phase = PHASE_8_5_EXIT_MANAGER`.

Optional enhancement:

```text
SystemLog.scope = EXIT
```

Adding `EXIT` to the TypeScript enum should not require a physical SQLite migration because the
column is plain `text`, but it is not necessary for Phase 8.5.

## Session Completion Rules

Session completion is controlled by:

```text
--complete-session-on-exit=true
```

Default:

```text
completeSessionOnExit=false
```

Completion is allowed only when:

- [ ] Session is `PAPER`.
- [ ] Session is `RUNNING`.
- [ ] `terminationReason` is `TARGET_REACHED` or `MAX_DRAWDOWN`.
- [ ] Matching action is configured as `sell-all`.
- [ ] All open positions are closed after the sell-all attempt.
- [ ] `PaperSellExecutionSummary.failedCount = 0`.

Completion behavior:

```text
RUNNING + TARGET_REACHED -> COMPLETED + TARGET_REACHED
RUNNING + MAX_DRAWDOWN -> COMPLETED + MAX_DRAWDOWN
```

Do not complete the session after observe-only runs.

If no open positions remain at runtime, completion may still run when the session is gated and
`--complete-session-on-exit=true` is supplied with the matching sell-all action. This supports
completion after positions were closed manually in a prior run.

## Dry Run Behavior

Allowed:

- [ ] config parsing
- [ ] session selection
- [ ] trigger evaluation
- [ ] action planning
- [ ] open-position counting
- [ ] PaperSell dry-run quote/evaluation
- [ ] console summary

Forbidden:

- [ ] DB `SystemLog` writes
- [ ] order writes
- [ ] fill writes
- [ ] position updates
- [ ] session updates
- [ ] TokenRadar updates
- [ ] wallet loading
- [ ] transaction signing
- [ ] transaction submission

Dry-run should print what would happen. It should not persist audit logs, because persisted logs are
database writes.

## Failure Handling

Expected failure codes or messages:

```text
SESSION_NOT_FOUND
SESSION_NOT_PAPER
SESSION_NOT_RUNNING
SESSION_NOT_GATED
UNSUPPORTED_TERMINATION_REASON
NO_GATED_RUNNING_PAPER_SESSION
NO_MATCHING_EXIT_ACTION
SELL_ALL_FAILED
SESSION_COMPLETION_BLOCKED
SESSION_COMPLETION_FAILED
```

Rules:

- [ ] Config failures stop before DB writes.
- [ ] Session selection failures stop before DB writes.
- [ ] Observe-only runs do not sell or complete sessions.
- [ ] Sell failures do not complete sessions.
- [ ] Partial sells remain recoverable by rerunning.
- [ ] Closed positions are skipped by existing PaperSell selection.
- [ ] Session completion happens after successful sell-all, never before.

## Idempotency Rules

- [ ] Completed sessions are ignored or rejected.
- [ ] Closed positions are ignored.
- [ ] Re-running sell-all after partial success only attempts remaining open positions.
- [ ] Re-running sell-all after full success creates no duplicate fills.
- [ ] Re-running completion on an already completed session is rejected.
- [ ] Observe-only runs never create duplicate writes.

## Transaction Boundary

The current PaperSell implementation uses ordered writes rather than a repository-level transaction
wrapper.

Phase 8.5 should preserve recoverability by:

- [ ] writing SELL records through PaperSell only
- [ ] completing the session only after PaperSell returns a successful summary
- [ ] refusing completion when open positions remain
- [ ] logging failures with enough context to rerun

A later hardening phase can introduce explicit multi-record transaction wrappers if concurrent
execution or stronger rollback semantics become necessary.

## Service Planning

Add:

- [ ] `backend/src/exits/ExitManagerConfig.ts`
- [ ] `backend/src/exits/ExitCandidateSelector.ts`
- [ ] `backend/src/exits/ExitTriggerService.ts`
- [ ] `backend/src/exits/ExitActionService.ts`
- [ ] `backend/src/exits/ExitCompletionService.ts`
- [ ] `backend/src/exits/ExitManagerService.ts`
- [ ] `backend/src/exits/ExitManagerRunner.ts`
- [ ] `backend/src/exits/ExitManagerConfig.test.ts`
- [ ] `backend/src/exits/ExitManagerRunner.test.ts`
- [ ] `backend/src/scripts/exits-manage.ts`

Suggested responsibilities:

```text
ExitManagerConfig
-> CLI parsing, defaults, validation

ExitCandidateSelector
-> session selection and eligibility

ExitTriggerService
-> maps terminationReason to supported trigger

ExitActionService
-> maps trigger + config to observe or sell-all

ExitCompletionService
-> optional session completion after successful sell-all

ExitManagerService
-> orchestration, logs, summary

ExitManagerRunner
-> production/test facade
```

## Repository Planning

Use existing:

- [ ] `SessionRepository.getSessionById(...)`
- [ ] `SessionRepository.getActivePaperSessions()`
- [ ] `SessionRepository.completeSession(...)`
- [ ] `PositionRepository.listOpenPositions(...)`
- [ ] `OrderRepository`
- [ ] `FillRepository`
- [ ] `TokenRadarRepository`
- [ ] `SystemLogRepository.createLog(...)`

Potential addition:

- [ ] `SessionRepository.getLatestGatedRunningPaperSession()`

This can also be implemented in the ExitManager selector using `getActivePaperSessions()` for the
first pass.

## Package Scripts

Add backend script:

```json
"exits:manage": "tsx src/scripts/exits-manage.ts"
```

Add root script:

```json
"exits:manage": "pnpm --filter @nexustrade/backend exits:manage"
```

## CLI Summary

Print:

```text
MODE=PAPER
ExitManager once=yes
ExitManager dry-run=<yes|no>
Session=<id>
terminationReason=<reason>
trigger=<TARGET_REACHED|MAX_DRAWDOWN|none>
action=<observe|sell-all>
positionsOpenBefore=<count>
positionsSelected=<count>
positionsClosed=<count>
sellFailures=<count>
sessionCompleted=<yes|no>
wallet loaded=no
transaction signing=disabled
transaction submission=disabled
```

## Logging Requirements

Use:

```text
SystemLog.scope = EXECUTION
contextJson.phase = PHASE_8_5_EXIT_MANAGER
```

Log:

- [ ] ExitManager started.
- [ ] Session selected.
- [ ] Trigger detected.
- [ ] Action selected.
- [ ] Observe-only no-op.
- [ ] Sell-all started.
- [ ] Sell-all completed.
- [ ] Session completion skipped.
- [ ] Session completed.
- [ ] ExitManager summary.
- [ ] Failures.

Skip DB logs in dry-run.

## Acceptance Tests

Config tests:

- [ ] Parses `--once`.
- [ ] Parses `--dry-run`.
- [ ] Parses `--session-id`.
- [ ] Parses `--target-action=sell-all`.
- [ ] Parses `--drawdown-action=sell-all`.
- [ ] Parses `--complete-session-on-exit=true`.
- [ ] Rejects missing `--once`.
- [ ] Rejects unsupported actions.
- [ ] Rejects session completion without a sell-all action.
- [ ] Rejects unknown flags.

Trigger tests:

- [ ] `TARGET_REACHED` maps to target trigger.
- [ ] `MAX_DRAWDOWN` maps to drawdown trigger.
- [ ] `NOT_TERMINATED` produces no supported trigger.
- [ ] Unsupported termination reasons are observed or rejected clearly.

Action tests:

- [ ] Target trigger with target observe logs only.
- [ ] Drawdown trigger with drawdown observe logs only.
- [ ] Target trigger with target sell-all calls PaperSell.
- [ ] Drawdown trigger with drawdown sell-all calls PaperSell.
- [ ] Target trigger does not use drawdown action.
- [ ] Drawdown trigger does not use target action.

Integration tests:

- [ ] `TARGET_REACHED + sell-all` closes all open positions.
- [ ] `MAX_DRAWDOWN + sell-all` closes all open positions.
- [ ] Observe mode creates no orders, fills, position updates, session updates, or TokenRadar updates.
- [ ] Dry-run creates no orders, fills, position updates, session updates, TokenRadar updates, or DB logs.
- [ ] Session completion occurs only when enabled and all positions are closed.
- [ ] Session completion is blocked when sell failures occur.
- [ ] Already completed sessions are rejected.
- [ ] Re-running after all positions are closed does not create duplicate fills.

Safety boundary tests:

- [ ] No stop-loss exits.
- [ ] No trailing-stop exits.
- [ ] No max-hold exits.
- [ ] No liquidity-collapse exits.
- [ ] No partial sells.
- [ ] No live wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.

## Verification Commands

Use dry-run first:

```bash
pnpm exits:manage --once --dry-run
pnpm verify
```

Use non-dry commands only when it is acceptable to mutate the local paper database:

```bash
pnpm exits:manage --once --target-action=sell-all
pnpm exits:manage --once --drawdown-action=sell-all
pnpm exits:manage --once --target-action=sell-all --complete-session-on-exit=true
```

## Known Limitations

- Phase 8.5 only reacts to session-level `terminationReason`.
- Phase 8.5 does not evaluate per-position stop losses.
- Phase 8.5 does not evaluate trailing stops.
- Phase 8.5 does not evaluate max hold time.
- Phase 8.5 does not evaluate liquidity collapse.
- Phase 8.5 sells all selected open positions for a supported session trigger.
- PaperSell currently uses ordered writes, so partial failure recovery relies on idempotent reruns.
- Some exit audit context remains in JSON instead of dedicated columns.
- Provider quote availability still depends on real token mints and provider responses.
- Seeded fake mints may need cached, entry-price, or cost-basis paths and are not suitable for clean
  market-data validation.

## Documentation Plan

Update:

- [x] `docs/ROADMAP.md`
- [x] `docs/DECISIONS.md`
- [x] `docs/Structure.md`
- [x] `docs/architecture/session-manager.md`
- [x] `docs/architecture/paper-sell-engine.md`

Create:

- [x] `docs/architecture/exit-manager.md`
- [x] Separate `docs/Phase-8.5-Planning-Inputs.md` not needed because the implementation
      checklist contains the handoff and completion notes.

## Phase 9 Handoff

Phase 9 or Phase 8.6 may add:

- stop-loss exits
- trailing-stop exits
- max-hold exits
- liquidity-collapse exits
- partial exits
- strategy-driven exits
- transaction wrapper hardening
- richer reporting columns

Phase 8.5 remains strictly session-level automated paper exits.

## Definition Of Done

Phase 8.5 is complete when:

- [x] `pnpm exits:manage --once` exists.
- [x] ExitManager is paper-only.
- [x] Trigger evaluation uses `Session.terminationReason`.
- [x] Observe-only is the default.
- [x] Sell-all requires explicit action configuration.
- [x] PaperSell service-layer code is reused directly.
- [x] Target sell-all works.
- [x] Drawdown sell-all works.
- [x] Optional session completion works.
- [x] Dry-run works without DB writes.
- [x] Tests pass.
- [x] Documentation is updated.

## Phase Notes

- 2026-06-22: Implemented `pnpm exits:manage` with `--once`, `--dry-run`,
  `--session-id`, `--target-action=sell-all`, `--drawdown-action=sell-all`, and
  `--complete-session-on-exit=true`.
- 2026-06-22: Added ExitManager services for session selection, trigger evaluation, action
  resolution, PaperSell orchestration, optional completion, and summary logging.
- 2026-06-22: Reused the PaperSell service layer directly and added optional `exitContext` to SELL
  order/fill JSON.
- 2026-06-22: Added true ExitManager dry-run behavior by suppressing PaperSell system logs during
  ExitManager dry-runs.
- 2026-06-22: Added tests for observe-only default, target sell-all, drawdown sell-all, dry-run
  no-write behavior, optional completion, completion blocking on SELL rejection, no-open-position
  completion, implicit session selection, and explicit session rejection.
