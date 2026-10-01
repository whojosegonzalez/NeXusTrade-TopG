# NeXusTrade Phase 9.1 Detailed Checklist

Cross-Run Research Aggregation + Promotion Gate

Last updated: July 2026

Status: Implemented.

Mode: `PAPER` research, read-only aggregation, no paper BUY automation.

## Purpose

Phase 9.1 turns multiple Phase 9 TerminalRunner validation archives into one comparable research
report.

The goal is to answer:

```text
Do the Phase 9 shadow runs contain enough repeatable evidence to design a controlled paper pilot?
```

The goal is not to enable paper trading yet.

Phase 9.1 should aggregate:

```text
TerminalRunner archives
-> runner JSON summaries
-> archived paper DB rows
-> analytics tail reports
-> calibration tail reports
-> shadow calibration tail reports
-> provider pressure
-> promotion/readiness labels
```

## Current Evidence Snapshot

The first valid three-run Phase 9 batch produced:

```text
Test 1: 55 cycles, safety PASS, one session, 601 scanner stored, 221 strategy rows
Test 2: 54 cycles, safety PASS, one session, 591 scanner stored, 185 strategy rows
Test 3: 56 cycles, safety PASS, one session, 629 scanner stored, 181 strategy rows
```

Provider pressure was stable and materially high:

```text
Jupiter RATE_LIMITED:
Test 1: 52.89%
Test 2: 52.06%
Test 3: 53.09%
```

The `BUY>=65 / WATCH>=60` research threshold showed upside, but not promotion-level reliability:

```text
Observed BUY65 decisions: 85
Weighted avg best return: +51.29%
Weighted avg worst return: -36.28%
Weighted +10% hit rate: 62.36%
Weighted +25% hit rate: 43.53%
```

The main limitations:

```text
unique observed mints per run remained small
target-before-stop behavior was inconsistent
scenario portfolio results were not robust
quote availability materially changed outcomes
Jupiter remained a persistent bottleneck
```

## Non-Goals

Phase 9.1 must not:

- enable `paper:execute` inside TerminalRunner,
- enable paper BUY automation,
- change default strategy thresholds,
- change risk rules,
- change scoring weights,
- add new external provider adapters,
- add wallet loading,
- sign transactions,
- submit transactions,
- treat shadow P/L as realized P/L,
- add dashboard UI.

## Inputs

Required Phase 9 archive inputs:

```text
data/archive/phase9/test1-phase9-test1-20260709-2344
data/archive/phase9/test2-phase9-test2-20260710-0919
data/archive/phase9/test3-phase9-test3-20260710-1729
```

Each archive should include:

- archived `nexus_paper.db`,
- archived `nexus_paper.db-shm` and `nexus_paper.db-wal` when present,
- TerminalRunner JSON output,
- TerminalRunner text output,
- transcript,
- analytics tail report,
- calibration tail report,
- shadow calibration tail report.

Phase 9.1 should tolerate missing optional text reports if the archived DB and runner JSON are
present.

## Recommended Command Shape

Add:

```powershell
corepack pnpm research:aggregate --once `
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 `
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 `
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729
```

Optional JSON:

```powershell
corepack pnpm research:aggregate --once --json `
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 `
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 `
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729
```

Optional output artifacts:

```powershell
corepack pnpm research:aggregate --once `
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 `
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 `
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729 `
  --output-dir=data/phase9.1-reports
```

## Runtime Defaults

```text
minRuns = 3
minUniqueMintsForPromotion = 10
minObservedDecisionsForPromotion = 100
maxSingleRunWinSharePct = 40
targetPcts = 10,15,25
stopPcts = 10,15,25
maxHoldMinutes = 15,30,60
scoreBuckets = 55-59,60-64,65-69,70-74,75+
sourceDecisions = BUY,WATCH,SKIP
promotionMode = shadow_only
```

Readiness labels:

```text
NOT_READY
PROMISING_RESEARCH
CANDIDATE_FOR_CONTROLLED_PAPER_PILOT
```

Confidence labels:

```text
LOW
MEDIUM
HIGH
```

## Promotion Gate Rules

Phase 9.1 should recommend `CANDIDATE_FOR_CONTROLLED_PAPER_PILOT` only when all of these are true:

- at least 3 valid runs,
- at least 10 unique observed mints across the compared set,
- at least 100 observed decisions across the compared set,
- no single run contributes more than 40% of target-first wins,
- no single mint contributes more than 40% of target-first wins,
- candidate threshold/profile has positive scenario P/L in most runs,
- target-before-stop is favorable for the selected target/stop grid,
- drawdown-first rate is acceptable for the proposed pilot stop,
- provider failures do not fully explain the observed edge,
- paper execution remains explicitly disabled until a later controlled pilot phase.

If the evidence is promising but fails promotion bars, label it `PROMISING_RESEARCH`.

If upside is weak, inconsistent, or dominated by one mint/window, label it `NOT_READY`.

## Implementation Checklist

### 1. Pre-Flight

- [ ] Confirm Phase 9 implementation and one-session TerminalRunner patch are committed or staged
      intentionally.
- [ ] Confirm `.gitignore` ignores local Phase 9 run output directories.
- [ ] Confirm three valid Phase 9 archive folders exist.
- [ ] Confirm old pre-patch Phase 9 smoke archive is excluded from default analysis.
- [ ] Confirm no local DB, transcript, JSON, or report artifacts are staged.
- [ ] Confirm Phase 9.1 remains read-only and does not mutate any archived DB.

### 2. Config

- [ ] Add `backend/src/research/ResearchAggregateConfig.ts`.
- [ ] Parse `--once`.
- [ ] Parse `--json`.
- [ ] Parse repeated `--label-run=LABEL:path`.
- [ ] Parse optional `--output-dir`.
- [ ] Parse optional `--min-runs`.
- [ ] Parse optional `--min-unique-mints`.
- [ ] Parse optional `--min-observed-decisions`.
- [ ] Parse optional `--max-single-run-win-share-pct`.
- [ ] Parse optional `--target-pcts`.
- [ ] Parse optional `--stop-pcts`.
- [ ] Parse optional `--max-hold-minutes`.
- [ ] Reject empty labels.
- [ ] Reject duplicate labels.
- [ ] Reject missing run paths.
- [ ] Reject non-archive paths unless explicitly supplied by the user.
- [ ] Add config tests for defaults, multiple runs, duplicate labels, invalid paths, and invalid
      thresholds.

### 3. Archive Loader

- [ ] Add `backend/src/research/ResearchRunArchiveLoader.ts`.
- [ ] Resolve each run archive path relative to repo root when not absolute.
- [ ] Locate archived `nexus_paper.db`.
- [ ] Locate runner JSON under `runner-output/*.json`.
- [ ] Locate optional analytics tail report.
- [ ] Locate optional calibration tail report.
- [ ] Locate optional shadow calibration tail report.
- [ ] Read runner JSON with structured parsing.
- [ ] Read archived DB with existing repository/database factory patterns.
- [ ] Close every opened DB handle.
- [ ] Mark missing optional text reports as warnings, not fatal errors.
- [ ] Mark missing DB or runner JSON as fatal for that run.
- [ ] Expose a normalized `ResearchRunInput` object.
- [ ] Add loader tests using temporary fixture folders.

### 4. Normalized Run Model

- [ ] Add `backend/src/research/ResearchAggregateTypes.ts`.
- [ ] Normalize run label.
- [ ] Normalize run id.
- [ ] Normalize session id.
- [ ] Normalize cycle count.
- [ ] Normalize safety status.
- [ ] Normalize one-session check.
- [ ] Normalize provider pressure by provider/status.
- [ ] Normalize TokenRadar, RiskAssessment, StrategyDecision, and WatchlistReturn rows.
- [ ] Normalize score bucket.
- [ ] Normalize quote availability.
- [ ] Normalize risk result.
- [ ] Normalize target/stop/max-hold scenario rows.
- [ ] Normalize observed decision outcomes.
- [ ] Track warnings per run.

