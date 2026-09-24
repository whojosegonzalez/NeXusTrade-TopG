# NeXusTrade Phase 8.8 Detailed Checklist

Strategy Calibration Workbench + MFE/MAE Research + Threshold Evidence

Last updated: June 2026

Status: Complete.

Mode: `PAPER` analysis only.

## Executive Summary

Phase 8.8 is a research and calibration phase.

The goal is not to add new trading behavior. The goal is to decide whether the current strategy
score actually ranks token quality, or whether it mostly ranks evidence completeness and provider
availability.

Phase 8.8 consumes the data produced by Phase 8.7 and Phase 8.7B:

- strategy decisions
- stored strategy score factors
- watchlist forward-return observations
- TokenRadar market fields
- risk assessment flags and results
- provider health records
- threshold experiment outputs

Phase 8.8 produces read-only reports that answer:

- Why did a candidate receive its score?
- Did higher scores produce better forward returns?
- Which score thresholds would have captured realistic +10%, +25%, or +39% targets?
- Did missed opportunities reach a target before a major drawdown?
- How much did Jupiter rate limiting and missing quote evidence affect scoring?
- Which gates or weights appear to suppress promising candidates?

Phase 8.8 does not execute trades, create orders, create fills, open positions, close positions, load
wallets, sign transactions, submit transactions, add live swaps, or add automated exit rules.

## Why This Phase Exists

Phase 8.7 and Phase 8.7B showed that the paper pipeline is stable, but strategy quality is still
unknown.

Important findings from the completed experiments:

- no strategy candidates received a `PASS` risk result
- all meaningful strategy candidates were scored from `WARN` risk evidence
- `MISSING_AUTHORITY_EVIDENCE` appeared on all observed strategy rows
- `MISSING_QUOTE` and missing price-impact evidence were common
- Jupiter rate limiting stayed around 52% to 59%
- scores clustered around 55 to 65
- several score-55 SKIP candidates later produced large favorable moves
- lowering BUY from 75 to 65 increased BUY/WATCH counts, but did not prove profitability
- actual BUY observations were mostly negative, with one notable WifStick positive move

That means the next useful phase is not more automation. The next useful phase is calibration.

## Phase Objective

Build a read-only strategy calibration workbench that can analyze existing paper data and produce
clear recommendations for:

- score weights
- BUY/WATCH thresholds
- hard gates
- quote-confidence handling
- provider bottlenecks
- target-profit feasibility
- Phase 9 orchestration defaults

The output should make it possible to decide whether Phase 9 should run the current strategy, a
reweighted strategy, or shadow-only orchestration until more data exists.

## Locked Clarifications

- [ ] Phase 8.8 is `PAPER` analysis only.
- [ ] Phase 8.8 must be read-only against trading state.
- [ ] Phase 8.8 must not create orders.
- [ ] Phase 8.8 must not create fills.
- [ ] Phase 8.8 must not open positions.
- [ ] Phase 8.8 must not close positions.
- [ ] Phase 8.8 must not update session cash.
- [ ] Phase 8.8 must not update session status.
- [ ] Phase 8.8 must not update TokenRadar statuses.
- [ ] Phase 8.8 must not create new StrategyDecision rows.
- [ ] Phase 8.8 must not create new RiskAssessment rows.
- [ ] Phase 8.8 must not require wallet loading.
- [ ] Phase 8.8 must not sign transactions.
- [ ] Phase 8.8 must not submit transactions.
- [ ] Phase 8.8 must not add live execution logic.
- [ ] Phase 8.8 must not add automated exit logic.
- [ ] Phase 8.8 must not loosen existing BUY gates.
- [ ] Phase 8.8 must not change production defaults until the report supports it.
- [ ] Existing Phase 8.7 and 8.7B datasets may be used as validation fixtures locally.
- [ ] Local experiment database snapshots must remain ignored by Git.

## Implementation Review

Phase 8.8 is implementable with the current codebase.

No first-pass database migration is required because the required evidence already exists:

