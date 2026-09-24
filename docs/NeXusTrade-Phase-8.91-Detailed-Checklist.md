# NeXusTrade Phase 8.91 Detailed Checklist

Cross-Run Shadow Calibration + Entry Confirmation Research

Last updated: July 2026

Status: Complete.

Mode: `PAPER` research and simulation only.

## Implementation Completion Notes

Phase 8.91 has been implemented as a read-only diagnostics command:

```bash
pnpm shadow:calibrate --once
```

The implementation adds:

- `backend/src/scripts/shadow-calibrate.ts`
- `backend/src/shadow-calibration/ShadowCalibrationConfig.ts`
- `backend/src/shadow-calibration/ShadowRunLoader.ts`
- `backend/src/shadow-calibration/ShadowCalibrationReportService.ts`
- `backend/src/shadow-calibration/ShadowCalibrationReportFormatter.ts`
- `backend/src/shadow-calibration/ShadowCalibrationTypes.ts`
- focused tests under `backend/src/shadow-calibration/*.test.ts`

The command supports active paper DB analysis, archived DB analysis, report-only archive folders,
text output, and JSON output. Archived databases are opened with SQLite read-only mode and
`query_only = ON`.

Real archive smoke command:

```powershell
corepack pnpm shadow:calibrate --once `
  --label-db=Test1:data/archive/phase8.9/test1-20260702-2014 `
  --label-db=Test2:data/archive/phase8.9/test2-20260703-1112 `
  --label-db=Test3:data/archive/phase8.9/test3-20260703-1633
```

Smoke result:

```text
database runs: 2
report-only runs: 1
observed decisions: 29
unique mints: 12
orders=0 fills=0 positions=0
```

Important archive note:

```text
Test 1 has no archived nexus_paper.db snapshot, so Phase 8.91 can only parse limited report-only
metrics for that run. Tests 2 and 3 contain archived DB snapshots and support full decision-level,
unique-mint, scenario-grid, entry-confirmation, and filter analysis.
```

Initial implementation recommendation from the archived run smoke:

```text
Keep Phase 8.91 read-only.
Do not lower real BUY behavior yet.
Treat score 55-64 and WATCH candidates as a shadow-confirmation research band.
Consider Phase 8.92 for a WATCH-first / confirmation-gated entry workflow if more tests confirm
the pattern.
```

Final Phase 8.91 validation handoff:

```text
report = data/phase8.91-cross-run-final.txt
runs = 3
observed decisions = 66
unique mints = 18
orders = 0
fills = 0
positions = 0
```

Final archive sources:

```text
data/archive/phase8.91/test1-phase8.91-test1-20260703-2155
data/archive/phase8.91/test2-phase8.91-test2-20260704-1324
data/archive/phase8.91/test3-phase8.91-test3-20260706-1405
```

Final cross-run signal:

```text
BUY:   n=10, +10% hit=40.00%, avgWorst=-46.77%, drawdownFirst -10%=70.00%
WATCH: n=17, +10% hit=47.06%, avgWorst=-11.38%, drawdownFirst -10%=58.82%
SKIP:  n=39, +10% hit=28.21%, avgWorst=-23.92%, drawdownFirst -10%=66.67%

score 65-69: n=24, +10% hit=45.83%, avgWorst=-26.21%, drawdownFirst -10%=62.50%
score 55-59: n=31, +10% hit=35.48%, avgWorst=-23.58%, drawdownFirst -10%=58.06%

duplicate_buy_blocked: n=16, +10% hit=50.00%, avgWorst=-11.15%, drawdownFirst -10%=56.25%
not_duplicate:         n=50, +10% hit=30.00%, avgWorst=-28.31%, drawdownFirst -10%=68.00%

