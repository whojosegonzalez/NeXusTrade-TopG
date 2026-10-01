# NeXusTrade Phase 8.7 Detailed Checklist

Strategy Calibration + Analytics + Forward-Return Research

Last updated: June 2026

Status: Complete.

Mode: `PAPER` only.

## Executive Summary

Phase 8.7 turns the Phase 8.6 long-validation findings into measurement tools.

The goal is not to force trades. The goal is to understand whether the scanner, risk engine, and
strategy engine are producing candidates that could have generated positive forward returns under
auditable paper conditions.

Phase 8.7 adds:

- a configurable strategy BUY score threshold with a conservative default
- a read-only analytics report for funnels, score buckets, near misses, missed opportunities, and
  provider health
- a forward-return tracker for watched strategy candidates
- better strategy input snapshots for future analysis
- provider-rate-limit reporting so Jupiter bottlenecks are visible instead of anecdotal

Phase 8.7 does not add live trading, wallet use, signing, transaction submission, new exit rules, or
profit-seeking automation.

## Why This Phase Exists

The Phase 8.6 long validation showed:

- scanner discovery and enrichment worked over a longer real-market window
- no candidates produced a `PASS` risk result
- many otherwise interesting candidates were constrained by `WARN` evidence
- strategy scores topped out below the current BUY threshold
- Jupiter rate limiting materially reduced quote confidence
- no paper orders, fills, positions, or P/L were produced

That means the next useful step is not Phase 9 orchestration yet. The next useful step is a
calibration and measurement phase that can answer:

- Were our skipped candidates actually bad?
- Did high-score WATCH/SKIP candidates move favorably after 3 minutes, 5 minutes, 15 minutes, and
  beyond?
- Which rules block candidates most often?
- Is Jupiter rate limiting hiding potentially eligible candidates?
- Would a paper-only score threshold of `75` create reasonable BUY opportunities without removing
  safety gates?

## Locked Clarifications

- [ ] Phase 8.7 is `PAPER` only.
- [ ] No wallet loading.
- [ ] No transaction signing.
- [ ] No transaction submission.
- [ ] No live swaps.
- [ ] No live liquidation.
- [ ] No automatic SELL behavior.
- [ ] No target-profit automation changes.
- [ ] No drawdown automation changes.
- [ ] No stop-loss, trailing-stop, max-hold, liquidity-collapse, or partial-exit rules.
- [ ] Scanner may continue discovering tokens younger than 30 minutes.
- [ ] Strategy default pair-age requirement remains `30` minutes.
- [ ] Strategy must not BUY tokens younger than the configured minimum pair age.
- [ ] Default BUY score threshold remains `90`.
- [ ] Testing with `--buy-score-threshold=75` is allowed only when explicitly passed.
- [ ] Lowering the score threshold must not bypass existing `buyEligible` gates.
- [ ] Existing risk policy remains `PASS_OR_ELIGIBLE_WARN`.
- [ ] Eligible `WARN` risk can be tested in paper mode, but unknown authority evidence remains a
      warning, not a confident pass.
- [ ] Missing Jupiter quote evidence remains a warning, not a pass.
- [ ] Jupiter is still the execution-quality quote source.
- [ ] DexScreener remains the broad price/liquidity monitoring source.
- [ ] Provider rate limits should be measured before paying for higher limits.

## Definition Of Done

Phase 8.7 is complete when:

- [x] Strategy config supports `buyScoreThreshold`.
- [x] `strategy:evaluate` accepts `--buy-score-threshold=<0-100>`.
- [x] Default `buyScoreThreshold` is `90`.
- [x] Score threshold `75` can produce BUY only when all existing BUY gates pass.
- [x] Strategy decision snapshots include enough baseline fields for return analysis.
- [x] A read-only analytics report command exists.
- [x] Analytics report includes funnel counts, score buckets, near misses, and provider health.
- [x] Analytics report includes a missed opportunity report after forward-return observations exist.
- [x] Forward-return observation schema is added.
- [x] Forward-return repository methods are added.
- [x] Forward-return tracker command exists.
- [x] Forward-return tracker schedules observations without duplicates.
- [x] Forward-return tracker observes due horizons using provider-backed refreshed data when
      available.
