# NeXusTrade Phase 8.92B Detailed Checklist

Fresh Shadow Entry-Gate Refinement And Promotion-Readiness Cleanup

Last updated: July 2026

Status: Implemented and validated.

Mode: `PAPER` research and simulation only.

## Post-Implementation Validation

Fresh Phase 8.92B validation ran across three archived market windows:

```text
data/archive/phase8.92B/test1-phase8.92B-test1-20260708-1141
data/archive/phase8.92B/test2-phase8.92B-test2-20260708-1949
data/archive/phase8.92B/test3-phase8.92B-test3-20260709-0908
```

The validation confirmed:

```text
observed decisions = 50
orders = 0
fills = 0
positions = 0
CANDIDATE_FOR_PROMOTION = 0
```

Phase 8.93 completed as an explicit no-promotion review. No profile was promoted, and Phase 9
remains shadow-first.

Implementation notes:

- Implemented versioned profiles `P001@v1` through `P011@v1`.
- Added P007-P011 research profiles for WATCH-first, repeated-attention, score 65-79,
  high-score, and WATCH duplicate-hybrid experiments.
- Added normalized profile summaries where `considered` means unique strategy decision
  evaluated, while preserving expanded rows as experimental diagnostics.
- Scoped Phase 8.91 P001 reproduction checks to archived Phase 8.91 sources.
- Added repeated-attention strength, reasons, source count, and strategy-decision timing
  metadata.
- Added readiness confidence, signal stability, and market-window win concentration.
- Scanner rediscovery gap/window logic and provider-health rollups remain future
  extensions because the current shadow-entry source model does not store raw scanner
  rediscovery events as independent attention signals.

## Executive Summary

Phase 8.92B exists because the first fresh Phase 8.92 validation batch found real signal, but not a
promotion-ready entry profile.

The four fresh Phase 8.92 tests were mechanically clean:

```text
data/archive/phase8.92/test1-phase8.92-test1-20260707-1017
data/archive/phase8.92/test2-phase8.92-test2-20260707-1418
data/archive/phase8.92/test3-phase8.92-test3-20260707-1816
data/archive/phase8.92/test4-phase8.92-test4-20260707-2148
```

Combined cross-run result:

```text
runs = 4
observed decisions = 68
unique mints = 25
orders = 0
fills = 0
positions = 0
scanner runtime = about 131-143 minutes per run
```

Key fresh-run evidence:

```text
BUY:
  count = 10
  unique mints = 10
  +10% hit = 60.00%
  +25% hit = 50.00%
  avgBest = +70.81%
  avgWorst = -46.98%
  -10% drawdown first = 50.00%

WATCH:
  count = 18
  unique mints = 4
  +10% hit = 72.22%
  +25% hit = 38.89%
  avgBest = +27.90%
  avgWorst = -16.71%
  -10% drawdown first = 44.44%

duplicate_blocked:
  count = 10
  +10% hit = 90.00%
  avgBest = +31.91%
  avgWorst = -7.96%
  -10% drawdown first = 40.00%

score 65-69:
  count = 14
  +10% hit = 78.57%
  +15% hit = 64.29%
  +25% hit = 42.86%
  avgBest = +59.78%
  avgWorst = -32.38%
```

The evidence says:

```text
There is signal.
Raw BUY is not safe enough.
WATCH and duplicate-attention behavior deserve deeper testing.
Score 65-69 looks better than lower score buckets.
Missing quote should remain visible evidence, not a hard rejection gate.
No profile is ready for paper BUY promotion yet.
```

## Phase 8.92B Goal

Phase 8.92B should refine the `shadow:entries` workbench so that Phase 9 planning can rely on its
reports without manual interpretation.

It should:

- fix misleading fresh-run baseline reproduction wording,
- separate decision-level profile summaries from experimental diagnostics,
- add focused research profiles based on fresh Phase 8.92 evidence,
- promote repeated attention into a first-class research signal,
- add signal stability and confidence labels,
- improve profile readiness criteria and report language,
- add profile versioning so archived reports can be compared without ambiguity,
- rerun archived Phase 8.92 reports against the refined profile set,
- produce a new validation runbook for the next fresh batch.

It must not:

- enable `paper:execute`,
- create orders, fills, positions, or cash mutations,
- update TokenRadar, StrategyDecision, RiskAssessment, Session, or snapshot rows,
- loosen live-trading safeguards,
- change default strategy scoring or production thresholds,
- treat `CANDIDATE_FOR_PROMOTION` as execution permission.

## Locked Decisions

- Phase 8.92B remains paper-only and read-only.
- Phase 9 remains shadow-first by default.
- P001 remains immutable as the raw BUY comparison profile.
- Profile IDs remain stable, but profile behavior changes must create a new profile version.
- Never silently change an existing profile version.
- Fresh Phase 8.92 datasets should not be expected to reproduce Phase 8.91 P001 metrics.
- Missing Jupiter quote remains a reportable evidence bucket, not a hard rejection gate.
- Repeated attention remains a research signal, not automatic BUY permission.
- Any promotion-worthy profile must go through a separate Phase 8.93 promotion checklist.

## Known Issues From Phase 8.92

### Fresh Baseline Wording

The Phase 8.92 report currently says:

```text
P001 does not reproduce final Phase 8.91 raw BUY metrics; implementation or source data needs review.
```

when run against fresh Phase 8.92 datasets. That is misleading.

Expected Phase 8.92B behavior:

```text
P001 baseline reproduction = not applicable for fresh validation datasets.
Use P001 as the within-batch comparison baseline.
```

P001 reproduction should only be required when the input sources are the archived Phase 8.91
baseline datasets or when the user explicitly requests a Phase 8.91 baseline check.

### Experimental Diagnostic Counts

Some profile summaries currently inflate `considered` and `entered` counts because they aggregate
across profile dimension combinations. This is useful for experimentation internals, but confusing
as the primary report.

Expected Phase 8.92B behavior:

```text
considered:
  unique decision evaluated
  not scenario count
  not profile dimension expansion count

Normalized profile summary:
  one row per profile/timing/source decision grouping
  decision-level count
  unique mint count
  target-first rate
  stop-first rate
  avgBest
  avgWorst
  median exit

Experimental diagnostics:
  keep expanded grid counts
  label clearly as experimental diagnostics
```

### Promotion Criteria Are Too Coarse

Every fresh Phase 8.92 profile remained `NOT_READY`, which is correct. Phase 8.92B should make the
reasons more explicit and auditable.

Readiness output should include:

```text
sample size result
unique mint result
target-first result
stop-first result
avgWorst result
portfolio return result
drawdown result
cross-run consistency result
signal stability result
confidence result
mint concentration result
market-window concentration result
```

## Repeated Attention Signal

Phase 8.92B should promote repeated attention from a loose duplicate-related bucket into a
first-class research feature.

A candidate may be considered repeated attention when one or more of these occur:

```text
duplicate BUY prevention
repeated StrategyDecision for the same mint
repeated WATCH decisions for the same mint
repeated scanner rediscovery
repeated appearance after a configurable time gap
```

Repeated scanner rediscovery can be noisy, so it should require a configurable gap/window before it
counts as meaningful repeated attention.

Suggested strength enum:

```text
RepeatedAttentionStrength:
  NONE
  LOW
  MEDIUM
  HIGH
```

Suggested strength interpretation:

```text
NONE:
  no repeated signal found

LOW:
  repeated scanner/radar visibility only

MEDIUM:
  repeated StrategyDecision or repeated WATCH attention

HIGH:
  duplicate BUY prevention or multiple independent repeated-attention signals
```

Report output should include:

```text
repeatedAttentionStrength
repeatedAttentionReasons
repeatedAttentionSourceCount
firstSeenAt
lastSeenAt
timeBetweenSignalsMinutes
```

This is still research evidence only. It does not permit paper BUY.

## Signal Stability

Phase 8.92B should add signal stability to readiness output.

The main unit of stability should be profile/run behavior, not just mint behavior, because the same
mint often will not appear across multiple independent test windows.

Suggested enum:

```text
SignalStability:
  LOW
  MEDIUM
  HIGH
```

Suggested calculation inputs:

```text
cross-run target-first consistency
cross-run stop-first consistency
cross-run avgWorst consistency
cross-run simulated portfolio consistency
market-window win concentration
```

Purpose:

```text
Prefer profiles that perform decently across multiple market windows over profiles that look good
only because one run was unusually favorable.
```

## Proposed Profile Additions

Profiles remain presets composed from independent dimensions. Future profiles should be created by
composing dimensions rather than hard-coding one-off strategy paths.