average Jupiter RATE_LIMITED = 54.89%
```

Final recommendation:

```text
Do not enable default automated paper BUY in Phase 9.
Do implement Phase 8.92 as a shadow-only calibrated entry-gate workbench.
Use Phase 8.92 to compare raw BUY against score-band, duplicate-attention, confirmation,
early-drawdown, first-entry, latest-entry, target/stop, and max-hold profiles.
```

## Executive Summary

Phase 8.91 is a small calibration phase between Phase 8.9 and Phase 9.

Phase 8.9 proved that the shadow observation and exit-simulation system works. Three clean
validation runs showed repeatable mechanics:

- scanner runs completed for roughly 2 hours each,
- risk and strategy ran repeatedly,
- high-frequency shadow observations were collected,
- target/stop/max-hold simulations were produced,
- no wallet activity, signing, transaction submission, orders, fills, or positions occurred.

The trading signal is still not strong enough to move into automated paper BUY orchestration. The
current `BUY >= 65` behavior repeatedly selected weak or dangerous entries, while several
score-50/55/65 `WATCH` or `SKIP` candidates produced better fast upside.

Phase 8.91 should not make the system trade. It should make the research sharper.

## Why This Phase Exists

The first three Phase 8.9 shadow tests produced a clear pattern.

Run 1:

```text
radar=56
strategy=35
observedReturns=234
BUY hit +10% = 0%
BUY avgBest = -3.78%
BUY avgWorst = -41.05%
```

Run 2:

```text
radar=77
strategy=45
observedReturns=306
BUY hit +10% = 0%
BUY avgBest = -30.22%
BUY avgWorst = -43.53%
```

Run 3:

```text
radar=69
strategy=51
observedReturns=187
BUY hit +10% = 33.33%
BUY avgBest = +4.34%
BUY avgWorst = -17.00%
```

Across the same runs, score-55 and WATCH candidates often produced better upside:

```text
Run 1 score-55/near-miss candidates showed some fast winners.
Run 2 score-55 SKIP candidates hit +10% at 61.54%.
Run 3 WATCH candidates hit +10% at 100%, and score-55 candidates hit +10% at 75%.
```

Interpretation:

```text
The current score is useful for filtering obvious junk.
The current BUY decision is not yet a reliable entry trigger.
The strongest signal may be in entry confirmation, duplicate-buy-blocked WATCH rows,
and score-55 near misses rather than raw BUY threshold alone.
```

## Phase Objective

Build a paper-only calibration layer that can answer:

- Which Phase 8.9 run performed best by strategy decision type?
- Which score bands actually produced target-before-stop behavior?
- Do repeated decisions for the same mint inflate the apparent signal?
- Would delayed entry confirmation improve results?
- Would a 1-minute, 2-minute, or 3-minute confirmation rule avoid false-positive BUYs?
- Which target/stop/max-hold scenario performs best across runs?
- Are `WATCH` and duplicate-buy-blocked rows better candidates than raw `BUY` rows?
- Which candidate filters appear predictive across runs?
- Should the next test batch use different thresholds or only different reporting?

Phase 8.91 should produce enough evidence to decide whether Phase 9 starts in:

```text
shadow-only mode
paper BUY gated behind shadow confirmation
or delayed until scoring is changed
```

## Phase 8.91 Versus Phase 8.92 Boundary

Phase 8.91 is the diagnostic phase.

It should build the measurement tools and reports needed to decide what should change. It should
not change production strategy behavior, execution behavior, score weights, BUY defaults, exit
defaults, or paper trading flow.

Final Phase 8.91 results did not provide enough evidence to change paper execution defaults.
Phase 8.92 should therefore be a shadow-only entry-gate research phase before any behavior changes
are promoted into paper execution.

Recommended split:

```text
Phase 8.91:
  measure
  compare
  simulate
  explain
  recommend

Phase 8.92:
  build calibrated shadow entry gates
  compare candidate profiles and entry timing
  simulate confirmation and early-drawdown filters
  report target/stop/max-hold outcomes by profile
  prepare Phase 9 orchestration defaults
