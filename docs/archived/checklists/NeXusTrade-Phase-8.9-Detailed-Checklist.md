# NeXusTrade Phase 8.9 Detailed Checklist

Shadow Entry/Exit Simulation + High-Frequency Buy Candidate Monitoring

Last updated: July 2026

Status: Complete.

Mode: `PAPER` research and simulation only.

## Executive Summary

Phase 8.9 turns Phase 8.8 calibration evidence into explicit entry/exit research.

Phase 8.8 showed that some BUY candidates reach useful profit quickly, then fade. It also showed
that some score-50 and score-55 candidates can move sharply before the current strategy would buy
them. The next question is not just:

```text
Which token should we buy?
```

The next question is:

```text
If we entered here, could we exit quickly enough to capture repeatable gains before reversal?
```

Phase 8.9 should simulate fast paper exits from observed market data without wallet activity,
signing, transaction submission, or real live swaps.

## Why This Phase Exists

Recent Phase 8.8 fresh runs showed examples like:

- `ANSOME`: BUY candidate, +22% at 3m, +42% at 15m, +135% at 120m.
- `vibeshift`: BUY candidate, +21% at 3m, then negative by 15m to 120m.
- `GIGABULL`: BUY candidate, +10% at 5m, then sharply negative later.
- `FABLE`: SKIP at score 50/55, but very large positive movement.
- `PORTNOY`: SKIP at score 55, reached +47% at 60m but had a deep earlier drawdown.

These are entry-and-exit problems. A candidate can be a good trade only if the system can:

- enter soon enough,
- monitor frequently enough,
- take profit before the move reverses,
- cut losers before they damage the session goal,
- and stop once the session target is reached.

## Phase Objective

Build a paper-only shadow exit simulator and high-frequency observation runner that can answer:

- Which BUY candidates would have hit +10%, +15%, or +25%?
- Which candidates would have hit stop-loss first?
- Which candidates need 1-minute monitoring versus 3-minute monitoring?
- Which score buckets produce fast, repeatable wins?
- Whether score 50/55 near misses should become WATCH, shadow BUY, or future BUY candidates.
- Whether a run-level goal like `1 SOL -> 1.25 SOL` is plausible from simulated exits.

Phase 8.9 should not change production scoring defaults yet. It should produce evidence.

## Locked Safety Boundary

- [ ] `PAPER` mode only.
- [ ] No wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.
- [ ] No live swap execution.
- [ ] No real order submission.
- [ ] No live-mode DB access.
- [ ] No production score default changes in first pass.
- [ ] No automatic real paper BUY execution required in first pass.
- [ ] No automatic real paper SELL execution required in first pass.
- [ ] Shadow simulation may read strategy decisions and watchlist observations.
- [ ] Shadow simulation may write additional watchlist observations if explicitly running the
      high-frequency observer.
- [ ] Shadow simulation must clearly label simulated results as simulated, not fills or realized
      P/L.

## Recommended Architecture

Use two related pieces:

```text
HighFrequencyObservationRunner
  -> schedules/fetches frequent price observations for selected decisions

ShadowExitSimulationRunner
  -> consumes observations and simulates target/stop/max-hold exits
```

Keep them separate so we can run:

```text
collect more data
analyze exits
```

without forcing execution behavior.

## First-Pass Command Surface

Add root scripts:

```bash
pnpm shadow:observe
pnpm shadow:exits
```

Add backend scripts:

```bash
pnpm --filter @nexustrade/backend shadow:observe
pnpm --filter @nexustrade/backend shadow:exits
```

Entrypoints:

```text
backend/src/scripts/shadow-observe.ts
backend/src/scripts/shadow-exits.ts
```

Recommended usage:

```bash
pnpm shadow:observe --once
pnpm shadow:observe --once --interval-minutes=1 --max-hold-minutes=60
pnpm shadow:exits --once
pnpm shadow:exits --once --target-pcts=10,15,25 --stop-pcts=10,15,25 --max-hold-minutes=60
```