Profile versions are required for auditability:

```text
profileId = P009
profileVersion = v1
profileKey = P009@v1
displayName = P009 v1 score65_79_confirmed
```

If profile behavior changes later, create a new version:

```text
P009 v1 = original score65_79_confirmed behavior
P009 v2 = tuned score65_79_confirmed behavior
```

Do not silently change what `P009 v1` means after archived reports exist.

Keep existing profiles:

```text
P001 v1 baseline_raw_buy
P002 v1 score65_confirmed
P003 v1 duplicate_attention
P004 v1 score55_research
P005 v1 quote_control
P006 v1 recovery_after_drawdown
```

Add focused Phase 8.92B research profiles:

```text
P007 v1 watch_first_confirmed
P008 v1 duplicate_attention_confirmed
P009 v1 score65_79_confirmed
P010 v1 high_score75_research
P011 v1 watch_duplicate_hybrid
```

### P007 watch_first_confirmed

Purpose:

```text
Measure whether WATCH candidates are better entry candidates than raw BUY after short confirmation.
```

Suggested preset:

```text
source decisions = WATCH
score >= 60
entry timing = first_entry and latest_entry
confirmation horizons = 1,2,3 minutes
confirmation min return = 0,2,5%
early drawdown mode = warn_only and reject_10
target/stop grid = 10/10, 15/10, 15/15, 25/10
max hold = 15,30,60 minutes
```

Why:

```text
Fresh Phase 8.92 WATCH had +10% hit = 72.22% and avgWorst = -16.71%.
Sample was only 18 decisions / 4 unique mints, so it is promising but not promotable.
```

### P008 duplicate_attention_confirmed

Purpose:

```text
Measure repeated attention as positive momentum evidence.
```

Suggested preset:

```text
duplicate/repeated-attention signal required
source decisions = BUY,WATCH,SKIP
score >= 55
entry timing = latest_entry first, first_entry secondary
confirmation horizons = 1,2,3 minutes
confirmation min return = 0,2%
early drawdown mode = warn_only and reject_10
target/stop grid = 10/10, 15/10, 15/15
max hold = 15,30,60 minutes
```

Why:

```text
Fresh Phase 8.92 duplicate_blocked had +10% hit = 90.00% and avgWorst = -7.96%.
```

### P009 score65_79_confirmed

Purpose:

```text
Test whether the useful signal lives in the 65-79 score range rather than raw BUY labels.
```

Suggested preset:

```text
source decisions = BUY,WATCH
score >= 65 and score <= 79
entry timing = decision, first_entry, latest_entry
confirmation horizons = 1,2,3 minutes
confirmation min return = 0,2,5%
early drawdown mode = warn_only, reject_10, require_recovery
target/stop grid = 10/10, 15/10, 15/15, 25/10
max hold = 15,30,60 minutes
```

Why:

```text
Fresh Phase 8.92 score 65-69 had +10% hit = 78.57% and avgBest = +59.78%.
```

### P010 high_score75_research

Purpose:

```text
Track high-score candidates without over-trusting a tiny sample.
```

Suggested preset:

```text
source decisions = BUY,WATCH
score >= 75
entry timing = decision and first_entry
confirmation horizons = 1,2,3 minutes
confirmation min return = 0,2%
early drawdown mode = warn_only
target/stop grid = 10/10, 15/10, 15/15, 25/10
max hold = 15,30,60 minutes
```

Why:

```text
Fresh Phase 8.92 score 75-79 had avgWorst = -4.98%, but only 4 candidates.
```

### P011 watch_duplicate_hybrid

Purpose:

```text
Measure candidates that are both watched and repeatedly surfaced.
```

Suggested preset:

```text
source decisions = WATCH
duplicate/repeated-attention signal preferred
score >= 60
entry timing = latest_entry
confirmation horizons = 1,2,3 minutes
confirmation min return = 0,2%
early drawdown mode = warn_only
target/stop grid = 10/10, 15/10, 15/15
max hold = 15,30,60 minutes
```

Why:

```text
Fresh data suggests WATCH and duplicate-attention are both stronger than raw BUY, but each sample is
small. The hybrid profile tests whether the combined signal is stronger or too sparse.
```

## Suggested Promotion Criteria