```

Potential Phase 8.92 research profiles:

- Add an explicit entry confirmation gate before paper BUY.
- Treat raw `BUY` as approved-for-observation instead of immediate execution.
- Promote strong `WATCH` or duplicate-buy-blocked candidates into an entry-watch flow.
- Tune score weights only if Phase 8.91 identifies stable cross-run evidence.
- Add initial fast-exit assumptions such as `+10%` target and `-10%` stop for paper simulation.
- Reject candidates with bad first-minute drawdown before paper BUY.
- Split scoring into separate concepts:

```text
candidate quality score
entry timing score
exit feasibility score
```

Rule:

```text
Do not promote Phase 8.92 research gates into paper execution until a fresh validation batch proves
they improve target-before-drawdown behavior.
```

## Locked Safety Boundary

- [ ] `PAPER` mode only.
- [ ] Read-only against trading state unless explicitly archiving local data files.
- [ ] No wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.
- [ ] No live swap execution.
- [ ] No real order submission.
- [ ] No paper orders.
- [ ] No paper fills.
- [ ] No paper positions.
- [ ] No session cash changes.
- [ ] No TokenRadar status changes.
- [ ] No RiskAssessment writes.
- [ ] No StrategyDecision writes.
- [ ] No production threshold default changes in the first pass.
- [ ] No migration unless a later implementation review proves it is necessary.
- [ ] All local experiment databases and transcripts remain ignored by Git.

## Recommended Command Surface

Add a new report command:

```bash
pnpm shadow:calibrate
pnpm --filter @nexustrade/backend shadow:calibrate
```

Recommended entrypoint:

```text
backend/src/scripts/shadow-calibrate.ts
```

Recommended usage:

```powershell
corepack pnpm shadow:calibrate --once `
  --label-db=Run1:data/archive/phase8.9/test1-20260702-2014 `
  --label-db=Run2:data/archive/phase8.9/test2-20260703-1112 `
  --label-db=Run3:data/archive/phase8.9/test3-20260703-1633
```

Allow either a directory containing `nexus_paper.db` or a direct `.db` path:

```powershell
corepack pnpm shadow:calibrate --once --label-db=Run3:data/archive/phase8.9/test3-20260703-1633/nexus_paper.db
```

JSON output:

```powershell
corepack pnpm shadow:calibrate --once --json --label-db=Run3:data/archive/phase8.9/test3-20260703-1633
```

## Runtime Defaults

Use these defaults first:

```text
targetPcts = 10,15,25
stopPcts = 10,15,25
maxHoldMinutes = 15,30,60
confirmationHorizonsMinutes = 1,2,3
confirmationMinReturnPct = 0,2,5
confirmationMaxDrawdownPct = 5,10
scoreBuckets = 5
minScore = 50
sourceDecisions = BUY,WATCH,SKIP
dedupeMode = decision
portfolioStartingSol = 1
portfolioPositionSizeSol = 0.01
portfolioGoalPct = 25
portfolioMaxPositions = 5
```

Supported dedupe modes:

```text
decision
mint_best_entry
mint_first_entry
mint_latest_entry
```

Default should remain `decision` for comparability with current reports. The report must also show
a unique-mint section so repeated decisions for the same mint do not overstate confidence.

## Data Inputs

Phase 8.91 can use the existing schema.

Primary tables:

- [ ] `sessions`
- [ ] `token_radar`
- [ ] `risk_assessments`
- [ ] `strategy_decisions`
- [ ] `watchlist_return_observations`
- [ ] `provider_health`
- [ ] `system_logs`

Existing archived run folders:

```text
data/archive/phase8.9/test1-20260702-2014
data/archive/phase8.9/test2-20260703-1112
data/archive/phase8.9/test3-20260703-1633
```

Pre-implementation archival requirement:

- [ ] Move active Test 3 files into `data/archive/phase8.9/test3-20260703-1633`.
- [ ] Include `nexus_paper.db`, `nexus_paper.db-wal`, and `nexus_paper.db-shm`.
- [ ] Keep the root `data` directory clean before the next validation run.
- [ ] Run `corepack pnpm db:reset:paper` only after the DB snapshot is archived.

## Proposed Backend Module Structure

Add:

```text
backend/src/shadow-calibration/
  ShadowCalibrationConfig.ts
  ShadowCalibrationRepository.ts
  ShadowCalibrationReportService.ts
  ShadowRunLoader.ts
  ShadowRunAggregator.ts
  EntryConfirmationSimulator.ts
  ScenarioPortfolioGrid.ts
  UniqueMintAnalyzer.ts
  ShadowCalibrationFormatter.ts
  ShadowCalibrationTypes.ts
  *.test.ts
```

