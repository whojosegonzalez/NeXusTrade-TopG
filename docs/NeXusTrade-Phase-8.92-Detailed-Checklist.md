# NeXusTrade Phase 8.92 Detailed Checklist

Calibrated Shadow Entry-Gate Experimentation Workbench

Last updated: July 2026

Status: Complete.

Mode: `PAPER` research and simulation only.

## Implementation Completion Notes

Implemented command:

```powershell
corepack pnpm shadow:entries --once
```

Implemented files:

```text
backend/src/scripts/shadow-entries.ts
backend/src/shadow-entry/ShadowEntryConfig.ts
backend/src/shadow-entry/ShadowEntryTypes.ts
backend/src/shadow-entry/ShadowEntryCandidateLoader.ts
backend/src/shadow-entry/ShadowEntryProfile.ts
backend/src/shadow-entry/ShadowEntryReportService.ts
backend/src/shadow-entry/ShadowEntryReportFormatter.ts
backend/src/shadow-entry/*.test.ts
```

Package scripts:

```text
backend/package.json -> shadow:entries
package.json -> shadow:entries
```

Archived Phase 8.91 baseline smoke:

```powershell
corepack pnpm shadow:entries --once `
  --label-db=Test1:data/archive/phase8.91/test1-phase8.91-test1-20260703-2155 `
  --label-db=Test2:data/archive/phase8.91/test2-phase8.91-test2-20260704-1324 `
  --label-db=Test3:data/archive/phase8.91/test3-phase8.91-test3-20260706-1405
```

Smoke result:

```text
runs = 3
observed decisions = 66
unique mints = 18
orders = 0
fills = 0
positions = 0
P001 baseline reproduction = passed
observed baseline = entries 10, hit10 40.00%, avgWorst -46.7714%, drawdownFirst10 70.00%
archived profile readiness = NOT_READY
paper execution = disabled
```

Phase 8.92 landed as an experimentation framework, not a production strategy change. Profiles are
implemented as presets composed from independent dimensions such as decision source, score bucket,
entry timing, confirmation rule, drawdown mode, recovery rule, duplicate policy, quote policy, and
exit grid. Future profiles should primarily be created by composing those dimensions rather than
introducing hard-coded strategy paths.

## Fresh Validation Follow-Up

Four fresh Phase 8.92 validation runs completed on July 7, 2026:

```text
data/archive/phase8.92/test1-phase8.92-test1-20260707-1017
data/archive/phase8.92/test2-phase8.92-test2-20260707-1418
data/archive/phase8.92/test3-phase8.92-test3-20260707-1816
data/archive/phase8.92/test4-phase8.92-test4-20260707-2148
```

Fresh result:

```text
runs = 4
observed decisions = 68
unique mints = 25
orders = 0
fills = 0
positions = 0
```

Main signal:

```text
BUY remained too exposed.
WATCH candidates looked better risk-adjusted but were concentrated.
duplicate_blocked candidates were the strongest small-sample signal.
score 65-69 candidates outperformed lower score buckets.
missing Jupiter quote still should not be a hard rejection gate.
```

Follow-up:

```text
Phase 8.92B should refine fresh-run baseline wording, normalized profile summaries, readiness
details, and focused WATCH/duplicate/score research profiles before Phase 9 consumes this output.
```

## Executive Summary

Phase 8.92 exists because Phase 8.91 answered the immediate question: raw `BUY` decisions are not
safe enough for default paper execution, but the system is finding tokens that move.

The problem is entry quality and entry timing, not scanner stability.

Phase 8.92 should build a shadow-only calibrated entry-gate experimentation workbench that can say:

```text
Given this StrategyDecision and early observed movement,
would this candidate have been entered,
skipped,
warned, rejected, or recovered after early drawdown,
missed because it moved too fast,
or held out for insufficient confirmation?
```

The phase should not create paper orders, fills, positions, cash changes, wallet activity, signing,
or live swaps. It should create a precise entry-gate evaluator and reports that can be tested
against another 3-run validation batch before Phase 9.

Core principle:

```text
Phase 8.92 tests entry and exit hypotheses.
It does not promote any rule into live strategy, paper execution, or TerminalRunner defaults.
```

Important framing:

```text
Early drawdown is evidence, not an automatic permanent rejection.
Some highly volatile candidates recover strongly after early downside.
Phase 8.92 must measure, classify, and compare early drawdown behavior across profiles.
Rejection should be configurable by profile, not hard-coded globally.
```

## Phase 8.91 Evidence

Final Phase 8.91 cross-run report:

```text
data/phase8.91-cross-run-final.txt
```

Final Phase 8.91 archive sources:

```text
data/archive/phase8.91/test1-phase8.91-test1-20260703-2155
data/archive/phase8.91/test2-phase8.91-test2-20260704-1324
data/archive/phase8.91/test3-phase8.91-test3-20260706-1405
```

Cross-run totals:

```text
runs = 3
observed decisions = 66
unique mints = 18
orders = 0
fills = 0
positions = 0
```

Key outcome summary:

```text
BUY:
  n = 10
  +10% hit = 40.00%
  avgWorst = -46.77%
  drawdownFirst -10% = 70.00%