Phase 8.92B should keep `CANDIDATE_FOR_PROMOTION` strict.

Minimum report-level bar:

```text
run count >= 3
unique mints >= 10
entered decisions >= 20
target-first rate >= 60%
stop-first rate <= 30%
avgWorst >= -20%
best scenario simulated P/L > P001 by at least 0.25 percentage points
max simulated drawdown <= 0.25%
no single mint contributes more than 35% of wins
no single market window contributes more than 40% of observed wins
signal stability != LOW
confidence != LOW
no orders/fills/positions present
```

Suggested labels:

```text
NOT_READY
PROMISING_RESEARCH
CANDIDATE_FOR_PROMOTION
```

Confidence should be reported separately from readiness:

```text
confidence:
  LOW
  MEDIUM
  HIGH
```

Confidence should be based on:

```text
sample size
unique mint count
cross-run consistency
signal stability
market-window concentration
```

`PROMISING_RESEARCH` means:

```text
The profile deserves another fresh validation batch.
It does not allow paper BUY.
```

Example:

```text
PROMISING_RESEARCH, confidence LOW:
  interesting signal, but the sample or cross-run stability is not strong enough yet

PROMISING_RESEARCH, confidence HIGH:
  strong enough to plan a promotion review, but still not execution permission
```

`CANDIDATE_FOR_PROMOTION` means:

```text
The profile can be reviewed in Phase 8.93.
It still does not enable paper BUY automatically.
```

## Implementation Chunks

### Chunk 1: Baseline Reproduction Semantics

- [ ] Add a baseline mode to the report service:
  - `phase8_91_reproduction`
  - `fresh_batch_comparison`
  - `auto`
- [ ] Default to `auto`.
- [ ] Detect archived Phase 8.91 reproduction sources when labels/paths match Phase 8.91 archives.
- [ ] For fresh Phase 8.92 sources, report:

```text
P001 reproduction: not applicable
P001 comparison baseline: active
```

- [ ] Update text formatter.
- [ ] Update JSON output.
- [ ] Add tests for Phase 8.91 archive reproduction.
- [ ] Add tests for fresh-run non-applicable baseline wording.

### Chunk 2: Normalized Profile Summary

- [ ] Define `considered` explicitly:

```text
considered = unique decision evaluated
considered != scenario count
considered != profile dimension expansion count
```

- [ ] Add normalized profile summary DTOs.
- [ ] Group profile outcomes by:
  - profile id,
  - profile name,
  - timing mode,
  - source decision group,
  - decision id.
- [ ] Count one decision once per normalized profile row.
- [ ] Include unique mint count.
- [ ] Include target-first rate.
- [ ] Include stop-first rate.
- [ ] Include average and median best/worst returns.
- [ ] Include median exit return.
- [ ] Include missed-fast-move count.
- [ ] Include false-positive avoided count.
- [ ] Keep existing expanded summaries but label them as experimental diagnostics.
- [ ] Update text report ordering so normalized summary appears before experimental diagnostics.
- [ ] Add tests proving counts are not scenario-multiplied.

### Chunk 3: Additional Profiles

- [ ] Add `P007 watch_first_confirmed`.
- [ ] Add `P008 duplicate_attention_confirmed`.
- [ ] Add `P009 score65_79_confirmed`.
- [ ] Add `P010 high_score75_research`.
- [ ] Add `P011 watch_duplicate_hybrid`.
- [ ] Keep profile IDs stable.
- [ ] Add `profileVersion`.
- [ ] Add `profileKey`.
- [ ] Default all existing profiles to `v1`.
- [ ] Display profiles as `<profileId> <profileVersion> <profileName>`.
- [ ] Make profile versions immutable once archived reports exist.
- [ ] Require a new version when a profile's behavior changes.
- [ ] Keep P001 immutable.
- [ ] Document each profile as a composition of dimensions.
- [ ] Add tests for each new profile selector.
- [ ] Add tests for profile ID parsing with P007-P011.
- [ ] Add tests for profile version output.

### Chunk 4: Repeated-Attention Signal Extraction

- [ ] Promote repeated attention into a first-class DTO/feature.
- [ ] Add `RepeatedAttentionStrength`:
  - `NONE`,
  - `LOW`,
  - `MEDIUM`,
  - `HIGH`.