Alternative:

```text
backend/src/shadow/calibration/
```

Use `backend/src/shadow-calibration` if the implementation grows beyond a thin extension of the
existing shadow module. Use `backend/src/shadow/calibration` only if it stays tightly coupled to
the current `ShadowExitSimulator` and `ShadowPortfolioSimulator`.

## Chunk 1: Archive And Input Handling

Implement:

- [ ] Archive helper documentation for completed Phase 8.9 runs.
- [ ] `ShadowCalibrationConfig.ts`.
- [ ] `ShadowRunLoader.ts`.
- [ ] Support `--label-db=<label>:<path>`.
- [ ] Support directories that contain `nexus_paper.db`.
- [ ] Support direct `.db` file paths.
- [ ] Open archived DBs read-only.
- [ ] Reject missing labels.
- [ ] Reject duplicate labels.
- [ ] Reject missing DB paths with a clear error.
- [ ] Reject live-mode DB paths.

Config options:

- [ ] `--once`
- [ ] `--json`
- [ ] `--label-db=<label>:<path>`
- [ ] `--session-id=<id>`
- [ ] `--target-pcts=10,15,25`
- [ ] `--stop-pcts=10,15,25`
- [ ] `--max-hold-minutes=15,30,60`
- [ ] `--confirmation-horizons=1,2,3`
- [ ] `--confirmation-min-return-pcts=0,2,5`
- [ ] `--confirmation-max-drawdown-pcts=5,10`
- [ ] `--score-bucket-size=5`
- [ ] `--min-score=50`
- [ ] `--source-decisions=BUY,WATCH,SKIP`
- [ ] `--dedupe-mode=decision|mint_best_entry|mint_first_entry|mint_latest_entry`
- [ ] `--portfolio-starting-sol=1`
- [ ] `--portfolio-position-size-sol=0.01`
- [ ] `--portfolio-goal-pct=25`
- [ ] `--portfolio-max-positions=5`

Acceptance:

- [ ] Can load Test 1, Test 2, and Test 3 archived DBs in one command.
- [ ] Can load a single active DB when no `--label-db` is supplied.
- [ ] Invalid archive paths fail before any report work begins.
- [ ] All DB access is read-only.

## Chunk 2: Cross-Run Aggregate Report

Aggregate per run:

- [ ] scanner runtime minutes from `SystemLog`.
- [ ] scanner cycle count.
- [ ] risk summary count.
- [ ] strategy summary count.
- [ ] TokenRadar count.
- [ ] RiskAssessment count.
- [ ] StrategyDecision count.
- [ ] observed return count.
- [ ] observed decision count.
- [ ] provider health counts.
- [ ] Jupiter rate-limited percentage.
- [ ] orders/fills/positions count, expected zero.

Aggregate across runs:

- [ ] total observed decisions.
- [ ] total unique mints.
- [ ] decision distribution by `BUY`, `WATCH`, `SKIP`.
- [ ] score distribution.
- [ ] average best return by decision.
- [ ] average worst return by decision.
- [ ] target hit rates by decision.
- [ ] drawdown breach rates by decision.
- [ ] false-positive BUY count.
- [ ] missed opportunity count.

Acceptance:

- [ ] Report clearly states whether each run is mechanically valid.
- [ ] Report highlights any run with incomplete observation coverage.
- [ ] Report distinguishes decision-level results from unique-mint results.

## Chunk 3: Unique-Mint Analysis

Problem:

Repeated decisions for the same mint can exaggerate signal. A token like `WIN` can appear several
times with different baselines, and the report needs to make that visible.

Implement:

- [ ] unique mint count per run.
- [ ] decision count per mint.
- [ ] best entry per mint by target-before-stop result.
- [ ] first entry per mint.
- [ ] latest entry per mint.
- [ ] mint-level target hit rates.
- [ ] mint-level drawdown rates.
- [ ] mint-level false positive report.
- [ ] repeated-decision inflation warning when one mint dominates a run.

Acceptance:

- [ ] Test 3 `WIN`-like repeated decisions are summarized as one mint in unique-mint mode.
- [ ] Decision-level and mint-level results can differ and are both shown.
- [ ] The report names the top mints that dominate observations.

## Chunk 4: Scenario Portfolio Grid

Current Phase 8.9 portfolio output uses one primary scenario. Phase 8.91 should simulate all
target/stop/max-hold combinations.

For each scenario:

- [ ] target percentage.
- [ ] stop percentage.
- [ ] max hold minutes.
- [ ] evaluated decision count.
- [ ] target hit count.
- [ ] stop hit count.
- [ ] max-hold count.
- [ ] average exit return.
- [ ] median exit return.
- [ ] win rate.
- [ ] loss rate.
- [ ] simulated ending SOL.
- [ ] simulated P/L SOL.
- [ ] simulated P/L percent.
- [ ] max drawdown percent.
- [ ] goal reached boolean.

Sort output by:

```text
1. goalReached
2. simulatedPnlPct
3. maxDrawdownPct ascending
4. evaluatedCount descending
```

Acceptance:

- [ ] Report shows the best scenario per run.
- [ ] Report shows the best scenario across all runs.
- [ ] Report does not imply simulated P/L is realized P/L.

## Chunk 5: Entry Confirmation Simulator

Research question:

Would waiting 1, 2, or 3 minutes and entering only after favorable early behavior avoid bad BUYs
while preserving useful winners?

Simulate confirmation rules:

```text
confirm at horizon H
enter only if return at H >= minReturnPct
reject if any observed return through H <= -maxDrawdownPct
then simulate target/stop/max-hold from the confirmation baseline
```

First-pass approximation:

- [ ] Use observed return at confirmation horizon as the new baseline adjustment.
- [ ] Rebase later observed returns relative to the confirmation horizon.
- [ ] If no confirmation horizon is observed, mark `NO_CONFIRMATION_DATA`.
- [ ] If early drawdown breaches the confirmation rule, mark `CONFIRMATION_REJECTED`.
- [ ] If confirmed, evaluate target/stop/max-hold after the confirmation horizon.

Confirmation scenarios:

```text
H = 1m, 2m, 3m
minReturnPct = 0%, 2%, 5%
maxDrawdownPct = 5%, 10%
```

Output:

- [ ] candidates considered.
- [ ] candidates confirmed.
- [ ] candidates rejected.
- [ ] target hits after confirmation.
- [ ] stop hits after confirmation.
- [ ] average confirmed exit return.
- [ ] false-positive BUYs avoided.
- [ ] missed winners caused by waiting.

Acceptance:

- [ ] A candidate that drops below `-10%` at 1m is rejected by confirmation.
- [ ] A candidate that is flat at 1m and pumps at 7m can be evaluated separately.
- [ ] A candidate that already hit +10% before confirmation is treated as a possible missed fast
      move, not a clean confirmed entry.

## Chunk 6: Candidate Filter Analysis

Evaluate observed outcomes by filter buckets:

- [ ] decision type: `BUY`, `WATCH`, `SKIP`.
- [ ] score bucket.
- [ ] risk score bucket.
- [ ] risk result.
- [ ] quote available vs missing quote.
- [ ] price impact available vs missing impact.
- [ ] authority evidence available vs missing.
- [ ] liquidity bucket.
- [ ] volume 1h bucket.
- [ ] pair age bucket.
- [ ] duplicate-buy-blocked vs not duplicate-buy-blocked.
- [ ] Jupiter OK/degraded/rate-limited context.

Candidate filter outputs:

- [ ] hit rate for +10%, +15%, +25%.
- [ ] drawdown-first rate for -10%, -15%, -25%.
- [ ] average best return.
- [ ] average worst return.
- [ ] median best return.
- [ ] median worst return.
- [ ] sample size.
- [ ] confidence warning when sample size is small.

Acceptance:

- [ ] Report can say whether quote availability helped or harmed in the observed runs.
- [ ] Report can say whether missing quote is correlated with missed winners or just provider noise.
- [ ] Report can identify if duplicate-buy-blocked WATCH rows are outperforming raw BUY rows.