### 5. Per-Run Metrics

- [ ] Add `backend/src/research/ResearchRunMetricsService.ts`.
- [ ] Count scanner stored total from runner JSON.
- [ ] Count unique TokenRadar mints from DB.
- [ ] Count RiskAssessment rows by result.
- [ ] Count StrategyDecision rows by decision.
- [ ] Count WatchlistReturn rows by status.
- [ ] Count observed decisions.
- [ ] Count unique observed mints.
- [ ] Compute score bucket metrics.
- [ ] Compute quote available versus missing quote metrics.
- [ ] Compute target hit rates.
- [ ] Compute target-before-stop rates.
- [ ] Compute drawdown-first rates.
- [ ] Compute best scenario per run.
- [ ] Compute provider rate-limit percentages.
- [ ] Add tests for each metric with controlled fixtures.

### 6. Cross-Run Metrics

- [ ] Add `backend/src/research/CrossRunResearchService.ts`.
- [ ] Aggregate totals across runs.
- [ ] Compute weighted decision-level metrics.
- [ ] Compute unique-mint metrics.
- [ ] Compute run consistency metrics.
- [ ] Compute score bucket comparisons across runs.
- [ ] Compare `BUY>=55`, `BUY>=65`, `BUY>=75`, and default `BUY>=90`.
- [ ] Compare quote available versus missing quote.
- [ ] Compare target/stop/max-hold scenario grids.
- [ ] Detect whether one run dominates target-first wins.
- [ ] Detect whether one mint dominates target-first wins.
- [ ] Detect whether one market window dominates positive results.
- [ ] Add tests for weighted averages and dominance detection.

### 7. Promotion Gate

- [ ] Add `backend/src/research/PromotionGateService.ts`.
- [ ] Evaluate each candidate threshold/profile against promotion bars.
- [ ] Emit readiness label.
- [ ] Emit confidence label.
- [ ] Emit blocking reasons.
- [ ] Emit supporting evidence.
- [ ] Emit caution notes.
- [ ] Keep controlled paper pilot recommendation separate from actual paper execution.
- [ ] Add tests for `NOT_READY`.
- [ ] Add tests for `PROMISING_RESEARCH`.
- [ ] Add tests for `CANDIDATE_FOR_CONTROLLED_PAPER_PILOT`.
- [ ] Add tests for low confidence due to small unique-mint sample.
- [ ] Add tests for failure when one run or mint dominates wins.

### 8. Report Output

- [ ] Add `backend/src/research/ResearchAggregateReportFormatter.ts`.
- [ ] Produce human-readable text report.
- [ ] Produce JSON report.
- [ ] Include input run list.
- [ ] Include run validation warnings.
- [ ] Include per-run summary table.
- [ ] Include cross-run totals.
- [ ] Include score bucket comparison.
- [ ] Include quote impact comparison.
- [ ] Include target-before-stop comparison.
- [ ] Include scenario portfolio comparison.
- [ ] Include provider pressure summary.
- [ ] Include promotion gate result.
- [ ] Include recommended next step.
- [ ] If `--output-dir` is supplied, write text and JSON reports.
- [ ] Keep generated reports under ignored `data/` paths.
- [ ] Add formatter snapshot-style tests with stable fixture data.

### 9. Runner And CLI

- [ ] Add `backend/src/research/ResearchAggregateRunner.ts`.
- [ ] Add `backend/src/scripts/research-aggregate.ts`.
- [ ] Add backend package script `research:aggregate`.
- [ ] Add root package script `research:aggregate`.
- [ ] Ensure command works from repo root.
- [ ] Ensure `--json` prints only JSON.
- [ ] Ensure text mode is concise enough for terminal review.
- [ ] Ensure failures explain which run archive failed and why.

### 10. Documentation

- [ ] Update [ROADMAP_Phase9Plus.md](./ROADMAP_Phase9Plus.md).
- [ ] Update [DECISIONS_Phase9Plus.md](./DECISIONS_Phase9Plus.md).
- [ ] Update [Structure_Phase9Plus.md](./Structure_Phase9Plus.md).
- [ ] Update [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md) with Phase 9 test
      findings and Phase 9.1 scope.