- [x] Forward-return tracker records clear failure or missed-observation states.
- [x] Dry-run paths do not mutate strategy decisions, TokenRadar rows, return observations, orders,
      fills, positions, session cash, or session status.
- [x] Acceptance tests pass.
- [x] `pnpm verify` passes.
- [x] Phase 9 planning inputs are updated with the new command surfaces and calibration defaults.

## Implementation Notes

Implemented command surfaces:

```bash
pnpm analytics:report --once
pnpm watchlist:returns --once
pnpm strategy:evaluate --once --buy-score-threshold=75
```

Implemented persistence:

```text
watchlist_return_observations
```

Implemented reports:

- funnel counts
- risk results
- strategy decisions
- score buckets
- near misses
- missed opportunities after observations exist
- provider health
- Jupiter rate-limit summary

Safety boundary:

- no wallet loading
- no signing
- no transaction submission
- no automatic exits
- analytics is read-only
- watchlist return dry-run writes nothing

## New Command Surface

Add these root scripts:

```bash
pnpm analytics:report
pnpm watchlist:returns
```

Add these backend scripts:

```bash
pnpm --filter @nexustrade/backend analytics:report
pnpm --filter @nexustrade/backend watchlist:returns
```

Expected direct entrypoints:

```text
backend/src/scripts/analytics-report.ts
backend/src/scripts/watchlist-returns.ts
```

Expected usage:

```bash
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm analytics:report --once
pnpm watchlist:returns --once
```

Longer validation usage:

```bash
pnpm scanner:discover --interval-ms=60000 --limit=25 --concurrency=3
pnpm risk:evaluate --once
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm watchlist:returns --once
pnpm analytics:report --once
```

## Strategy Calibration Scope

### Current Behavior To Preserve

Current score decisions:

```text
score >= 90 -> BUY
score >= 70 -> WATCH
otherwise -> SKIP
```

Current BUY gates:

```text
riskEligibility.buyEligible
liquidity.passed
volume.passed
pairAge.passed
priceImpact.passed
no duplicate BUY
max BUY cap not reached
```

These gates must remain.

### Required Strategy Config Change

Update:

```text
backend/src/strategy/StrategyConfig.ts
```

Add:

```ts
buyScoreThreshold: 90;
watchScoreThreshold: 70;
```

Recommended bounds:

```text
buyScoreThreshold: integer 0 to 100
watchScoreThreshold: integer 0 to 100
```

Validation rule:

```text
buyScoreThreshold >= watchScoreThreshold
```

CLI flags:

```bash
--buy-score-threshold=75
--watch-score-threshold=70
```

Default behavior must remain unchanged:

```bash
pnpm strategy:evaluate --once
```

still means:

```text
BUY threshold = 90
WATCH threshold = 70
```

### Required Strategy Scoring Change

Update:

```text
backend/src/strategy/StrategyScoringService.ts
```

Change `scoreToDecision(score)` into a config-aware decision helper.

Recommended shape:

```ts
function scoreToDecision(score: number, config: StrategyRuntimeConfig): StrategyDecision {
  if (score >= config.buyScoreThreshold) {
    return "BUY";
  }

  if (score >= config.watchScoreThreshold) {
    return "WATCH";
  }

  return "SKIP";
}
```

Important:

- [ ] This only changes `rawDecision`.
- [ ] `applyDecisionOverrides` still blocks ineligible BUY decisions.
- [ ] Lower thresholds do not turn missing liquidity, low volume, young pair age, high price
      impact, duplicate BUY, or max-cap cases into unsafe BUYs.

### Strategy Snapshot Improvements

Update:

```text
backend/src/strategy/StrategyEvaluationService.ts
```

Add these fields to `inputSnapshotJson.tokenRadar`:

```text
name
pairAddress
source
priceSol
priceUsd
liquidityUsd
volume5mUsd
volume1hUsd
ageSeconds
firstSeenAtMs
discoveredAtMs
updatedAtMs
```

Add these fields to `inputSnapshotJson.strategyScore`:

```text
buyScoreThreshold
watchScoreThreshold
buyEligible
duplicateBuyBlocked
maxBuyCapBlocked
```

Reason:

Forward-return tracking needs a reliable baseline price at the moment the strategy decision was
made. Existing older rows may not have this baseline. Phase 8.7 should support a fallback for old
rows, but all new strategy decisions should be analysis-ready.

## Analytics Report Scope

### Command

Add:

```bash
pnpm analytics:report --once
```

Recommended options:

```bash
--session-id=<id>
--since-hours=24
--limit=250
--score-bucket-size=5
--near-miss-min-score=50
--provider-since-hours=24
--json
```

Defaults:

```text
sinceHours = 24
limit = 250
scoreBucketSize = 5
nearMissMinScore = 50
providerSinceHours = 24
json = false
```

Session rule:

```text
If --session-id is supplied:
  require PAPER session

If --session-id is not supplied:
  use latest PAPER session with TokenRadar rows or StrategyDecision rows

If none exists:
  fail with a clear message
```

Read-only rule:

```text
analytics:report must not write to the database
```

### Suggested Files

```text
backend/src/analytics/AnalyticsConfig.ts
backend/src/analytics/AnalyticsReportService.ts
backend/src/analytics/AnalyticsRunner.ts
backend/src/analytics/AnalyticsReportFormatter.ts
backend/src/analytics/AnalyticsRunner.test.ts
backend/src/scripts/analytics-report.ts
```

### Report Sections

The default text report should include:

```text
Session
Funnel
Risk Results
Strategy Decisions
Score Buckets
Near Misses
Missed Opportunities
Provider Health
Jupiter Rate Limit Summary
Recommended Next Run
```

#### Session Section

Include:

- session id
- mode
- status
- starting cash
- current cash
- target profit settings
- max drawdown settings
- termination reason
- created time
- updated time

#### Funnel Section

Include counts for:

- TokenRadar total rows
- TokenRadar by status
- RiskAssessment by result
- StrategyDecision by decision
- Order by status
- Fill count
- Position by status
- EquitySnapshot count
- WatchlistReturnObservation by status after forward-return tracker exists

#### Score Bucket Section

Group strategy decision scores into configurable buckets.

Default buckets:

```text
0-4
5-9
...
70-74
75-79
80-84
85-89
90-94
95-100
```

For each bucket include:

- total decisions
- BUY count
- WATCH count
- SKIP count
- average liquidity
- average 1h volume
- average age seconds
- average max price impact when available

If parsing average fields from snapshots is too broad for first pass, include counts first and add
the averages as a follow-up task inside the same phase.

#### Near-Miss Section

Default near miss definition:

```text
score >= nearMissMinScore
decision != BUY
```

For each near miss include:

- decided time
- mint address
- symbol
- decision
- score
- reason
- top failed or blocking factors
- risk result
- risk flags
- liquidity USD
- volume 1h USD
- age seconds
- max price impact
- whether Jupiter quote was missing or rate limited

The report should make it easy to see whether candidates were blocked by:

- risk result
- missing authority certainty
- missing quote
- low liquidity
- low 1h volume
- pair age below 30 minutes
- high price impact
- duplicate BUY protection
- max BUY cap

#### Missed Opportunity Section

Default missed opportunity definition:

```text
decision != BUY
observed forward return exists
forward return is positive for at least one selected horizon
```

Default sorting:

```text
highest 1h return first
fallback to highest 30m return when 1h is not observed
fallback to highest available return when neither 1h nor 30m is observed
```

Default limit:

```text
20 rows
```

For each missed opportunity include:

- mint address
- symbol
- original strategy decision
- original score
- original reason
- risk result
- blocking factors
- baseline price
- 3m return
- 5m return
- 15m return
- 30m return
- 1h return
- 2h return
- 4h return
- 6h return
- 8h return
- 12h return
- best observed horizon
- best observed return

The point of this report is to answer:

```text
What would have worked if we had not rejected or watched it?
```

This is not proof that the bot could have captured the move. It is evidence for later tuning.

#### Provider Health Section

Use existing `ProviderHealthRepository`.

Report by provider and operation:

- total calls
- status counts
- OK percentage
- DEGRADED percentage
- RATE_LIMITED percentage
- ERROR percentage
- most recent status
- most recent error code/message when available

Jupiter-specific output should call out:

```text
JUPITER rate-limited count
JUPITER degraded count
JUPITER OK count
JUPITER quote-confidence warning
```

### Analytics Acceptance

- [ ] `pnpm analytics:report --once` prints a readable text report.
- [ ] `pnpm analytics:report --once --json` prints machine-readable JSON.
- [ ] The command fails clearly when no suitable paper session exists.
- [ ] The command supports explicit `--session-id`.
- [ ] The command performs no writes.
- [ ] Tests verify no DB mutation by comparing row counts before and after report generation.

## Forward-Return Tracker Scope

### Purpose

The forward-return tracker answers:

```text
After a WATCH/SKIP/BUY strategy decision, what happened to price over the next N minutes?
```

This is research instrumentation. It is not a trading command.

### Horizons

Default horizons:

```text
3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h
```

Internal minutes:

```text
3,5,15,30,60,120,240,360,480,720
```

Interpretation:

- `3m` and `5m`: very short-term launch reaction
- `15m` and `30m`: fast confirmation windows
- `1h` and `2h`: intraday follow-through
- `4h`, `6h`, `8h`: day-trading session windows
- `12h`: research window, not a default hold target

### Schema Addition

A small schema migration is recommended for Phase 8.7.

Reason:

Forward-return data is time-series research data. It should be queryable, testable, and auditable.
Storing it inside existing JSON fields would make later analysis fragile.

Add:

```text
backend/src/db/schema/watchlistReturnObservations.ts
```

Add enum values in:

```text
backend/src/db/schema/enums.ts
```

Recommended status values:

```ts
export const watchlistReturnStatusValues = ["PENDING", "OBSERVED", "MISSED", "FAILED"] as const;
```

Recommended table:

```text
watchlist_return_observations
```

Recommended fields:

```text
id text primary key
session_id text not null references sessions(id) on delete cascade
strategy_decision_id text not null references strategy_decisions(id) on delete cascade
token_radar_id text references token_radar(id) on delete set null
mint_address text not null
pair_address text
symbol text
decision text not null
strategy_name text not null
strategy_score integer
horizon_minutes integer not null
baseline_observed_at_ms integer not null
baseline_price_sol text
baseline_price_usd text
baseline_liquidity_usd text
baseline_volume_5m_usd text
baseline_volume_1h_usd text
baseline_source text not null
due_at_ms integer not null
observed_at_ms integer
observed_price_sol text
observed_price_usd text
observed_liquidity_usd text
observed_volume_5m_usd text
observed_volume_1h_usd text
observed_source text
return_pct_sol text
return_pct_usd text
status text not null default PENDING
error_code text
error_message text
raw_data_json text
created_at_ms integer not null
updated_at_ms integer not null
```

Recommended indexes:

```text
idx_watchlist_returns_session_id
idx_watchlist_returns_mint_address
idx_watchlist_returns_strategy_decision_id
idx_watchlist_returns_status
idx_watchlist_returns_due_at_ms
idx_watchlist_returns_horizon_minutes
```

Recommended unique index:

```text
uq_watchlist_returns_decision_horizon(strategy_decision_id, horizon_minutes)
```

### Repository

Add:

```text
backend/src/db/repositories/WatchlistReturnObservationRepository.ts
```

Export it from:

```text
backend/src/db/repositories/index.ts
backend/src/db/repositories/RepositoryFactory.ts
```

Required methods:

```ts
createObservation(input);
upsertObservation(input);
getObservationById(id);
listObservations(sessionId, filter);
listDueObservations(nowMs, filter);
markObserved(id, observedFields);
markFailed(id, failureFields);
markMissed(id, missedFields);
```

Recommended filters:

```text
status
statuses
mintAddress
strategyDecisionId
horizonMinutes
dueFromMs
dueToMs
observedFromMs
observedToMs
limit
```

### Command

Add:

```bash
pnpm watchlist:returns --once
```

Recommended options:

```bash
--session-id=<id>
--since-hours=24
--limit=250
--horizons=3,5,15,30,60,120,240,360,480,720
--source-decisions=WATCH,SKIP,BUY
--min-score=50
--max-late-minutes=120
--dry-run
--json
```

Defaults:

```text
sinceHours = 24
limit = 250
horizons = 3,5,15,30,60,120,240,360,480,720
sourceDecisions = WATCH,SKIP,BUY
minScore = 50
maxLateMinutes = 120
dryRun = false
json = false
```

Session rule:

```text
If --session-id is supplied:
  require PAPER session

If --session-id is not supplied:
  use latest PAPER session with StrategyDecision rows

If none exists:
  fail with a clear message
```

### Suggested Files

```text
backend/src/watchlist/WatchlistReturnConfig.ts
backend/src/watchlist/WatchlistReturnScheduler.ts
backend/src/watchlist/WatchlistReturnObserver.ts
backend/src/watchlist/WatchlistReturnRunner.ts
backend/src/watchlist/WatchlistReturnFormatter.ts
backend/src/watchlist/WatchlistReturnRunner.test.ts
backend/src/scripts/watchlist-returns.ts
```

### Scheduling Behavior

For each selected `StrategyDecision`:

1. Parse `inputSnapshotJson`.
2. Determine baseline price from snapshot first.
3. If snapshot is missing price because the row is older, fall back to the current `TokenRadar`
   price.
4. Create one `PENDING` observation per horizon.
5. Do not duplicate an existing `(strategyDecisionId, horizonMinutes)` observation.

Baseline source values:

```text
STRATEGY_SNAPSHOT
TOKEN_RADAR_FALLBACK
MISSING_BASELINE_PRICE
```

If both `baseline_price_sol` and `baseline_price_usd` are missing:

- create the row only if we want to record the miss, or skip with a clear summary count
- recommended first pass: create `FAILED` with `error_code = MISSING_BASELINE_PRICE`

### Observation Behavior

For each due `PENDING` observation:

1. If `dueAtMs` is in the future, leave it unchanged.
2. If `dueAtMs + maxLateMinutes` is older than now, mark `MISSED`.
3. Otherwise fetch fresh token enrichment by mint address.
4. Prefer DexScreener-backed price/liquidity fields for broad monitoring.
5. Do not require a Jupiter quote for forward-return observation.
6. Calculate available returns:
   - `return_pct_sol` when baseline and observed SOL prices exist
   - `return_pct_usd` when baseline and observed USD prices exist
7. Mark `OBSERVED` when at least one return can be calculated.
8. Mark `FAILED` with a clear error code when provider data is unavailable or unusable.

Recommended failure codes:

```text
MISSING_BASELINE_PRICE
MISSING_OBSERVED_PRICE
PROVIDER_RATE_LIMITED
PROVIDER_ERROR
INVALID_PROVIDER_RESPONSE
UNKNOWN_ERROR
```

### Return Calculation

Use:

```text
returnPct = ((observedPrice - baselinePrice) / baselinePrice) * 100
```

Validation:

- [ ] baseline price must be finite and greater than zero
- [ ] observed price must be finite and greater than zero
- [ ] output should be stored as a decimal string
- [ ] do not round aggressively in storage
- [ ] format to a human-friendly precision only in reports

### Watchlist Report Output