## Chunk 7: Recommendation Engine

Do not automatically change code behavior.

Produce recommendations with confidence levels:

```text
HIGH
MEDIUM
LOW
INSUFFICIENT_DATA
```

Recommendation categories:

- [ ] keep current thresholds.
- [ ] test lower threshold only in shadow.
- [ ] test WATCH-first entry confirmation.
- [ ] test score-55 shadow inclusion.
- [ ] require quote availability.
- [ ] do not require quote availability yet.
- [ ] raise/lower liquidity weight.
- [ ] raise/lower volume weight.
- [ ] add entry confirmation before paper BUY.
- [ ] stay shadow-only for Phase 9.

Acceptance:

- [ ] Recommendations include the evidence lines that caused them.
- [ ] Recommendations do not overstate small samples.
- [ ] Recommendations explicitly say whether paper BUY remains blocked.

## Chunk 8: Report Format

Human-readable report sections:

```text
NeXusTrade Shadow Calibration Report
Run Inventory
Mechanical Validity
Cross-Run Summary
Decision-Level Outcomes
Unique-Mint Outcomes
Scenario Portfolio Grid
Entry Confirmation Simulation
Candidate Filter Analysis
False Positive BUYs
Missed Fast Winners
Provider Impact
Recommendations
Next Test Plan
```

JSON shape:

```ts
interface ShadowCalibrationReportJson {
  generatedAtMs: number;
  config: ShadowCalibrationRuntimeConfig;
  runs: ShadowCalibrationRunSummary[];
  aggregate: ShadowAggregateSummary;
  decisionOutcomes: ShadowDecisionOutcomeSummary[];
  uniqueMintOutcomes: ShadowUniqueMintOutcomeSummary[];
  scenarioPortfolioGrid: ShadowScenarioPortfolioSummary[];
  confirmationResults: EntryConfirmationSummary[];
  filterAnalysis: CandidateFilterSummary[];
  recommendations: ShadowCalibrationRecommendation[];
  nextTestPlan: string[];
}
```

Acceptance:

- [ ] Text report is readable in PowerShell.
- [ ] JSON report is stable enough for future dashboard use.
- [ ] Report names archived DB labels in every major section.

## Chunk 9: Tests

Add tests under:

```text
backend/src/shadow-calibration/*.test.ts
```

Config tests:

- [ ] parses `--label-db`.
- [ ] parses directory and file DB paths.
- [ ] rejects invalid labels.
- [ ] rejects duplicate labels.
- [ ] parses target/stop/confirmation grids.
- [ ] rejects invalid percentages.
- [ ] rejects invalid dedupe mode.

Aggregation tests:

- [ ] summarizes multiple runs.
- [ ] separates decision-level and mint-level counts.
- [ ] detects incomplete observation coverage.
- [ ] flags nonzero orders/fills/positions as safety warnings.

Entry confirmation tests:

- [ ] rejects early drawdown.
- [ ] confirms early positive movement.
- [ ] handles missing confirmation horizon.
- [ ] rebases later returns after confirmation.
- [ ] identifies missed fast move before confirmation.

Portfolio grid tests:

- [ ] evaluates every target/stop/max-hold scenario.
- [ ] ranks scenarios by simulated P/L and drawdown.
- [ ] respects max positions.
- [ ] preserves simulated-only language.

Read-only safety tests:

- [ ] no orders created.
- [ ] no fills created.
- [ ] no positions created.
- [ ] no TokenRadar updates.
- [ ] no StrategyDecision writes.
- [ ] no RiskAssessment writes.
- [ ] no session cash/status updates.

## Chunk 10: Documentation Updates

Update:

- [ ] `docs/ROADMAP.md`
- [ ] `docs/Structure.md`
- [ ] `docs/Phase-9-Planning-Inputs.md`

Add implementation notes:

- [ ] Phase 8.91 is a calibration phase, not an execution phase.
- [ ] Explain why three Phase 8.9 runs justify calibration before Phase 9.
- [ ] Explain decision-level versus unique-mint analysis.
- [ ] Explain entry confirmation simulation assumptions.
- [ ] Explain that endpoint observations are not executable tick data.
- [ ] Explain how Phase 8.91 determines the next 3-run test plan.