- `strategy_decisions.input_snapshot_json` stores `strategyScore.factors`
- `watchlist_return_observations` stores forward returns by horizon
- `token_radar` stores price, liquidity, volume, age, mint, symbol, and pair fields
- `risk_assessments` stores result, score, flags, liquidity, and raw provider data
- `provider_health` stores status, rate limit, latency, provider, and context records

The main limitation is that the current watchlist returns are endpoint observations, not full tick
history. Phase 8.8 can calculate practical MFE/MAE across observed horizons, but not true
intra-horizon path unless more frequent observations are collected later.

## Definition Of Done

Phase 8.8 is complete when:

- [x] A read-only calibration report command exists.
- [x] The report can target the latest paper session.
- [x] The report can target an explicit `--session-id`.
- [x] The report can include multiple archived experiment DB snapshots when passed as inputs.
- [x] The report explains score attribution from stored `strategyScore.factors`.
- [x] The report summarizes score distribution by run, decision, and unique mint.
- [x] The report compares BUY/WATCH/SKIP outcomes by forward-return horizon.
- [x] The report calculates practical MFE and MAE from observed horizons.
- [x] The report calculates target-hit rates for +10%, +25%, and +39%.
- [x] The report calculates drawdown breach rates for configured adverse thresholds.
- [x] The report identifies missed opportunities sorted by best forward return.
- [x] The report identifies false-positive BUY candidates.
- [x] The report quantifies Jupiter rate limit impact.
- [x] The report quantifies missing quote and missing authority evidence impact.
- [x] The report identifies score ceilings caused by WARN risk or missing quote evidence.
- [x] The report produces threshold recommendations for research and execution-like paper mode.
- [x] The report produces weight-calibration recommendations without automatically applying them.
- [x] The report supports JSON output for future dashboard use.
- [x] The report supports human-readable text output for CLI review.
- [x] Tests cover attribution, MFE/MAE, target-hit simulation, threshold comparison, and read-only
      safety.
- [x] `pnpm verify` passes.
- [x] `docs/ROADMAP.md` is updated with Phase 8.8.
- [x] Phase 9 planning inputs are updated with Phase 8.8 conclusions.

## Implementation Notes

Implemented command surfaces:

```bash
pnpm calibration:report
pnpm --filter @nexustrade/backend calibration:report
```

Implemented entrypoint:

```text
backend/src/scripts/calibration-report.ts
```

Implemented backend module:

```text
backend/src/calibration
```

Implemented reports:

- score distribution
- score attribution
- observed-horizon MFE/MAE approximation
- target/drawdown simulation
- missed opportunity report
- false-positive BUY report
- provider impact report
- threshold comparison
- text and JSON output

Threshold comparison output includes `observedBUY` / `observedBuyCount` so hit rates and average
BUY returns can be audited against the number of simulated BUY decisions with observed forward
returns.

Verification:

```text
pnpm verify: passed
backend tests: 43 files, 153 tests passed
shared tests: 4 files, 12 tests passed
secret check: passed
```

## Recommended Command Surface

Add root script:

```bash
pnpm calibration:report
```

Add backend script:

```bash
pnpm --filter @nexustrade/backend calibration:report
```

Expected entrypoint:

```text
backend/src/scripts/calibration-report.ts
```

Recommended usage:

```bash
pnpm calibration:report --once
pnpm calibration:report --once --session-id=<session_id>
pnpm calibration:report --once --json
pnpm calibration:report --once --target-pcts=10,25,39
pnpm calibration:report --once --drawdown-pcts=10,25,50
```

Optional archived snapshot usage:

```bash
pnpm calibration:report --once --db=data/Conservative75_nexus_paper.db
pnpm calibration:report --once --db=data/Aggressive75_nexus_paper.db
pnpm calibration:report --once --db=data/Conservative65_nexus_paper.db
pnpm calibration:report --once --db=data/Aggressive65_nexus_paper.db
```

Multi-DB comparison can be implemented either in the first pass or a follow-up inside Phase 8.8:

```bash
pnpm calibration:report --once `
  --label-db=Con75:data/Conservative75_nexus_paper.db `
  --label-db=Agg75:data/Aggressive75_nexus_paper.db `
  --label-db=Con65:data/Conservative65_nexus_paper.db `
  --label-db=Agg65:data/Aggressive65_nexus_paper.db
```