- [ ] Audit where repeated-attention evidence currently lives:
  - StrategyDecision reason/notes,
  - input snapshot JSON,
  - duplicate BUY protection result,
  - repeated decisions for the same mint within a run,
  - repeated WATCH decisions for the same mint,
  - repeated scanner rediscovery,
  - repeated appearance after a configurable time gap.
- [ ] Define a single helper:

```text
getRepeatedAttentionSignal(candidate, runCandidates, options)
```

- [ ] Return `strength`, `reasons`, `sourceCount`, and timing metadata.
- [ ] Include `repeatedAttentionReasons`.
- [ ] Add configurable rediscovery gap/window options.
- [ ] Add report buckets:
  - `high_repeated_attention`,
  - `medium_repeated_attention`,
  - `low_repeated_attention`,
  - `duplicate_blocked`,
  - `repeated_decision`,
  - `repeated_watch`,
  - `repeated_scanner_rediscovery`,
  - `not_repeated`.
- [ ] Add tests for all repeated-attention paths.

### Chunk 5: Readiness And Recommendation Output

- [ ] Add `PROMISING_RESEARCH`.
- [ ] Keep `CANDIDATE_FOR_PROMOTION`.
- [ ] Add confidence:
  - `LOW`,
  - `MEDIUM`,
  - `HIGH`.
- [ ] Add signal stability:
  - `LOW`,
  - `MEDIUM`,
  - `HIGH`.
- [ ] Add per-criterion readiness detail.
- [ ] Add concentration check by mint.
- [ ] Add concentration check by market window/run.
- [ ] Require no single market window to contribute more than 40% of observed wins for
      `CANDIDATE_FOR_PROMOTION`.
- [ ] Add cross-run consistency check.
- [ ] Make recommendation wording explicit:

```text
No paper execution is enabled by this report.
```

- [ ] Update JSON output so future dashboards can consume readiness details.
- [ ] Add tests for `NOT_READY`, `PROMISING_RESEARCH`, and `CANDIDATE_FOR_PROMOTION`.
- [ ] Add tests for confidence labels.
- [ ] Add tests for signal stability labels.

### Chunk 6: Scenario And Portfolio Report Cleanup

- [ ] Show top scenarios by:
  - simulated P/L,
  - target-first rate,
  - lowest stop-first rate,
  - lowest max drawdown.
- [ ] Always show P001 comparison next to candidate profiles.
- [ ] Include portfolio assumptions:
  - starting SOL,
  - position size,
  - max positions,
  - target/stop/max-hold grid.
- [ ] Keep simulated P/L labeled as simulated, not realized.
- [ ] Add tests for portfolio comparison output.

### Chunk 7: Provider And Quote Evidence

- [ ] Keep quote availability as a bucket.
- [ ] Add Jupiter rate-limit summary when source runs include provider health.
- [ ] Confirm missing quote does not trigger hard rejection by default.
- [ ] Add tests for quote-control profile behavior.
- [ ] Add recommendation text:

```text
Quote availability should not become a hard quality gate until provider reliability improves.
```

### Chunk 8: Command And Docs

- [ ] Keep command:

```powershell
corepack pnpm shadow:entries --once
```

- [ ] Add optional flags if useful:
  - `--baseline-mode=auto|phase8_91_reproduction|fresh_batch_comparison`
  - `--readiness-min-unique-mints=10`
  - `--readiness-min-entered=20`
  - `--readiness-max-mint-win-concentration-pct=35`
- [ ] Update `docs/ROADMAP.md`.
- [ ] Update `docs/DECISIONS.md`.
- [ ] Update `docs/Structure.md`.
- [ ] Update `docs/Phase-9-Planning-Inputs.md`.
- [ ] Add Phase 8.92B completion notes after implementation.

### Chunk 9: Tests

- [ ] Config parsing tests.
- [ ] Baseline mode tests.
- [ ] New profile selector tests.
- [ ] Repeated-attention helper tests.
- [ ] Normalized summary count tests, including the explicit `considered = unique decision`
      definition.
- [ ] Readiness status tests.
- [ ] Readiness confidence tests.
- [ ] Signal stability tests.
- [ ] Market-window concentration tests.
- [ ] Report formatter tests.
- [ ] JSON shape tests.
- [ ] Safety tests proving no orders/fills/positions/session mutations.
- [ ] Archive smoke command against four Phase 8.92 datasets.