## Known Limitations

- Observed prices are endpoint observations, not tick-level prices.
- A 1-minute observation can still miss a fast wick.
- Shadow confirmation does not prove executable Jupiter routing.
- DexScreener prices may not match executable swap quotes.
- Jupiter rate limiting still weakens quote confidence.
- Sample sizes are still small after three runs.
- Repeated decisions for one mint can dominate a run.
- The report can recommend changes, but it should not automatically apply them.

## Recommended Implementation Order

Small chunks:

```text
1. archive Test 3 data
2. config and script surface
3. archived DB loader
4. run summary aggregation
5. unique-mint analyzer
6. scenario portfolio grid
7. entry confirmation simulator
8. candidate filter analysis
9. report formatter
10. tests
11. docs and Phase 9 handoff update
12. run report against Tests 1-3
13. define the next 3-run validation plan
```

## Acceptance Test Data

Use these local archived Phase 8.9 runs:

```text
Run1 = data/archive/phase8.9/test1-20260702-2014
Run2 = data/archive/phase8.9/test2-20260703-1112
Run3 = data/archive/phase8.9/test3-20260703-1633
```

Expected high-level truths:

- [ ] Run 1 BUY hit `+10%` at `0%`.
- [ ] Run 2 BUY hit `+10%` at `0%`.
- [ ] Run 3 BUY hit `+10%` at `33.33%`.
- [ ] Run 2 score-55 SKIP candidates outperformed BUY candidates.
- [ ] Run 3 WATCH candidates outperformed raw BUY candidates.
- [ ] Jupiter rate limiting stayed above roughly `55%`.
- [ ] Orders, fills, and positions stayed at zero.

## Next Test Plan After Implementation

After Phase 8.91 report implementation, run three more clean tests using whatever the report
recommends. Candidate options:

```text
Batch A: keep thresholds, add entry confirmation only.
Batch B: evaluate WATCH-first shadow entries.
Batch C: include score-55 candidates but require confirmation.
```

Do not enable `paper:execute` unless Phase 8.91 shows a materially stronger target-before-stop
profile than the first three Phase 8.9 runs.

If Phase 8.91 recommends behavior changes, create or implement Phase 8.92 before the next
comparison batch. The next batch should then compare:

```text
Tests 1-3 baseline behavior
versus
Tests 4-6 calibrated Phase 8.92 behavior
```

## Phase 9 Handoff

Phase 9 should start as TerminalRunner shadow orchestration. The final Phase 8.91 runs did not
prove a strong enough execution profile for default paper BUY automation, so Phase 8.92 should
evaluate calibrated entry gates before Phase 9 enables `paper:execute` inside a loop.

Recommended Phase 9 default before proof:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow calibration / shadow exits
-> no paper BUY by default
```

Potential upgraded Phase 9 path after proof:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> entry confirmation gate
-> optional paper BUY
-> session manage
-> exits manage
```

Phase 8.92 handoff:

```text
Build `pnpm shadow:entries --once`.
Keep the command read-only.
Compare candidate profiles and entry timing.
Require another 3-run validation batch before changing paper BUY defaults.
```

## Definition Of Done

Phase 8.91 is complete when:

- [x] `pnpm shadow:calibrate --once` exists.
- [x] The report can load active and archived paper DBs read-only.
- [x] The report can compare Tests 1, 2, and 3 in one command.
- [x] Cross-run decision-level outcomes are reported.
- [x] Cross-run unique-mint outcomes are reported.
- [x] Scenario portfolio grids are reported.
- [x] Entry confirmation simulations are reported.
- [x] Candidate filter analysis is reported.
- [x] False-positive BUYs and missed fast winners are reported across runs.
- [x] Recommendations include confidence levels and evidence.
- [x] No trading-state writes occur.
- [x] Tests cover config, aggregation, unique-mint analysis, confirmation, portfolio grid, and
      read-only safety.
- [x] `pnpm verify` passes.
- [x] Docs and Phase 9 handoff are updated.