WATCH:
  n = 17
  +10% hit = 47.06%
  avgWorst = -11.38%
  drawdownFirst -10% = 58.82%

SKIP:
  n = 39
  +10% hit = 28.21%
  avgWorst = -23.92%
  drawdownFirst -10% = 66.67%
```

Candidate filter signals:

```text
score 65-69:
  n = 24
  +10% hit = 45.83%
  avgWorst = -26.21%
  drawdownFirst -10% = 62.50%

score 55-59:
  n = 31
  +10% hit = 35.48%
  avgWorst = -23.58%
  drawdownFirst -10% = 58.06%

duplicate_buy_blocked:
  n = 16
  +10% hit = 50.00%
  avgWorst = -11.15%
  drawdownFirst -10% = 56.25%

not_duplicate:
  n = 50
  +10% hit = 30.00%
  avgWorst = -28.31%
  drawdownFirst -10% = 68.00%
```

Provider signal:

```text
Average Jupiter RATE_LIMITED across archived runs = 54.89%
```

Interpretation:

```text
The system can detect movement.
Raw BUY does not control downside.
Score alone does not solve entry timing.
Duplicate-blocked / repeated-attention rows may contain signal.
Quote availability is not yet a clean quality filter.
Phase 9 should stay shadow-only until a calibrated gate improves target-before-stop behavior.
```

## Phase Objective

Build a shadow-only entry gate workbench that can:

- compare candidate entry profiles against the Phase 8.91 baseline,
- evaluate decision type plus score bucket combinations,
- test duplicate-blocked and repeated-attention signals,
- test first-entry versus latest-entry behavior,
- simulate entry confirmation, early-drawdown warnings, rejection, and recovery,
- classify candidates with explicit gate outcomes,
- compare every profile against the immutable baseline,
- report which target/stop/max-hold grid works best for each profile,
- classify Phase 9 readiness without enabling paper execution,
- produce report evidence for a Phase 8.92 three-run validation batch,
- prepare a reusable service boundary that Phase 9 can orchestrate later.

## Non-Goals

Phase 8.92 must not:

- enable `paper:execute` by default,
- create paper orders,
- create fills,
- create positions,
- update cash,
- update realized or unrealized P/L,
- update TokenRadar status,
- write StrategyDecision rows,
- write RiskAssessment rows,
- load wallets,
- sign transactions,
- submit transactions,
- change scoring weights,
- change BUY thresholds,
- change WATCH thresholds,
- change production strategy defaults,
- change production strategy thresholds by default,
- change `paper:execute` behavior,
- promote any profile into TerminalRunner defaults,
- change live-trading behavior,
- add a DB migration in the first pass.

## Locked Safety Boundary

- [ ] `PAPER` mode only.
- [ ] Read-only analysis by default.
- [ ] No wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.
- [ ] No live swap execution.
- [ ] No real order submission.
- [ ] No paper order creation.
- [ ] No paper fill creation.
- [ ] No paper position creation.
- [ ] No session cash mutation.
- [ ] No TokenRadar mutation.
- [ ] No StrategyDecision mutation.
- [ ] No RiskAssessment mutation.
- [ ] No `paper:execute` orchestration in Phase 8.92.
- [ ] No migration unless implementation review proves that report-only output is insufficient.

## Recommended Command Surface

Add a new shadow entry gate report command:

```bash
pnpm shadow:entries --once
pnpm --filter @nexustrade/backend shadow:entries --once
```

Recommended entrypoint:

```text
backend/src/scripts/shadow-entries.ts
```

Recommended active-session usage:

```powershell
corepack pnpm shadow:entries --once
```

Recommended archived comparison usage:

```powershell
corepack pnpm shadow:entries --once `
  --label-db=Test1:data/archive/phase8.91/test1-phase8.91-test1-20260703-2155 `
  --label-db=Test2:data/archive/phase8.91/test2-phase8.91-test2-20260704-1324 `
  --label-db=Test3:data/archive/phase8.91/test3-phase8.91-test3-20260706-1405
```

JSON output:

```powershell
corepack pnpm shadow:entries --once --json
```

The command should be read-only and should reuse the existing archived DB source conventions from
`shadow:calibrate`.

## Runtime Defaults

Start conservative:

```text
sourceDecisions = BUY,WATCH,SKIP
minScore = 50
scoreBuckets = 50-54,55-59,60-64,65-69,70-74,75-79
entryProfiles = P001,P002,P003,P004,P005,P006
confirmationHorizonsMinutes = 1,2,3
confirmationMinReturnPcts = 0,2,5
earlyDrawdownModes = off,warn_only,reject_5,reject_10,reject_15,require_recovery
recoveryConfirmationReturnPcts = 0,2,5
recoveryWindowMinutes = 3,5,10,15
targetPcts = 10,15,25
stopPcts = 10,15,25
maxHoldMinutes = 15,30,60
entryTimingModes = decision, first_entry, latest_entry
dedupeMode = decision
portfolioStartingSol = 1
portfolioPositionSizeSol = 0.01
portfolioGoalPct = 25
portfolioMaxPositions = 5
```

Do not set a default profile that implies paper BUY readiness.

The baseline profile is immutable:

```text
P001 baseline_raw_buy must preserve the current raw BUY behavior.
Future profiles are compared against P001.
Do not modify P001 to make later results look better.
```

Baseline reproduction requirement:

```text
P001 baseline_raw_buy must approximately reproduce the Phase 8.91 raw BUY metrics when run against:

data/archive/phase8.91/test1-phase8.91-test1-20260703-2155
data/archive/phase8.91/test2-phase8.91-test2-20260704-1324
data/archive/phase8.91/test3-phase8.91-test3-20260706-1405

If baseline reproduction fails, the Phase 8.92 implementation is incorrect.
```

## Profile Composition Principle

Profiles are presets built from independent experimental dimensions:

- score bucket,
- decision type,
- entry timing mode,
- confirmation rule,
- early drawdown mode,
- recovery rule,
- duplicate policy,
- quote policy,
- exit grid.

Future profiles should be created by composing these dimensions whenever possible instead of adding
profile-specific hard-coded logic.

Example:

```text
P003 duplicate_attention can be represented as:
  score >= 55
  decision types = BUY,WATCH,SKIP
  duplicate policy = duplicate_buy_blocked or repeated_mint
  timing modes = first_entry,latest_entry
  confirmation rule = required
  early drawdown mode = profile-configured
  quote policy = evidence_only
```

The implementation should make profile definitions declarative enough that a later profile can
combine existing dimensions such as:

```text
score 65-69
+ latest_entry
+ WARN_ONLY
+ duplicate_attention
+ target/stop/maxHold grid
```

without adding a new custom branch in the gate engine.

## Candidate Gate Outcomes

Use explicit, auditable outcomes:

```text
WOULD_ENTER
WOULD_SKIP
REJECT_SCORE_BAND
REJECT_DECISION_TYPE
REJECT_DUPLICATE_POLICY
REJECT_QUOTE_POLICY
REJECT_EARLY_DRAWDOWN
REJECT_CONFIRMATION_RETURN
WARN_EARLY_DRAWDOWN
RECOVERED_AFTER_DRAWDOWN
FAILED_RECOVERY_AFTER_DRAWDOWN
WOULD_ENTER_AFTER_RECOVERY
WOULD_SKIP_RECOVERY_TOO_LATE
MISSED_FAST_MOVE
INSUFFICIENT_CONFIRMATION_DATA
NO_OBSERVED_RETURNS
```

Each outcome should include:

- candidate mint,
- symbol when available,
- strategy decision ID,
- source decision,
- stored strategy score,
- profile name,
- entry timing mode,
- confirmation horizon,
- gate reason,
- first observed return,
- best observed return,
- worst observed return,
- simulated exit reason,
- simulated exit return,
- target-before-stop boolean.

## Initial Entry Profiles

Implement these profiles first.

### P001: Baseline Raw BUY

Purpose:

```text
Measure current behavior.
```

Rules:

```text
decision = BUY
score >= 65
no confirmation gate
dedupeMode = decision
```

This profile is immutable. It must approximately reproduce final Phase 8.91 raw BUY metrics against
the archived Phase 8.91 validation datasets. It must not be recommended for paper execution unless a
later phase separately promotes a validated profile after review.

### P002: Score 65 Confirmed

Purpose:

```text
Test whether score 65-69 candidates improve with early confirmation.
```

Rules:

```text
score >= 65
sourceDecisions = BUY,WATCH,SKIP
confirmation horizon = 1m, 2m, 3m
min confirmation return = 0%, 2%, 5%
early drawdown mode configurable by profile
```

Expected use:

```text
Shadow-only. No paper execution.
```

### P003: Duplicate Attention

Purpose:

```text
Test whether duplicate-buy-blocked or repeated-attention rows are a useful entry signal.
```

Rules:

```text
duplicateBuyBlocked = true
or repeated decisions for same mint within session
score >= 55
confirmation required
compare first_entry and latest_entry
```