## Runtime Defaults

Use conservative read-only defaults:

```text
mode = PAPER
sinceHours = 168
limit = 500
scoreBucketSize = 5
targetPcts = 10,25,39
drawdownPcts = 10,25,50
horizonsMinutes = 3,5,15,30,60,120,240,360,480,720
minScore = 0
sourceDecisions = BUY,WATCH,SKIP
json = false
writeReportFile = false
```

No mutation flags should exist in Phase 8.8.

## Data Sources

### Strategy Decisions

Read:

```text
strategy_decisions
```

Required fields:

- `id`
- `session_id`
- `mint_address`
- `decided_at_ms`
- `decision`
- `strategy_name`
- `score`
- `reason`
- `input_snapshot_json`

Use `input_snapshot_json.strategyScore.factors` as the source of score attribution.

### Watchlist Returns

Read:

```text
watchlist_return_observations
```

Required fields:

- `strategy_decision_id`
- `mint_address`
- `symbol`
- `decision`
- `strategy_score`
- `horizon_minutes`
- `baseline_price_sol`
- `observed_price_sol`
- `return_pct_sol`
- `status`
- `error_code`
- `error_message`

Use `return_pct_sol` as the main return field because the trading account is SOL-denominated.

### Risk Evidence

Read:

```text
risk_assessments
```

Required fields:

- `mint_address`
- `checked_at_ms`
- `score`
- `result`
- `risk_flags_json`
- `liquidity_usd`
- `raw_provider_data_json`

Risk evidence should explain whether candidates were capped by:

- `WARN` result
- `MISSING_AUTHORITY_EVIDENCE`
- `MISSING_QUOTE`
- `MISSING_LIQUIDITY`
- `PAIR_YOUNG`
- price-impact failures

### Provider Health

Read:

```text
provider_health
```

Required fields:

- `provider`
- `timestamp_ms`
- `status`
- `rate_limited`
- `error_message`
- `latency_ms`
- `context_json`

Provider report must separate:

- DexScreener health
- Helius health
- Jupiter health
- Jupiter quote success vs degraded vs rate limited vs error

## New Backend Modules

Recommended structure:

```text
backend/src/calibration/
  CalibrationConfig.ts
  CalibrationRunner.ts
  CalibrationReportService.ts
  CalibrationRepository.ts
  ScoreAttributionService.ts
  ForwardReturnAnalyzer.ts
  TargetSimulationService.ts
  ProviderImpactAnalyzer.ts
  ThresholdComparisonService.ts
  CalibrationReportFormatter.ts
```

Recommended tests:

```text
backend/src/calibration/*.test.ts
```

## Calibration Config

Add:

```text
backend/src/calibration/CalibrationConfig.ts
```

Options:

- `--once`
- `--session-id=<id>`
- `--since-hours=<hours>`
- `--limit=<n>`
- `--score-bucket-size=<n>`
- `--min-score=<0-100>`
- `--source-decisions=BUY,WATCH,SKIP`
- `--target-pcts=10,25,39`
- `--drawdown-pcts=10,25,50`
- `--horizons-minutes=3,5,15,30,60,120,240,360,480,720`
- `--db=<path>`
- `--label-db=<label>:<path>`
- `--json`

Validation:

- [ ] `target-pcts` must be positive finite numbers.
- [ ] `drawdown-pcts` must be positive finite numbers.
- [ ] `horizons-minutes` must be positive integers.
- [ ] `score-bucket-size` must be 1 to 25.
- [ ] `min-score` must be 0 to 100.
- [ ] `source-decisions` must use known strategy decision values.
- [ ] `--session-id` must not be empty.
- [ ] `--db` path must exist when supplied.
- [ ] `--label-db` labels must be non-empty and unique.

## Calibration Repository

Add:

```text
backend/src/calibration/CalibrationRepository.ts
```

Methods:

- [ ] `findLatestPaperSessionWithCalibrationData()`
- [ ] `getSession(sessionId)`
- [ ] `listStrategyDecisions(input)`
- [ ] `listWatchlistReturnsForDecisions(strategyDecisionIds)`
- [ ] `listRiskAssessmentsForMints(input)`
- [ ] `listProviderHealth(input)`
- [ ] `getTokenRadarRowsForMints(input)`