No long-running monitor is required in the first implementation. `--once` is enough because the
user can run it on a timer or Phase 9 can orchestrate it later.

## Runtime Defaults

Use these defaults first:

```text
sourceDecisions = BUY
includeShadowScores = false
shadowScoreMin = 55
intervalMinutes = 1
maxHoldMinutes = 60
horizonsMinutes = 1,2,3,4,5,6,7,8,9,10,12,15,20,25,30,45,60
targetPcts = 10,15,25
stopPcts = 10,15,25
startingBalanceSol = 1
positionSizeSol = 0.01
sessionGoalPct = 25
maxPositions = 5
priceSource = DexScreener token-pairs
fallbackPriceSource = existing TokenRadar priceSol
```

Why 1-minute intervals:

Recent tests showed many useful moves appear inside 3 to 5 minutes. One-minute monitoring gives the
simulator enough resolution to evaluate fast exits without pretending to have tick-level precision.

## Data Model Recommendation

First pass: no DB migration.

Reuse:

```text
watchlist_return_observations
```

Rationale:

- It already stores strategy decision ID.
- It already stores horizon minutes.
- It already stores baseline and observed prices.
- It already has a unique constraint per decision and horizon.
- It can support 1-minute, 2-minute, and other custom horizons.

Important convention:

```text
horizon_minutes = minutes after strategy decision / shadow entry baseline
```

If this becomes too noisy later, add a dedicated table in a later phase:

```text
shadow_trade_observations
shadow_exit_simulations
```

But avoid migration noise for the first Phase 8.9 pass.

## Backend Module Structure

Add:

```text
backend/src/shadow/
  ShadowConfig.ts
  ShadowCandidateSelector.ts
  ShadowObservationScheduler.ts
  ShadowObservationRunner.ts
  ShadowExitSimulator.ts
  ShadowPortfolioSimulator.ts
  ShadowReportFormatter.ts
  ShadowTypes.ts
  *.test.ts
```

Optional, only if useful:

```text
backend/src/shadow/ShadowRepository.ts
```

Prefer using existing repositories when cleanly possible.

## Chunk 1: Config And Scripts

Implement:

- [ ] `backend/src/shadow/ShadowConfig.ts`
- [ ] `backend/src/scripts/shadow-observe.ts`
- [ ] `backend/src/scripts/shadow-exits.ts`
- [ ] backend package scripts
- [ ] root package scripts

Config options:

- [ ] `--once`
- [ ] `--session-id=<id>`
- [ ] `--source-decisions=BUY,WATCH,SKIP`
- [ ] `--include-shadow-scores`
- [ ] `--shadow-score-min=<score>`
- [ ] `--interval-minutes=<n>`
- [ ] `--horizons-minutes=1,2,3,5,10,15,30,60`
- [ ] `--max-hold-minutes=<n>`
- [ ] `--target-pcts=10,15,25`
- [ ] `--stop-pcts=10,15,25`
- [ ] `--starting-balance-sol=1`
- [ ] `--position-size-sol=0.01`
- [ ] `--session-goal-pct=25`
- [ ] `--json`
- [ ] `--dry-run`

Validation:

- [ ] percent values must be positive finite numbers.
- [ ] interval and horizon values must be positive integers.
- [ ] max hold must be positive.
- [ ] source decisions must be known strategy decisions.
- [ ] shadow score minimum must be 0 to 100.
- [ ] session ID must not be empty when provided.
- [ ] starting balance must be positive.
- [ ] position size must be positive and not exceed starting balance.

Acceptance:

- [ ] Invalid arguments fail with clear messages.
- [ ] Default config is paper-safe.
- [ ] CLI output states wallet/signing/submission are disabled.

## Chunk 2: Candidate Selection

Selector should support two modes.

Mode A, default:

```text
StrategyDecision(BUY)
```

Mode B, research:

```text
StrategyDecision(BUY)
+ StrategyDecision(SKIP/WATCH) with score >= shadowScoreMin
```

Inputs:

- [ ] latest PAPER/RUNNING session with strategy decisions if `--session-id` is omitted.
- [ ] explicit `--session-id` must be `PAPER + RUNNING`.
- [ ] strategy decisions within the current session.
- [ ] matching TokenRadar row.
- [ ] existing watchlist observations.

Rules:

- [ ] Default only monitors BUY decisions.
- [ ] `--include-shadow-scores` includes WATCH/SKIP candidates at or above `shadowScoreMin`.
- [ ] Do not include decisions without a baseline price.
- [ ] Do not include decisions with duplicate strategy decision IDs.
- [ ] Preserve duplicate decisions for same mint only when they have different strategy decision IDs;
      this matters for changing baseline times.

Acceptance:

- [ ] BUY-only mode selects only BUY rows.
- [ ] Shadow mode includes score-55 FABLE-like SKIP candidates.
- [ ] Missing baseline price produces a clear skipped-candidate reason.

## Chunk 3: High-Frequency Observation Scheduling

Use existing `watchlist_return_observations` scheduling logic where possible.

The observer should:

- [ ] Select candidates.
- [ ] Calculate desired horizons.
- [ ] Schedule missing horizons.
- [ ] Observe due horizons.
- [ ] Avoid duplicating existing horizon rows.
- [ ] Use provider-backed token price refresh.
- [ ] Preserve existing 3/5/15/30/60/120 horizons.

Default horizons:

```text
1,2,3,4,5,6,7,8,9,10,12,15,20,25,30,45,60
```

Optional horizons for extended research:

```text
90,120,180,240
```

Output summary:

```text
selectedStrategyDecisions
scheduled
alreadyScheduled
due
observed
missed
failed
```

Acceptance:

- [ ] Running twice does not duplicate rows.
- [ ] A due 1-minute horizon is observed.
- [ ] A future horizon remains pending.
- [ ] Provider failures mark only affected observations failed/missed, not the whole run.

## Chunk 4: Exit Simulation

The simulator consumes observed returns and evaluates:

```text
entry at baseline
target exits
stop exits
max hold exits
```

Default target scenarios:

```text
target = 10%, 15%, 25%
```

Default stop scenarios:

```text
stop = 10%, 15%, 25%
```

Default max holds:

```text
15m, 30m, 60m, 120m
```

For each candidate, report:

- [ ] first target hit horizon.
- [ ] first stop hit horizon.
- [ ] whether target happened before stop.
- [ ] whether stop happened before target.
- [ ] whether neither happened before max hold.
- [ ] best observed return.
- [ ] worst observed return.
- [ ] exit reason.
- [ ] simulated exit return.

Exit reasons:

```text
TARGET_HIT
STOP_HIT
MAX_HOLD
NO_OBSERVATION
AMBIGUOUS
```

Ambiguity rule:

If target and stop are both already crossed by the same first observed horizon and there is no
earlier observation to establish order, mark `AMBIGUOUS`.

Acceptance:

- [ ] vibeshift-like row exits profitably at +10% using 3m data.
- [ ] GIGABULL-like row exits profitably at +10% using 5m data but fails if no fast target is used.
- [ ] b40-like row stops out quickly.
- [ ] PORTNOY-like row is not treated as clean because it draws down before later profit.

## Chunk 5: Shadow Portfolio Simulation

Add a simple run-level simulator.

Inputs:

```text
startingBalanceSol
positionSizeSol
sessionGoalPct
maxPositions
simulated exit results
```

Rules:

- [ ] Start with `startingBalanceSol`.
- [ ] Allocate `positionSizeSol` per candidate.
- [ ] Do not exceed `maxPositions`.
- [ ] Apply simulated exit return to each position.
- [ ] Track cumulative P/L.
- [ ] Stop opening new simulated positions once session goal is reached.
- [ ] Report whether the run reached `startingBalanceSol * (1 + sessionGoalPct / 100)`.

Default example:

```text
startingBalanceSol = 1
positionSizeSol = 0.01
sessionGoalPct = 25
target end balance = 1.25 SOL
```

Output:

```text
simulatedStartingSol
simulatedEndingSol
simulatedPnlSol
simulatedPnlPct
goalReached
winningTrades
losingTrades
averageWinnerPct
averageLoserPct
maxDrawdownPct
```

Acceptance:

- [ ] A +10% exit on `0.01 SOL` adds `0.001 SOL` before simulated fees.
- [ ] A -10% stop on `0.01 SOL` subtracts `0.001 SOL` before simulated fees.
- [ ] Goal stops additional simulated entries.
- [ ] Output clearly says this is simulated, not realized P/L.

## Chunk 6: Report Output

Human-readable output sections:

```text
NeXusTrade Shadow Exit Report
Session Summary
Candidate Selection
Observation Coverage
Exit Scenario Summary
Per-Candidate Exit Outcomes
Shadow Portfolio Result
Missed Fast Winners
False Fast Entries
Provider Impact
Recommendations
```

Per-candidate output:

```text
Symbol
Decision
Score
Entry baseline
Returns by horizon
Best observed return
Worst observed return
Target/stop outcome
Simulated exit
```

JSON output:

```ts
interface ShadowExitReportJson {
  generatedAtMs: number;
  sessionId: string;
  config: ShadowRuntimeConfig;
  candidates: ShadowCandidateResult[];
  scenarios: ShadowExitScenarioSummary[];
  portfolio: ShadowPortfolioSummary;
  recommendations: string[];
}
```

Acceptance:

- [ ] Text output is easy to read in the terminal.
- [ ] JSON output is stable enough for a future dashboard.
- [ ] Report distinguishes observed returns from executable quote fills.

## Chunk 7: Integration With Existing Commands

Phase 8.9 should not replace these commands:

```bash
pnpm watchlist:returns
pnpm analytics:report
pnpm calibration:report
```

Instead:

- [ ] `shadow:observe` extends high-frequency observation coverage.
- [ ] `shadow:exits` reports simulated exits.
- [ ] Phase 8.8 calibration remains useful for score/threshold analysis.
- [ ] Phase 9 can later orchestrate scanner/risk/strategy/shadow observe/shadow exits.

Recommended fresh-run sequence after Phase 8.9:

```powershell
corepack pnpm scanner:discover --interval-ms=60000 --limit=25 --concurrency=3
corepack pnpm risk:evaluate --once
corepack pnpm strategy:evaluate --once --buy-score-threshold=65 --watch-score-threshold=60
corepack pnpm shadow:observe --once --include-shadow-scores --shadow-score-min=50
corepack pnpm shadow:exits --once --target-pcts=10,15,25 --stop-pcts=10,15,25
```

Then repeat `shadow:observe` every 1 to 3 minutes during the monitoring window.

## Chunk 8: Tests

Add tests under:

```text
backend/src/shadow/*.test.ts
```

Config tests:

- [ ] parses defaults.
- [ ] parses target/stop lists.
- [ ] rejects invalid percentages.
- [ ] rejects invalid source decisions.
- [ ] rejects invalid balances.

Candidate selector tests:

- [ ] BUY-only mode.
- [ ] shadow score mode.
- [ ] missing baseline price handling.
- [ ] explicit session validation.

Observation scheduler tests:

- [ ] schedules missing 1-minute horizons.
- [ ] does not duplicate existing horizons.
- [ ] marks due horizons correctly.

Exit simulator tests:

- [ ] target hit before stop.
- [ ] stop hit before target.
- [ ] max hold exit.
- [ ] no observation exit.
- [ ] ambiguous target/stop ordering.

Portfolio simulator tests:

- [ ] applies winners.
- [ ] applies losers.
- [ ] respects max positions.
- [ ] stops at session goal.

Safety tests:

- [ ] no orders created.
- [ ] no fills created.
- [ ] no positions opened.
- [ ] no wallet/signing/submission path exists.

## Chunk 9: Documentation Updates

Update:

- [ ] `docs/ROADMAP.md`
- [ ] `docs/Phase-9-Planning-Inputs.md`
- [ ] `docs/Structure.md` if new files are added.

Add phase notes:

- [ ] Explain that Phase 8.9 is simulated.
- [ ] Explain why 1-minute monitoring exists.
- [ ] Explain that 8.9 does not prove executable profitability.
- [ ] Document known provider limitations.
- [ ] Document how 8.9 should feed Phase 9 TerminalRunner.

## Known Limitations

- Observed prices are still endpoint observations, not tick-level data.
- DexScreener prices may not match executable Jupiter quotes.
- Jupiter rate limiting remains a bottleneck for executable quote confidence.
- One-minute checks are better than 3-minute checks but still can miss fast spikes.
- Shadow results do not include true slippage, partial fills, failed routes, or MEV effects.
- The first pass does not manage real paper positions.
- The first pass does not automatically sell paper positions.

## Recommended Implementation Order

Small implementation chunks:

```text
1. config/scripts
2. candidate selector
3. high-frequency horizon scheduler
4. due observation runner
5. exit simulation engine
6. portfolio simulation engine
7. text/json report formatter
8. unit tests
9. docs/roadmap/Phase 9 handoff updates
10. manual validation on existing Phase 8.8 sessions
```

## Manual Validation Plan

Use existing sessions:

```text
session_37c9551c-ab06-4091-9bb4-714ee2a0fab0
session_586c0a87-ab33-4a16-a1b5-b2f357dcf5a4
session_740d7856-fe85-43ba-b81e-1f4ce0039db7
```

Validation expectations:

- [ ] ANSOME should show a profitable +10%, +15%, and +25% target path.
- [ ] vibeshift should show fast +10% target but poor later hold behavior.
- [ ] GIGABULL should show fast +10% target but poor later hold behavior.
- [ ] b40 should show quick stop-loss behavior.
- [ ] FABLE should appear as a shadow missed opportunity at score 50/55.
- [ ] PORTNOY should show that late profit after earlier drawdown is not clean.

## Phase 9 Handoff

Phase 9 should not simply automate scanner/risk/strategy/paper execution.

Post-Phase 8.91 follow-up:

```text
Phase 8.9 shadow mechanics worked.
Phase 8.91 showed raw BUY decisions are not safe enough for automated paper execution.
Phase 8.92 should add calibrated shadow entry gates before Phase 9 enables paper BUY in a loop.
```

Phase 9 should orchestrate:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow exits
-> optional paper BUY only after exit evidence is acceptable
```

Phase 9 readiness should be:

```text
GREEN:
  Shadow exits show repeatable target-before-stop performance.

YELLOW:
  Entries are promising but exits need more data. TerminalRunner may run shadow-only.

RED:
  Entries hit targets inconsistently or drawdowns dominate. Revise scoring before automation.
```

## Definition Of Done

Phase 8.9 is complete when:

- [x] `pnpm shadow:observe --once` exists.
- [x] `pnpm shadow:exits --once` exists.
- [x] BUY candidates can be monitored at 1-minute style horizons.
- [x] score-50/55 shadow candidates can be included explicitly for research.
- [x] target/stop/max-hold simulations are reported per candidate.
- [x] run-level shadow portfolio results are reported.
- [x] no orders, fills, positions, wallet activity, signing, or submission occur.
- [x] tests cover config, selection, scheduling, simulation, reporting, and safety.
- [x] `pnpm verify` passes.
- [x] docs and Phase 9 handoff are updated.

## Implementation Notes

Implemented command surfaces:

```bash
pnpm shadow:observe
pnpm shadow:exits
pnpm --filter @nexustrade/backend shadow:observe
pnpm --filter @nexustrade/backend shadow:exits
```

Implemented entrypoints:

```text
backend/src/scripts/shadow-observe.ts
backend/src/scripts/shadow-exits.ts
```

Implemented backend module:

```text
backend/src/shadow
```

First-pass implementation reuses `watchlist_return_observations` for fast post-decision horizons.
`shadow:observe` adapts the existing watchlist runner with Phase 8.9 defaults. `shadow:exits`
simulates target, stop, max-hold, and run-level portfolio outcomes without creating orders, fills,
positions, wallet activity, signing, or transaction submission.