- [ ] Add runbook for comparing the three Phase 9 test archives.
- [ ] Document that Phase 9.1 does not enable paper BUY.

### 11. Verification

- [ ] Run `corepack pnpm format:check`.
- [ ] Run `corepack pnpm lint`.
- [ ] Run `corepack pnpm typecheck`.
- [ ] Run `corepack pnpm --filter @nexustrade/backend test`.
- [ ] Run `corepack pnpm verify`.
- [ ] Run `corepack pnpm research:aggregate --once` against the three Phase 9 archives.
- [ ] Run `corepack pnpm research:aggregate --once --json` against the three Phase 9 archives.
- [ ] Confirm generated reports are ignored by Git.
- [ ] Confirm no data files are staged.

## Acceptance Criteria

Phase 9.1 is complete when:

- [ ] cross-run aggregation command exists,
- [ ] three archived Phase 9 runs can be loaded by label,
- [ ] invalid or incomplete archives produce clear errors or warnings,
- [ ] per-run metrics match the known Phase 9 summaries,
- [ ] cross-run metrics include decision-level and unique-mint views,
- [ ] score bucket results are compared across runs,
- [ ] quote availability impact is reported,
- [ ] target-before-stop outcomes are reported,
- [ ] scenario portfolio consistency is reported,
- [ ] provider pressure is reported,
- [ ] promotion gate result is emitted,
- [ ] report recommends next step without changing strategy defaults,
- [ ] no DB migration is required,
- [ ] no paper BUY automation is enabled,
- [ ] `pnpm verify` passes.

## Expected Initial Outcome

Based on the first three Phase 9 runs, the first Phase 9.1 result is:

```text
validRuns = 3/3
observedDecisions = 277
uniqueMints = 13
orders = 0
fills = 0
positions = 0
Jupiter rateLimited = 52.67%
readiness = PROMISING_RESEARCH
confidence = MEDIUM
paper BUY automation = false
controlled paper pilot = not promoted
next step = Phase 9.2 provider bottleneck work or another shadow batch
```

The aggregate confirms useful signal but not enough repeatable, profile-level evidence for a
controlled paper pilot.

## Implementation Completion Notes

Implemented command:

```powershell
corepack pnpm research:aggregate --once `
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 `
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 `
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729
```

Implemented files:

```text
backend/src/research/ResearchAggregateConfig.ts
backend/src/research/ResearchRunArchiveLoader.ts
backend/src/research/CrossRunResearchService.ts
backend/src/research/PromotionGateService.ts
backend/src/research/ResearchAggregateReportFormatter.ts
backend/src/research/ResearchAggregateRunner.ts
backend/src/scripts/research-aggregate.ts
backend/src/research/*.test.ts
```

Implemented scripts:

```text
backend/package.json -> research:aggregate
package.json -> research:aggregate
```

Safety result:

```text
archived databases are opened read-only
optional reports are warnings, not fatal
missing DB or TerminalRunner JSON is fatal
pre-patch runs without one top-level session are rejected from promotion validity
aggregate JSON summarizes TerminalRunner metadata and leaves raw cycles in source runner JSON files
paper BUY automation remains disabled
```

First aggregate blockers:

```text
target-first wins were too concentrated in one run: 42.54% from T2
no shadow-entry profile currently clears the Phase 8.92B promotion workbench
```

## Phase 9.2 Handoff

If Phase 9.1 confirms provider pressure is still materially distorting quote confidence, Phase 9.2
should focus on:

```text
quote cache
Jupiter backoff
provider fallback framework
Raydium direct quote fallback planning
Birdeye selective enrichment budget
```

If Phase 9.1 identifies a strong controlled paper pilot candidate, add a separate Phase 9.x plan
for:

```text
controlled paper pilot
small position size
max open positions 1-2
hard session loss cap
fixed target/stop/hold
shadow comparison beside paper execution
no live wallet
```