Repository rules:

- [ ] All methods are read-only.
- [ ] No insert/update/delete methods.
- [ ] If using an archived DB path, open it read-only.
- [ ] If no calibration data exists, return a clear no-data result.

## Score Attribution Report

Use `strategy_decisions.input_snapshot_json.strategyScore.factors`.

For each selected decision, produce:

```text
Symbol / Mint
Decision
Score
Risk result
Risk flags

risk_eligibility ............... +20
liquidity_attractiveness ....... +10
volume_1h_attractiveness ....... +20
pair_age_attractiveness ........ +5
price_impact_attractiveness .... +10
duplicate_buy_protection ....... +0
TOTAL .......................... 65
```

Required aggregate attribution:

- [ ] average points by rule
- [ ] median points by rule
- [ ] zero-point frequency by rule
- [ ] failed-gate frequency by rule
- [ ] warning frequency by rule
- [ ] score ceiling by risk result
- [ ] score ceiling by missing quote state
- [ ] top score-limiting rules

Acceptance:

- [ ] PROV-like score 65 explains as `20 + 10 + 20 + 5 + 10`.
- [ ] WEN-like score 75 explains as `20 + 20 + 20 + 5 + 10`.
- [ ] GRACIE-like score 55 shows liquidity passing gate but receiving 0 attractiveness points.

## Forward Return Analysis

For every strategy decision with observed watchlist returns:

Calculate:

- [ ] return by horizon
- [ ] best observed return through selected horizons
- [ ] worst observed return through selected horizons
- [ ] first horizon that reaches each target
- [ ] first horizon that breaches each drawdown threshold
- [ ] observed MFE
- [ ] observed MAE

Important caveat:

```text
MFE and MAE are practical observed-horizon approximations, not true tick-level path metrics.
```

Required summary tables:

- [ ] by run
- [ ] by decision
- [ ] by score bucket
- [ ] by unique mint
- [ ] by risk result
- [ ] by risk flag set
- [ ] by liquidity bucket
- [ ] by volume bucket
- [ ] by pair-age bucket
- [ ] by quote availability

Default target-hit table:

```text
Score Bucket | Decisions | Hit +10% | Hit +25% | Hit +39% | Median Best | Median Worst
```

Default horizon table:

```text
Horizon | BUY Avg | WATCH Avg | SKIP Avg | BUY Hit +10% | WATCH Hit +10% | SKIP Hit +10%
```

## Profit Target Simulation

Simulate whether target exits would have been theoretically possible from observed horizons.

Default assumptions:

```text
targetPct = 10,25,39
stopPct = 10,25,50
maxHoldMinutes = 60
entryAtBaseline = true
exitAtFirstTargetHorizon = true
stopAtFirstDrawdownHorizon = true
```

Report:

- [ ] target hit before stop
- [ ] stop hit before target
- [ ] neither hit within max hold
- [ ] target hit at 3m, 5m, 15m, 30m, 60m
- [ ] average best return before max hold
- [ ] average worst return before max hold
- [ ] rough win rate by score bucket
- [ ] rough win rate by decision

Important caveat:

If target and stop both occur between two observed horizons, Phase 8.8 cannot know which happened
first. The report must label those cases as ambiguous instead of pretending precision.

## Missed Opportunity Report

Create a ranked report of WATCH/SKIP candidates sorted by best observed return.

Required columns:

```text
Run
Symbol
Mint
Decision
Score
Best return <= 60m
Best horizon
Worst return <= 60m
Risk flags
Score factors
Blocking factors
Liquidity USD
Volume 1h USD
Age minutes
Quote available
```

Required filters:

- [ ] minimum best return
- [ ] maximum horizon
- [ ] minimum liquidity
- [ ] minimum volume
- [ ] score bucket
- [ ] decision

This report should answer:

- [ ] Which skipped candidates would have reached +10%?
- [ ] Which skipped candidates would have reached +25%?
- [ ] Which skipped candidates would have reached +39%?
- [ ] Were the winners low score because of liquidity, quote, risk, age, or something else?

## False Positive BUY Report