`pnpm watchlist:returns --once` should print:

```text
sessionId
selectedStrategyDecisions
scheduledCount
alreadyScheduledCount
dueCount
observedCount
missedCount
failedCount
dryRun
```

When `--json` is passed, print machine-readable JSON.

### Forward-Return Analytics

`pnpm analytics:report --once` should include return summaries after observations exist:

By horizon:

- pending count
- observed count
- missed count
- failed count
- average return percent
- median return percent if easy to compute in memory
- positive return count
- negative return count
- best return
- worst return

By score bucket and horizon:

- observed count
- average return percent
- positive-return percentage

This is the bridge into Phase 9 learning-oriented orchestration.

## Provider Rate-Limit Handling

Phase 8.7 should not assume a paid Jupiter plan.

Recommended approach:

- Use DexScreener for broad price/liquidity monitoring.
- Use Jupiter only when risk or strategy needs execution-quality quote evidence.
- Keep quote concurrency low.
- Cache quote results briefly when the same mint and amount are requested repeatedly in one cycle.
- Back off after `RATE_LIMITED` responses.
- Measure rate-limit frequency in `analytics:report`.

Potential implementation improvement:

```text
backend/src/providers/http/providerRateLimiter.ts
```

Do not change provider rate limits unless tests show the current limiter is causing self-inflicted
bursting. Phase 8.7's first responsibility is to measure the bottleneck clearly.

## Validation Runs

### Short Local Validation

After implementation:

```bash
pnpm verify
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm analytics:report --once
pnpm watchlist:returns --once
pnpm analytics:report --once
```

Expected:

- [ ] `pnpm verify` passes.
- [ ] Strategy command accepts `--buy-score-threshold=75`.
- [ ] Strategy may still produce zero BUY decisions if gates fail.
- [ ] Analytics report prints current funnel and provider health.
- [ ] Watchlist return command schedules observations for eligible strategy decisions.
- [ ] Analytics report includes pending forward-return rows.

### Longer Paper Observation Window

For a meaningful run, use:

```bash
pnpm scanner:discover --interval-ms=60000 --limit=25 --concurrency=3
```

In another terminal, periodically run:

```bash
pnpm risk:evaluate --once
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm watchlist:returns --once
pnpm analytics:report --once
```

Recommended duration:

```text
at least 30 minutes for 3m, 5m, 15m, and 30m windows
at least 2 hours for 1h and 2h windows
at least 8 hours for the day-trading research windows
12h only when we want extended research data
```

Do not expect 4h, 6h, 8h, or 12h observations to complete during a short validation.

## Acceptance Tests

### Strategy Config Tests

Update:

```text
backend/src/strategy/StrategyConfig.test.ts
```

Required cases:

- [ ] default config includes `buyScoreThreshold = 90`
- [ ] default config includes `watchScoreThreshold = 70`
- [ ] parses `--buy-score-threshold=75`
- [ ] parses `--watch-score-threshold=65`
- [ ] rejects negative thresholds
- [ ] rejects thresholds above 100
- [ ] rejects non-integer thresholds
- [ ] rejects `buyScoreThreshold < watchScoreThreshold`

### Strategy Scoring Tests

Update:

```text
backend/src/strategy/StrategyScoringService.test.ts
```

Required cases:

- [ ] score below 90 but above 75 is WATCH by default
- [ ] score above 75 becomes raw BUY when `buyScoreThreshold = 75`
- [ ] ineligible raw BUY becomes SKIP
- [ ] duplicate raw BUY becomes WATCH
- [ ] max BUY cap raw BUY becomes WATCH
- [ ] missing liquidity still blocks BUY
- [ ] pair age below 30 minutes still blocks BUY
- [ ] high price impact still blocks BUY

### Analytics Tests

Add:

```text
backend/src/analytics/AnalyticsRunner.test.ts
```

Required cases:

- [ ] selects latest paper session when no `--session-id` is supplied
- [ ] supports explicit `--session-id`
- [ ] reports TokenRadar status counts
- [ ] reports risk result counts
- [ ] reports strategy decision counts
- [ ] reports score buckets
- [ ] reports near misses
- [ ] reports missed opportunities after forward-return observations exist
- [ ] reports provider health counts
- [ ] reports Jupiter rate-limited counts
- [ ] supports JSON output
- [ ] performs no writes
- [ ] fails clearly when no eligible session exists

### Watchlist Return Tests

Add:

```text
backend/src/watchlist/WatchlistReturnRunner.test.ts
```

Required cases:

- [ ] schedules observations for WATCH decisions
- [ ] schedules observations for SKIP decisions above `minScore`
- [ ] schedules observations for BUY decisions when present
- [ ] creates one row per horizon
- [ ] does not duplicate existing observation rows
- [ ] uses strategy snapshot baseline price when present
- [ ] falls back to TokenRadar baseline price for older decisions
- [ ] marks missing baseline as FAILED with `MISSING_BASELINE_PRICE`
- [ ] observes due rows with refreshed provider price
- [ ] calculates SOL return percent
- [ ] calculates USD return percent
- [ ] marks stale unobserved rows as MISSED
- [ ] supports dry-run without writes
- [ ] supports JSON output

### Repository Tests

Update:

```text
backend/src/db/repositories/repositories.test.ts
```

Required cases:

- [ ] creates a watchlist return observation
- [ ] lists observations by session
- [ ] lists due observations
- [ ] marks observation as OBSERVED
- [ ] marks observation as FAILED
- [ ] marks observation as MISSED
- [ ] unique `(strategyDecisionId, horizonMinutes)` behavior prevents duplicates

## Documentation Updates

Update:

```text
docs/Structure.md
docs/ROADMAP.md
docs/Phase-9-Planning-Inputs.md
docs/NeXusTrade-Phase-8.7-Detailed-Checklist.md
```

Add architecture docs if implementation grows beyond simple command docs:

```text
docs/architecture/analytics-reporting.md
docs/architecture/watchlist-forward-returns.md
```

Documentation should explain:

- why lowering the BUY threshold is explicit and paper-only
- why the 30-minute age gate remains
- why scanner still discovers younger tokens for learning
- why Jupiter rate limiting is measured before paying for more quota
- how to run a 30-minute, 2-hour, and 8-hour validation
- how to interpret zero BUY decisions after Phase 8.7

## Known Limitations

- A `75` BUY threshold may still produce zero BUYs if candidates fail required gates.
- Forward-return results are observational, not proof of profitable execution.
- DexScreener price observations may not equal executable Jupiter swap prices.
- Jupiter rate limiting can still reduce quote confidence.
- 12-hour returns may include moves outside the intended day-trading window.
- Existing older strategy decisions may lack baseline price fields and require fallback handling.
- Local paper results do not account for all real-world execution risks.

## Phase 9 Handoff

After Phase 8.7, Phase 9 TerminalRunner should orchestrate:

```text
scanner
risk
strategy
watchlist returns
analytics report
paper BUY
session manage
exits manage
```

Initial Phase 9 recommendation:

- keep `buyScoreThreshold = 90` as the default production-like paper setting
- allow explicit calibration runs with `buyScoreThreshold = 75`
- keep ExitManager observe-only by default
- use analytics reports to decide whether strategy thresholds should change permanently
- do not treat a lower test threshold as validated until forward-return data shows positive
  expectancy after fees and simulated slippage

## Milestone Sign-Off Criteria

Phase 8.7 can be marked complete when:

- [ ] default behavior is unchanged
- [ ] calibration behavior is explicit
- [ ] analytics reports are read-only
- [ ] forward-return observations are persisted and queryable
- [ ] provider bottlenecks are quantified
- [ ] at least one short validation run is documented
- [ ] instructions exist for the user to run longer 30-minute, 2-hour, and 8-hour windows
- [ ] Phase 9 planning inputs are updated with real Phase 8.7 outputs