Important:

```text
duplicateBuyBlocked is not automatically good.
It is only a signal to test because Phase 8.91 showed milder avgWorst values.
```

### P004: Score 55 Research

Purpose:

```text
Keep observing lower score movers without treating them as trade-ready.
```

Rules:

```text
score 55-59
sourceDecisions = WATCH,SKIP
confirmation required
early drawdown behavior configurable by profile
```

Expected use:

```text
Research only. Should not produce paper BUY readiness by itself.
```

### P005: Quote Control

Purpose:

```text
Measure whether quote availability should be a confidence input.
```

Rules:

```text
same candidate profile
split results by missing_quote vs quote_available
do not reject missing_quote by default
```

Reason:

```text
Phase 8.91 did not show quote availability as a clean quality filter, and Jupiter rate limiting was
high.
```

### P006: Recovery After Drawdown

Purpose:

```text
Test whether early drawdown followed by recovery is a better entry signal than immediate rejection.
```

Rules:

```text
earlyDrawdownMode = REQUIRE_RECOVERY
sourceDecisions = BUY,WATCH,SKIP
score >= 55
recovery window = 3m, 5m, 10m, 15m
recovery confirmation return = 0%, 2%, 5%
compare first_entry and latest_entry
```

Expected use:

```text
Research only.
This profile exists because volatile winners can dip early and recover strongly.
It must not turn recovery behavior into a production BUY rule in Phase 8.92.
```

## Entry Timing Modes

Support:

```text
decision
first_entry
latest_entry
```

Definitions:

```text
decision:
  every StrategyDecision is evaluated independently.

first_entry:
  one candidate per mint, earliest qualifying decision.

latest_entry:
  one candidate per mint, latest qualifying decision.
```

Do not use `mint_best_entry` as a candidate execution recommendation because it is hindsight. It
can remain available only as an analysis-only upper bound and must never appear as an
execution-style recommendation.

Optional hindsight mode:

```text
mint_best_entry
```

Constraint:

```text
mint_best_entry is allowed only for upper-bound analysis.
It must be labeled as hindsight and excluded from Phase 9 readiness recommendations.
```

## Early Drawdown Modes

Support configurable early drawdown behavior:

```text
OFF
WARN_ONLY
REJECT_5
REJECT_10
REJECT_15
REQUIRE_RECOVERY
```

Meanings:

```text
OFF:
  Do not gate on early drawdown.

WARN_ONLY:
  Classify early drawdown but do not reject.

REJECT_5:
  Reject when observed early drawdown reaches -5%.

REJECT_10:
  Reject when observed early drawdown reaches -10%.

REJECT_15:
  Reject when observed early drawdown reaches -15%.

REQUIRE_RECOVERY:
  Candidate may draw down early, but can still enter if it later recovers above a configured
  confirmation threshold within the recovery window.
```

CLI settings:

```text
--early-drawdown-mode=off|warn_only|reject_5|reject_10|reject_15|require_recovery
--recovery-confirmation-return-pcts=0,2,5
--recovery-window-minutes=3,5,10,15
```

The report should compare how many false positives each mode avoids and how many later winners each
mode misses.

## Entry Confirmation Rules

For each candidate:

```text
1. Find observed return at or after confirmation horizon.
2. If a target was hit before confirmation, mark MISSED_FAST_MOVE.
3. Apply the profile's earlyDrawdownMode.
4. If early drawdown is WARN_ONLY, classify WARN_EARLY_DRAWDOWN and continue.
5. If early drawdown is REQUIRE_RECOVERY, require recovery within recoveryWindowMinutes.
6. If recovery succeeds, classify RECOVERED_AFTER_DRAWDOWN or WOULD_ENTER_AFTER_RECOVERY.
7. If recovery fails, classify FAILED_RECOVERY_AFTER_DRAWDOWN or WOULD_SKIP_RECOVERY_TOO_LATE.
8. If confirmation return is below minConfirmationReturnPct, reject.
9. If confirmed, simulate target/stop/max-hold from the confirmation baseline.
```

First-pass confirmation matrix:

```text
horizon = 1m, 2m, 3m
minReturn = 0%, 2%, 5%
earlyDrawdownMode = OFF, WARN_ONLY, REJECT_5, REJECT_10, REJECT_15, REQUIRE_RECOVERY
recoveryWindow = 3m, 5m, 10m, 15m
recoveryConfirmationReturn = 0%, 2%, 5%
```

The report must make clear that endpoint observations are not executable tick data.

## Exit Simulation Defaults

Use the same target/stop/max-hold grid as Phase 8.91:

```text
targetPcts = 10,15,25
stopPcts = 10,15,25
maxHoldMinutes = 15,30,60
```