Create a report of BUY decisions that failed to reach practical targets.

Required columns:

```text
Run
Symbol
Mint
Score
Best return <= 60m
Worst return <= 60m
3m return
5m return
15m return
30m return
60m return
Risk flags
Liquidity USD
Volume 1h USD
Age minutes
Quote available
```

This report should answer:

- [ ] Did BUYs fail immediately?
- [ ] Did BUYs ever reach +10%?
- [ ] Did BUYs draw down before target?
- [ ] Were failed BUYs selected because of threshold only?
- [ ] Were failed BUYs over-scored because of high volume or high liquidity?

## Provider Impact Report

Quantify provider influence.

Required metrics:

- [ ] Jupiter OK count and percent
- [ ] Jupiter DEGRADED count and percent
- [ ] Jupiter RATE_LIMITED count and percent
- [ ] Jupiter ERROR count and percent
- [ ] DexScreener OK count and percent
- [ ] Helius OK count and percent
- [ ] strategy rows with `MISSING_QUOTE`
- [ ] strategy rows with missing price-impact facts
- [ ] strategy rows with `MISSING_AUTHORITY_EVIDENCE`
- [ ] average score with quote evidence
- [ ] average score without quote evidence
- [ ] target-hit rate with quote evidence
- [ ] target-hit rate without quote evidence

Recommended interpretation:

```text
Quote availability should influence confidence, but missing quote should not automatically prove a
candidate is bad.
```

The report should distinguish:

- market opportunity score
- execution confidence
- provider completeness

## Threshold Comparison

Evaluate threshold candidates without writing strategy decisions.

Default threshold scenarios:

```text
BUY 90 / WATCH 70
BUY 75 / WATCH 70
BUY 75 / WATCH 60
BUY 65 / WATCH 60
BUY 55 / WATCH 50
```

For each scenario, report:

- [ ] simulated BUY count
- [ ] simulated WATCH count
- [ ] simulated SKIP count
- [ ] unique BUY mints
- [ ] target-hit rates
- [ ] false-positive rates
- [ ] average MFE
- [ ] average MAE
- [ ] provider-missing composition
- [ ] risk-flag composition

Important rule:

Threshold simulations must not bypass existing BUY eligibility gates. They should evaluate what
would happen if thresholds changed while gates stayed intact.

## Weight Calibration Research

Phase 8.8 should recommend changes, not automatically apply them.

Potential adjustments to evaluate:

- [ ] move risk from score weight to eligibility/confidence bucket
- [ ] split tradeability and momentum into separate scores
- [ ] reduce hard liquidity point cliffs
- [ ] add continuous liquidity scoring
- [ ] add continuous volume scoring
- [ ] add 5-minute volume acceleration
- [ ] add relative volume when available
- [ ] increase importance of early favorable movement if observations exist
- [ ] treat missing quote as confidence loss rather than opportunity loss
- [ ] preserve quote availability as an execution gate for actual paper orders
- [ ] test whether age should award more than 5 points after 30 minutes
- [ ] test whether 30-minute minimum age should remain a hard BUY gate

Do not change production scoring in Phase 8.8 unless the implementation explicitly adds a shadow
strategy mode and keeps the existing strategy default unchanged.

## Recommended Output Shape

Human-readable output sections:

```text
NeXusTrade Calibration Report
Session / Dataset Summary
Score Distribution
Score Attribution
Forward Return Summary
Target Hit Simulation
Missed Opportunities
False Positive BUYs
Provider Impact
Threshold Comparison
Calibration Recommendations
Phase 9 Readiness
```

JSON output shape:

```ts
interface CalibrationReportJson {
  generatedAtMs: number;
  datasets: CalibrationDatasetSummary[];
  scoreDistribution: ScoreDistributionSummary;
  scoreAttribution: ScoreAttributionSummary;
  forwardReturns: ForwardReturnSummary;
  targetSimulation: TargetSimulationSummary;
  missedOpportunities: MissedOpportunitySummary[];
  falsePositiveBuys: FalsePositiveBuySummary[];
  providerImpact: ProviderImpactSummary;
  thresholdComparison: ThresholdScenarioSummary[];
  recommendations: CalibrationRecommendation[];
}
```