## Validation Commands

After implementation:

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm verify
```

Archived Phase 8.92 replay:

```powershell
corepack pnpm shadow:entries --once `
  --label-db=Test1:data/archive/phase8.92/test1-phase8.92-test1-20260707-1017 `
  --label-db=Test2:data/archive/phase8.92/test2-phase8.92-test2-20260707-1418 `
  --label-db=Test3:data/archive/phase8.92/test3-phase8.92-test3-20260707-1816 `
  --label-db=Test4:data/archive/phase8.92/test4-phase8.92-test4-20260707-2148
```

Expected after Phase 8.92B:

```text
P001 reproduction = not applicable for fresh Phase 8.92 datasets
P001 comparison baseline = active
orders = 0
fills = 0
positions = 0
new profiles P007-P011 appear
profiles include profileVersion and profileKey
existing profiles are reported as v1
normalized summaries are not experimental-diagnostic inflated
readiness output explains exactly why each profile is NOT_READY, PROMISING_RESEARCH, or CANDIDATE_FOR_PROMOTION
readiness output includes confidence
readiness output includes signal stability
readiness output includes market-window concentration
```

## Fresh Validation Batch After Implementation

Run another 3 fresh tests only after archived replay output looks clean.

Recommended batch:

```text
Test A: morning
Test B: midday/afternoon
Test C: evening
```

Each run should keep the Phase 8.92 process:

```text
scanner 90-120 minutes
risk + strategy every 10-12 minutes
shadow observe every 1-3 minutes
60-minute observation tail
shadow exits
shadow calibrate
shadow entries
analytics
calibration
archive DB + transcripts
```

Use the same conservative thresholds for comparability:

```powershell
corepack pnpm strategy:evaluate --once --buy-score-threshold=65 --watch-score-threshold=60
corepack pnpm shadow:observe --once --include-shadow-scores --shadow-score-min=50
```

## Definition Of Done

Phase 8.92B is complete when:

- [ ] Fresh-run baseline wording is fixed.
- [ ] P001 Phase 8.91 reproduction still passes against Phase 8.91 archives.
- [ ] Fresh Phase 8.92 archives report P001 as comparison baseline, not failed reproduction.
- [ ] Normalized profile summaries are added.
- [ ] `considered` means unique decision evaluated, not scenario count.
- [ ] Experimental diagnostics remain available and clearly labeled.
- [ ] P007-P011 profiles are implemented and tested.
- [ ] Every profile report includes `profileId`, `profileVersion`, and `profileKey`.
- [ ] Existing profiles are marked `v1`.
- [ ] Profile behavior changes require a new version.
- [ ] Repeated-attention extraction is first-class, strength-based, and tested.
- [ ] Repeated scanner rediscovery requires a configurable time gap/window.
- [ ] Readiness criteria include per-criterion details.
- [ ] Signal stability is reported and tested.
- [ ] Confidence is reported separately from readiness and tested.
- [ ] Market-window concentration is reported and tested.
- [ ] `CANDIDATE_FOR_PROMOTION` requires no single market window to contribute more than 40% of
      observed wins.
- [ ] `PROMISING_RESEARCH` is available and cannot trigger execution.
- [ ] `CANDIDATE_FOR_PROMOTION` remains review-only.
- [ ] Archived four-run Phase 8.92 replay passes.
- [ ] No trading-state writes occur.
- [ ] `pnpm verify` passes.
- [ ] Roadmap, decisions, structure, and Phase 9 planning inputs are updated.

## Phase 9 Impact

Phase 9 should not start paper BUY orchestration after Phase 8.92B by default.

Phase 9 should use Phase 8.92B output as a shadow readiness gate:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow exits
-> shadow calibrate
-> shadow entries
-> cycle summary
```

Paper BUY remains disabled. Phase 8.93 promoted no profile, so a future explicit promotion review
would be required before TerminalRunner can include paper BUY orchestration.

## Phase 8.93 Handoff

Phase 8.93 was the first phase allowed to consider promoting a research profile into the real paper
strategy defaults.

The promotion bar was:

```text
status = CANDIDATE_FOR_PROMOTION
confidence = MEDIUM or HIGH
signal stability = MEDIUM or HIGH
```

Phase 8.93 found no profile that met that bar. Phase 9 should orchestrate the shadow research loop,
not paper BUY execution.