Primary comparison target:

```text
target = 10%
stop = 10%
maxHold = 15m
```

Reason:

```text
The desired strategy is fast, repeatable capture, not multi-day holding.
```

The report must show profile-to-exit pairing:

```text
For each profile, identify the best-performing target/stop/max-hold grid.
Do not report only the global best grid.
Different profiles may need different exit assumptions.
```

## Proposed Backend Module Structure

Add:

```text
backend/src/shadow-entry/
  ShadowEntryConfig.ts
  ShadowEntryTypes.ts
  ShadowEntryCandidateLoader.ts
  ShadowEntryProfile.ts
  ShadowEntryGateService.ts
  ShadowEntryConfirmationSimulator.ts
  ShadowEntryScenarioSimulator.ts
  ShadowEntryReportService.ts
  ShadowEntryReportFormatter.ts
  *.test.ts
```

Script:

```text
backend/src/scripts/shadow-entries.ts
```

Reuse:

```text
backend/src/shadow-calibration/ShadowRunLoader.ts
backend/src/calibration/ScoreAttributionService.ts
backend/src/calibration/ForwardReturnAnalyzer.ts
```

Do not duplicate archived DB loading logic unless the existing loader cannot support the needed
shape.

## Chunk 1: Config And CLI Surface

Implement:

- [ ] `ShadowEntryConfig.ts`.
- [ ] `parseShadowEntryArgs()`.
- [ ] `validateShadowEntryConfig()`.
- [ ] root `package.json -> shadow:entries`.
- [ ] backend `package.json -> shadow:entries`.
- [ ] `backend/src/scripts/shadow-entries.ts`.

Config options:

- [ ] `--once`
- [ ] `--json`
- [ ] `--label-db=<label>:<path>`
- [ ] `--db=<path>`
- [ ] `--session-id=<id>`
- [ ] `--profile=<name>`
- [ ] `--profiles=<comma-list>`
- [ ] `--source-decisions=BUY,WATCH,SKIP`
- [ ] `--min-score=50`
- [ ] `--score-buckets=55-59,65-69`
- [ ] `--entry-timing=decision|first_entry|latest_entry`
- [ ] `--confirmation-horizons=1,2,3`
- [ ] `--confirmation-min-return-pcts=0,2,5`
- [ ] `--early-drawdown-mode=off|warn_only|reject_5|reject_10|reject_15|require_recovery`
- [ ] `--recovery-confirmation-return-pcts=0,2,5`
- [ ] `--recovery-window-minutes=3,5,10,15`
- [ ] `--target-pcts=10,15,25`
- [ ] `--stop-pcts=10,15,25`
- [ ] `--max-hold-minutes=15,30,60`
- [ ] `--require-quote=true|false`
- [ ] `--include-duplicate-blocked=true|false`
- [ ] `--portfolio-starting-sol=1`
- [ ] `--portfolio-position-size-sol=0.01`
- [ ] `--portfolio-goal-pct=25`
- [ ] `--portfolio-max-positions=5`

Acceptance:

- [ ] Unknown options fail clearly.
- [ ] Invalid score buckets fail clearly.
- [ ] Invalid percentages fail clearly.
- [ ] Invalid early drawdown modes fail clearly.
- [ ] Recovery settings require compatible early drawdown mode when profile-specific validation
      demands it.
- [ ] Duplicate labels fail clearly.
- [ ] Active DB and archived DB inputs both work.
- [ ] Command prints wallet/signing/submission disabled status.

## Chunk 2: Candidate Loader

Implement:

- [ ] Load StrategyDecision rows from each source.
- [ ] Load WatchlistReturn observations by decision ID.
- [ ] Load score attribution from `inputSnapshotJson`.
- [ ] Detect missing snapshots.
- [ ] Detect missing quote.
- [ ] Detect duplicate-buy-blocked.
- [ ] Detect repeated decisions for the same mint within a session.
- [ ] Group candidates by run label, mint, decision type, and score bucket.
- [ ] Preserve decided-at ordering.

Acceptance:

- [ ] Test fixture can load BUY, WATCH, and SKIP decisions.
- [ ] Repeated mints are detected.
- [ ] Duplicate-buy-blocked is surfaced from score attribution.
- [ ] Missing quote is surfaced without becoming a default rejection.

## Chunk 3: Entry Profile Engine

Implement:

- [ ] `ShadowEntryProfile`.
- [ ] `buildDefaultEntryProfiles()`.
- [ ] Profile selection by name.
- [ ] Declarative profile composition from reusable dimensions.
- [ ] Decision type filters.
- [ ] Score bucket filters.
- [ ] Duplicate policy filters.
- [ ] Quote policy filters.
- [ ] Entry timing mode filters.

Acceptance:

- [ ] `P001 baseline_raw_buy` selects only BUY score >= 65.
- [ ] `P001 baseline_raw_buy` approximately reproduces final Phase 8.91 raw BUY metrics against the
      three archived Phase 8.91 datasets.
- [ ] `P002 score65_confirmed` selects score >= 65 across configured decisions.
- [ ] `P003 duplicate_attention` selects duplicate-blocked or repeated-attention rows.
- [ ] `P004 score55_research` selects score 55-59 WATCH/SKIP rows only.
- [ ] `P005 quote_control` splits quote-available and missing-quote cohorts without default
      rejection.
- [ ] `P006 recovery_after_drawdown` selects configured score/decision candidates and evaluates
      recovery windows.
- [ ] Hindsight best-entry mode is excluded from execution-style recommendations.

## Chunk 4: Confirmation Simulator

Implement:

- [ ] `ShadowEntryConfirmationSimulator`.
- [ ] Confirmation horizon lookup.
- [ ] Early target before confirmation -> `MISSED_FAST_MOVE`.
- [ ] Early drawdown mode `OFF`.
- [ ] Early drawdown mode `WARN_ONLY` -> `WARN_EARLY_DRAWDOWN`.
- [ ] Early drawdown modes `REJECT_5`, `REJECT_10`, `REJECT_15` -> `REJECT_EARLY_DRAWDOWN`.
- [ ] Early drawdown mode `REQUIRE_RECOVERY`.
- [ ] Recovery success -> `RECOVERED_AFTER_DRAWDOWN` and `WOULD_ENTER_AFTER_RECOVERY`.
- [ ] Recovery failure -> `FAILED_RECOVERY_AFTER_DRAWDOWN`.
- [ ] Recovery too late -> `WOULD_SKIP_RECOVERY_TOO_LATE`.
- [ ] Confirmation return below threshold -> `REJECT_CONFIRMATION_RETURN`.
- [ ] No data -> `INSUFFICIENT_CONFIRMATION_DATA`.
- [ ] Confirmed -> `WOULD_ENTER`.
- [ ] Rebased post-confirmation return series.

Acceptance:

- [ ] Candidate down `-10%` at 1m is rejected only under a compatible reject mode.
- [ ] Candidate down `-10%` at 1m is warned, not rejected, under `WARN_ONLY`.
- [ ] Candidate down early and recovered within the configured window can enter under
      `REQUIRE_RECOVERY`.
- [ ] Candidate down early and recovered after the configured window is classified as too late.
- [ ] Candidate up `+5%` at 1m can confirm.
- [ ] Candidate that hit target before confirmation is classified as missed fast move.
- [ ] Candidate with no confirmation data does not enter.
- [ ] Rebased returns are used for simulated post-confirmation exits.

## Chunk 5: Scenario And Portfolio Simulation

Implement:

- [ ] Target/stop/max-hold simulation for each entered candidate.
- [ ] Target/stop/max-hold simulation grouped by profile.
- [ ] Target-first count.
- [ ] Stop-first count.
- [ ] Max-hold count.
- [ ] No-observation count.
- [ ] Average exit return.
- [ ] Median exit return.
- [ ] Simulated SOL portfolio P/L.
- [ ] Max drawdown.
- [ ] Goal reached boolean.

Acceptance:

- [ ] Report never calls simulated P/L realized.
- [ ] Portfolio respects `portfolioMaxPositions`.
- [ ] Portfolio order uses entry timing timestamps.
- [ ] Each profile reports its best target/stop/max-hold pairing.
- [ ] A no-entry profile produces zero simulated trades without error.

## Chunk 6: Report Service

Create:

```text
ShadowEntryReportService
```

Report sections:

- [ ] Run inventory.
- [ ] Source data summary.
- [ ] Profile summary.
- [ ] Baseline reproduction summary.
- [ ] Improvement vs `P001 baseline_raw_buy`.
- [ ] Gate outcome counts.
- [ ] Candidate-level gate decisions.
- [ ] Target/stop/max-hold grid.
- [ ] Best target/stop/max-hold grid by profile.
- [ ] Portfolio simulation.
- [ ] False-positive avoided summary.
- [ ] Missed-fast-move summary.
- [ ] Recovery-after-drawdown summary.
- [ ] Filter breakdowns.
- [ ] Phase 9 readiness status by profile.
- [ ] Recommendation section.
- [ ] Next test plan.

JSON report shape:

```ts
interface ShadowEntryReport {
  generatedAtMs: number;
  config: ShadowEntryRuntimeConfig;
  runs: ShadowEntryRunSummary[];
  profiles: ShadowEntryProfileSummary[];
  baselineReproduction: ShadowEntryBaselineReproductionSummary;
  improvementVsBaseline: ShadowEntryProfileImprovementSummary[];
  candidates: ShadowEntryCandidateDecision[];
  scenarioGrid: ShadowEntryScenarioSummary[];
  bestExitByProfile: ShadowEntryProfileExitPairingSummary[];
  portfolioSummaries: ShadowEntryPortfolioSummary[];
  readinessByProfile: ShadowEntryReadinessSummary[];
  recommendations: ShadowEntryRecommendation[];
  nextTestPlan: string[];
}
```

Acceptance:

- [ ] Text output is readable in PowerShell.
- [ ] JSON output can support future dashboard work.
- [ ] Baseline reproduction failure is visible and treated as an implementation problem.
- [ ] Every profile compares observed entries, +10% target-first rate, stop-first rate, avgBest,
      avgWorst, median exit return, simulated portfolio P/L, max drawdown, missed fast movers, and
      false positives avoided against `P001 baseline_raw_buy`.
- [ ] Every recommendation includes evidence.
- [ ] Report explicitly says paper execution remains disabled.

## Chunk 7: Recommendation Rules

Do not auto-apply recommendations.

Recommendation categories:

- [ ] keep Phase 9 shadow-only.
- [ ] test profile in another 3-run batch.
- [ ] reject profile due to drawdown-first dominance.
- [ ] mark profile as ready for paper-entry review later.
- [ ] ignore quote requirement for now.
- [ ] keep missing quote visible as confidence evidence.
- [ ] test duplicate-attention workflow.
- [ ] test latest-entry timing.
- [ ] test recovery-after-drawdown workflow.
- [ ] require more data due to sample size.

Phase 9 readiness statuses:

```text
NOT_READY
PROMISING
CANDIDATE_FOR_PROMOTION
```

Status meanings:

```text
NOT_READY:
  Profile does not beat the baseline or has too little evidence.

PROMISING:
  Profile improves at least one important baseline metric but needs more validation.

CANDIDATE_FOR_PROMOTION:
  Profile satisfies the promotion bar and deserves future Phase 8.93 Strategy Promotion review.
  This does not enable paper BUY.
```

Minimum `CANDIDATE_FOR_PROMOTION` bar:

```text
observed entries >= 20 across validation batch
+10% target-first rate meaningfully exceeds stop-first rate
avgWorst materially better than raw BUY baseline
simulated portfolio P/L positive in at least 2 of 3 runs
no single mint dominates the result
```

If these are not met:

```text
Phase 9 remains shadow-only.
```

Promotion boundary:

```text
Phase 8.92 can recommend a profile for review.
Phase 8.92 must not promote the profile into strategy logic, scoring defaults, TerminalRunner
defaults, or paper execution.
```

If a later promotion phase is needed:

```text
Phase 8.93 Strategy Promotion
```

Phase 8.93 would promote a validated Phase 8.92 profile into strategy logic for another validation
batch. Do not put promotion into Phase 8.92.

## Chunk 8: Tests

Add tests under:

```text
backend/src/shadow-entry/*.test.ts
```

Config tests:

- [ ] parses profile names.
- [ ] parses profile IDs.
- [ ] parses source decisions.
- [ ] parses score buckets.
- [ ] parses confirmation grids.
- [ ] parses early drawdown modes.
- [ ] parses recovery confirmation settings.
- [ ] rejects bad score buckets.
- [ ] rejects bad percentages.
- [ ] rejects bad early drawdown modes.
- [ ] rejects unknown profile names.

Candidate tests:

- [ ] detects duplicate-buy-blocked.
- [ ] detects repeated mint decisions.
- [ ] groups by decision type.
- [ ] groups by score bucket.
- [ ] handles missing snapshots.

Profile tests:

- [ ] P001 baseline raw BUY selection.
- [ ] P001 baseline reproduction against a fixture matching Phase 8.91 raw BUY behavior.
- [ ] P002 score65 confirmed selection.
- [ ] P003 duplicate attention selection.
- [ ] P004 score55 research selection.
- [ ] P005 quote-control split.
- [ ] P006 recovery-after-drawdown selection.

Confirmation tests:

- [ ] early drawdown off.
- [ ] early drawdown warning.
- [ ] early drawdown rejection.
- [ ] recovery-after-drawdown success.
- [ ] recovery-after-drawdown failure.
- [ ] recovery too late.
- [ ] confirmation return rejection.
- [ ] confirmed entry.
- [ ] missed fast move.
- [ ] insufficient confirmation data.

Report tests:

- [ ] improvement versus baseline.
- [ ] best target/stop/max-hold grid by profile.
- [ ] Phase 9 readiness status.
- [ ] `CANDIDATE_FOR_PROMOTION` text does not imply paper BUY enablement.
- [ ] `mint_best_entry` is labeled hindsight-only.