## Acceptance Tests

Add tests for:

- [ ] config parsing accepts valid targets, drawdowns, horizons, and decisions
- [ ] config parsing rejects invalid target percentages
- [ ] config parsing rejects invalid decision names
- [ ] score attribution sums rule points to the stored score
- [ ] missing factor snapshots are handled without crashing
- [ ] MFE uses the best observed return across selected horizons
- [ ] MAE uses the worst observed return across selected horizons
- [ ] target hit is detected at the first observed horizon meeting the threshold
- [ ] drawdown breach is detected at the first observed horizon meeting the threshold
- [ ] ambiguous target/stop ordering is flagged when needed
- [ ] missed opportunity report excludes BUY rows by default
- [ ] false positive BUY report includes BUY rows that fail selected target
- [ ] provider impact correctly calculates rate-limit percentages
- [ ] threshold comparison does not bypass buy eligibility
- [ ] repository has no mutation methods
- [ ] dry/no-data cases produce clear output

## Validation Datasets

Use local ignored data snapshots for manual validation:

```text
data/Conservative75_nexus_paper.db
data/Aggressive75_nexus_paper.db
data/Conservative65_nexus_paper.db
data/Aggressive65_nexus_paper.db
```

Expected manual validation checks:

- [ ] Conservative75 reports zero BUY decisions.
- [ ] Aggressive75 reports one BUY and three WATCH rows.
- [ ] Conservative65 reports one BUY row.
- [ ] Aggressive65 reports four BUY rows and eleven WATCH rows.
- [ ] Jupiter rate limit percentage is reported around 52% to 59%.
- [ ] Score 55 and score 65 are both represented in missed opportunities.
- [ ] WifStick appears as the strongest actual BUY example in Aggressive65.
- [ ] WEN and SPRINKLES appear as failed BUY examples in their datasets.
- [ ] Report clearly states that endpoint observations are not tick-level path data.

## Phase 9 Handoff Criteria

Phase 9 should not begin with fully automated paper execution until Phase 8.8 can answer:

- [ ] Which threshold should Phase 9 use for paper BUYs?
- [ ] Should Phase 9 run strategy in shadow mode first?
- [ ] Are score 55 candidates worth tracking but not buying?
- [ ] Are score 65 candidates worth small paper BUYs?
- [ ] Is score 75 too rare because of WARN risk evidence?
- [ ] Should Jupiter quote availability be a BUY gate, a confidence score, or both?
- [ ] Should missing authority evidence prevent BUY or remain eligible WARN?
- [ ] Is aggressive scanning worth the provider load?
- [ ] What target/stop/max-hold defaults should TerminalRunner use?

Recommended Phase 9 readiness states:

```text
GREEN:
  Phase 8.8 identifies a threshold/gate combination with positive target-hit evidence and
  manageable drawdown.

YELLOW:
  Phase 8.8 identifies promising candidates but insufficient sample size. Phase 9 may run
  shadow-only orchestration.

RED:
  Phase 8.8 shows score does not rank quality. Delay execution orchestration and revise scoring.
```

## Known Limitations

- Existing forward returns are endpoint observations, not continuous price paths.
- MFE/MAE are observed-horizon approximations.
- Provider rate limits may bias quote confidence.
- DexScreener prices may not equal executable Jupiter quotes.
- Local datasets are small and market-window dependent.
- Meme-coin behavior is highly non-stationary.
- Phase 8.8 cannot prove profitability; it can improve decision evidence before Phase 9.

## Recommended Implementation Order

```text
config/scripts
-> read-only repository
-> score attribution service
-> forward-return MFE/MAE analyzer
-> target/drawdown simulation
-> missed-opportunity and false-positive reports
-> provider impact report
-> threshold comparison
-> text/json formatter
-> tests
-> docs and Phase 9 handoff update
```

## Sign-Off Criteria

Phase 8.8 is ready to close when the final report can support one of these decisions:

```text
Proceed to Phase 9 with calibrated paper defaults.
Proceed to Phase 9 in shadow-only mode.
Delay Phase 9 and revise strategy scoring first.
Collect more Phase 8.7-style data before deciding.
```