Safety tests:

- [ ] no orders created.
- [ ] no fills created.
- [ ] no positions created.
- [ ] no TokenRadar updates.
- [ ] no StrategyDecision writes.
- [ ] no RiskAssessment writes.
- [ ] no session cash/status changes.

## Chunk 9: Documentation Updates

Update:

- [ ] `docs/ROADMAP.md`
- [ ] `docs/Structure.md`
- [ ] `docs/DECISIONS.md`
- [ ] `docs/NeXusTrade-Phase-8.91-Detailed-Checklist.md`
- [ ] `docs/Phase-9-Planning-Inputs.md`

Add:

- [ ] command examples,
- [ ] safety boundary,
- [ ] Phase 8.91 evidence,
- [ ] Phase 8.92 test plan,
- [ ] Phase 9 gating status.

## Phase 8.92 Validation Plan

First validation step:

```powershell
corepack pnpm shadow:entries --once `
  --label-db=Test1:data/archive/phase8.91/test1-phase8.91-test1-20260703-2155 `
  --label-db=Test2:data/archive/phase8.91/test2-phase8.91-test2-20260704-1324 `
  --label-db=Test3:data/archive/phase8.91/test3-phase8.91-test3-20260706-1405
```

Acceptance:

```text
P001 baseline_raw_buy approximately reproduces the final Phase 8.91 raw BUY metrics.
If it does not, fix the implementation before running new validation tests.
```

After implementation, run three fresh tests using the Phase 8.91 runbook with one addition:

```powershell
corepack pnpm shadow:entries --once | Tee-Object "data\$run-shadow-entries.txt"
```

Suggested placement:

```text
after shadow:exits
before shadow:calibrate
```

Final comparison:

```powershell
corepack pnpm shadow:entries --once `
  --label-db=Test1:data/archive/phase8.92/<test1-folder> `
  --label-db=Test2:data/archive/phase8.92/<test2-folder> `
  --label-db=Test3:data/archive/phase8.92/<test3-folder> `
  | Tee-Object "data\phase8.92-cross-run-entry-final.txt"
```

Compare against:

```text
data/phase8.91-cross-run-final.txt
```

## Known Limitations

- Endpoint observations are not tick data.
- Confirmation can miss fast wicks.
- DexScreener prices are not guaranteed executable route prices.
- Jupiter rate limiting remains elevated.
- Missing quote is not currently a reliable rejection signal.
- Three-run samples are still small.
- Duplicate-attention signals can be dominated by one mint.
- Hindsight best-entry analysis must not be treated as executable.
- Simulated portfolio P/L excludes route failures, slippage surprises, partial fills, and MEV.

## Recommended Implementation Order

Small chunks:

```text
1. config and command surface
2. candidate loader
3. profile definitions
4. confirmation simulator
5. scenario simulator
6. report service and formatter
7. tests
8. docs
9. run archived Phase 8.91 comparison
10. define Phase 8.92 three-run validation runbook
```

## Definition Of Done

Phase 8.92 is complete when:

- [x] `pnpm shadow:entries --once` exists.
- [x] Active paper DB analysis works.
- [x] Archived paper DB analysis works.
- [x] `P001 baseline_raw_buy` is reported and treated as immutable.
- [x] `P001 baseline_raw_buy` approximately reproduces final Phase 8.91 raw BUY metrics against the
      three archived Phase 8.91 validation datasets.
- [x] `P002 score65_confirmed` is reported.
- [x] `P003 duplicate_attention` is reported.
- [x] `P004 score55_research` is reported.
- [x] `P005 quote_control` is reported.
- [x] `P006 recovery_after_drawdown` is reported.
- [x] Entry confirmation outcomes are explicit.
- [x] Early drawdown modes are configurable and tested.
- [x] Recovery-after-drawdown behavior is configurable and tested.
- [x] Decision, first-entry, and latest-entry timing are compared.
- [x] `mint_best_entry`, if present, is hindsight-only and excluded from execution-style
      recommendations.
- [x] Target/stop/max-hold grids are reported by profile.
- [x] Best target/stop/max-hold pairing is reported for each profile.
- [x] Improvement versus `P001 baseline_raw_buy` is reported for every profile.
- [x] Phase 9 readiness statuses are reported and do not enable paper execution.
- [x] Simulated portfolio outcomes are reported by profile.
- [x] No trading-state writes occur.
- [x] No scoring weights, thresholds, strategy defaults, TerminalRunner defaults, or `paper:execute`
      behavior are changed.
- [x] Recommendations preserve paper execution disabled even when a profile is
      `CANDIDATE_FOR_PROMOTION`.
- [x] `pnpm verify` passes.
- [x] Docs and Phase 9 handoff are updated.
