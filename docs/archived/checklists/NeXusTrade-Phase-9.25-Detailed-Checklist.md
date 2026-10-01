# NeXusTrade Phase 9.25 Detailed Checklist

Research interpretation and skipped-opportunity diagnostics

Last updated: July 2026

## Status

Implemented.

Phase 9.25 is a read-only research interpretation phase. It consumes completed TerminalRunner
archives and explains why candidates became `BUY`, `WATCH`, or `SKIP`, which blockers mattered,
which skipped candidates later moved favorably, and which next research hypothesis is worth testing.

It must not change strategy defaults, provider selection, paper execution, or live trading behavior.

Implementation result:

```text
pnpm research:interpret --once
read-only archive loading
decision attribution
blocker clustering
high-scoring SKIP review
WARN and missing-quote outcome analysis
market-window analysis
per-token missed-opportunity summaries
Phase 9.25 recommendation matrix
```

## Why This Phase Exists

Phase 9.2B made provider evidence trustworthy:

```text
validRuns = 3/3
safety = PASS
oneSession = yes
orders/fills/positions = 0
observedDecisions = 468
uniqueMints = 35
readiness = PROMISING_RESEARCH
confidence = MEDIUM
paperBuyAutomationEnabled = no
```

Provider truthing worked:

```text
Jupiter metadata pressure = eliminated
Jupiter operation = quote only
Jupiter live rate limit = 15.92%
Jupiter combined rate limit = 44.68%
router cooldown skips = 1311
quote cache hits = 159
DexScreener live rate limit = 0%
Helius live rate limit = about 0.17%
```

The remaining question is not "is Jupiter broken?" It is:

```text
Which candidates were actually attractive?
Which blockers caused promising candidates to be skipped?
Which evidence should influence Phase 9.3, Phase 9.26, or a future controlled paper pilot?
```

## Current Evidence To Preserve

Phase 9.2B aggregate:

```text
BUY55 observedBUY = 459
BUY65 observedBUY = 211
BUY75 observedBUY = 37

BUY65 hit10 = 76.3033%
BUY65 avgBest = +86.6676%
BUY65 avgWorst = -31.4267%

BUY75 hit10 = 83.7838%
BUY75 avgBest = +135.4710%
BUY75 avgWorst = -35.8727%
```

Scenario portfolio remained weak:

```text
best visible scenario ~= +0.002 SOL / +0.2%
goalReached = no
```

Promotion blockers:

```text
target-first wins too concentrated in one run = 48.30%
no shadow-entry profile clears promotion gates
drawdowns remain too large for paper automation
```

## Non-Goals

Phase 9.25 must not:

- enable paper BUY automation,
- call `paper:execute`,
- create orders, fills, or positions,
- change production strategy score weights,
- change default strategy thresholds,
- promote a strategy profile,
- add Raydium,
- add Birdeye,
- add Titan, Autobahn, Meteora, or Orca,
- add database migrations,
- write to archived run databases,
- mutate `TokenRadar`, `RiskAssessment`, or `StrategyDecision`,
- introduce machine learning,
- implement counterfactual decision analysis,
- treat simulated shadow outcomes as realized P/L.

Counterfactual decision analysis stays future Phase 9.26 or Phase 10.

## Command Shape

Add a new command rather than extending `research:aggregate`:

```bash
pnpm research:interpret --once \
  --label-run=T1:data/archive/phase9.2B/test1-phase9.2B-test1-20260713-1856 \
  --label-run=T2:data/archive/phase9.2B/test2-phase9.2B-test2-20260714-0950 \
  --label-run=T3:data/archive/phase9.2B/test3-phase9.2B-test3-20260714-1421
```

Rationale:

- `research:aggregate` answers "is the run batch valid and promotable?"
- `research:interpret` answers "why did candidates behave this way?"
- Keeping them separate prevents one large report from becoming hard to reason about.

Recommended options:

```text
--once
--json
--label-run=<label>:<archivePath>       repeatable
--output-dir=<path>
--min-score=50
--source-decisions=BUY,WATCH,SKIP
--target-pcts=10,15,25
--stop-pcts=10,15,25
--max-hold-minutes=15,30,60
--top-opportunities=25
--top-blockers=20
--market-window-minutes=60
--score-bucket-size=5
--dedupe-mode=decision|mint|first_per_mint|best_per_mint
```

Default inputs should match Phase 9.1/9.2B research defaults unless there is a clear reason to
diverge. Default `dedupeMode` is `decision`.

## Proposed Files

Add:

```text
backend/src/research-interpretation/ResearchInterpretationConfig.ts
backend/src/research-interpretation/ResearchInterpretationTypes.ts
backend/src/research-interpretation/DecisionAttributionService.ts
backend/src/research-interpretation/BlockerAnalysisService.ts
backend/src/research-interpretation/OpportunityAnalysisService.ts
backend/src/research-interpretation/MarketWindowAnalysisService.ts
backend/src/research-interpretation/ProviderInterpretationService.ts
backend/src/research-interpretation/ResearchInterpretationRunner.ts
backend/src/research-interpretation/ResearchInterpretationReportFormatter.ts
backend/src/scripts/research-interpret.ts
backend/src/research-interpretation/*.test.ts
```

Modify:

```text
backend/package.json
package.json
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/Provider-Strategy-Phase9Plus.md
```

Reuse:

```text
backend/src/research/ResearchRunArchiveLoader.ts
backend/src/shadow-entry/ShadowEntryCandidateLoader.ts
backend/src/calibration/ScoreAttributionService.ts
backend/src/shadow-calibration/ShadowCalibrationReportService.ts
```

## Output Report Sections

The text and JSON reports should include:

```text
Safety
Inputs
Run Validity Snapshot
Decision Attribution Summary
Top Blockers
High-Scoring SKIP Review
WARN Outcome Analysis
Missing Quote Outcome Analysis
Market Window Analysis
Per-Token Missed Opportunities
Provider Interpretation
Phase 9.25 Recommendation Matrix
```

## Implementation Chunks

### 1. Config And CLI

Implement `ResearchInterpretationConfig.ts`.

Validation rules:

- `--once` is accepted but no loop mode is needed.
- At least one `--label-run` is required.
- Labels must be unique.
- Archive paths must point to directories.
- `minScore` must be `0..100`.
- `targetPcts`, `stopPcts`, and `maxHoldMinutes` must be non-empty positive number lists.
- `sourceDecisions` must be valid strategy decisions.
- `marketWindowMinutes` must be positive.
- `topOpportunities` and `topBlockers` must be positive integers.
- `dedupeMode` must be one of `decision`, `mint`, `first_per_mint`, or `best_per_mint`.

Add scripts:

```json
{
  "research:interpret": "pnpm --filter @nexustrade/backend research:interpret"
}
```

Acceptance tests:

- Parses multiple `--label-run` values.
- Rejects duplicate labels.
- Rejects missing labels.
- Rejects invalid score, target, stop, hold, decision, and dedupe options.

### 2. Archive Loading And Candidate Normalization

Use the existing archive and candidate loaders:

```text
loadResearchRunArchives()
loadShadowEntryRuns()
ScoreAttributionService.explain()
```

Build a normalized interpretation candidate with:

```text
runLabel
sessionId
decisionId
mintAddress
symbol
decision
score
rawDecision
buyEligible
duplicateBuyBlocked
maxBuyCapBlocked
riskResult
riskFlags
missingQuote
missingAuthorityEvidence
missingPriceImpact
liquidityUsd
volume5mUsd
volume1hUsd
ageSeconds
maxPriceImpactPct
factor contributions
blocking factors
observed return points
best return
worst return
target-before-stop outcomes
repeated attention strength
```

Dedupe modes:

```text
decision       one row per StrategyDecision, default
mint           one aggregate row per mint
first_per_mint first observed decision per mint
best_per_mint  decision with best observed return per mint
```

Rules:

- Do not mutate archives.
- Skip report-only archives unless enough decision rows are available.
- Candidates without observed returns should remain in the report as coverage gaps.
- `decision` mode is the default because it preserves attribution and timing detail.
- `mint`, `first_per_mint`, and `best_per_mint` modes exist to check whether one hot token or one
  repeated rediscovery sequence is dominating the conclusions.
- Reports must display the active dedupe mode in text and JSON.

Acceptance tests:

- Loads current Phase 9.2B archive shape.
- Produces candidates with score attribution and observed return points.
- Leaves candidates without returns visible as unobserved.
- Supports every dedupe mode without changing archive data.

### 3. Decision Attribution

Implement `DecisionAttributionService.ts` or extend the existing attribution output into a
Phase 9.25-specific shape.

For every `BUY`, `WATCH`, and `SKIP`, report:

```text
score component contributions
positive factors
negative or zero-point factors
warnings
first blocking factor
highest-impact blocking factor
human-readable blocker category
```

Suggested blocker categories:

```text
RISK_NOT_PASS
MISSING_QUOTE
MISSING_AUTHORITY_EVIDENCE
MISSING_PRICE_IMPACT
LOW_LIQUIDITY
LOW_VOLUME
PAIR_TOO_NEW
PRICE_IMPACT_TOO_HIGH
DUPLICATE_BUY
MAX_BUY_CAP
SCORE_BELOW_BUY
SCORE_BELOW_WATCH
SCORE_THRESHOLD_ONLY
UNRESOLVED_STRATEGY_GATE
UNKNOWN
```

Rules:

- `firstBlockingFactor` should preserve strategy rule order.
- `highestImpactBlockingFactor` should use the largest lost/negative factor when available.
- If factor points are all non-negative, choose the most decision-relevant blocker by category
  priority.
- If `decision = SKIP` and `blockers = none`, do not emit `UNKNOWN` by default.
- If `decision = SKIP`, `blockers = none`, and the score is below the configured BUY/WATCH gate,
  classify the skip as `SCORE_THRESHOLD_ONLY`.
- If `decision = SKIP`, `blockers = none`, and the score does not explain the skip, classify it as
  `UNRESOLVED_STRATEGY_GATE`.
- Do not infer "would have bought" outcomes in Phase 9.25.

Example row:

```text
Mint: SUNNYS
Decision: SKIP
Score: 65
Risk: WARN
Primary blocker: MISSING_QUOTE
Secondary blocker: MISSING_AUTHORITY_EVIDENCE
Liquidity: PASS
Volume: PASS
Age: PASS
```

Acceptance tests:

- Correctly identifies missing quote as a blocker.
- Correctly identifies duplicate BUY prevention.
- Correctly identifies risk WARN/FAIL blockers.
- Classifies `SKIP` with `blockers = none` as `SCORE_THRESHOLD_ONLY` or
  `UNRESOLVED_STRATEGY_GATE`, not generic `UNKNOWN`.
- Preserves factor contribution totals.

### 4. Top Blocker And SKIP Reason Clustering

Implement blocker aggregation:

```text
by blocker category
by decision
by score bucket
by risk result
by run
by target-before-stop outcome
```

Report for each blocker:

```text
count
unique mints
average score
average best return
average worst return
hit10/hit15/hit25
drawdown-first rates
observed return coverage
example mints
```

Acceptance tests:

- Counts candidates by primary blocker.
- Does not double-count scenario-expanded rows.
- Preserves unique-mint counts.

### 5. High-Scoring SKIP Review

Define high-scoring SKIP default:

```text
decision = SKIP
score >= 65
```

Report:

```text
top high-scoring SKIPs sorted by best return
top high-scoring SKIPs sorted by score
top high-scoring SKIPs sorted by repeated attention strength
```

Each row should include:

```text
mint
symbol
score
run
decidedAt
primary blocker
highest-impact blocker
best return
worst return
target-before-stop summary
quote availability
risk result
liquidity/volume/age
repeated attention strength
```

Rules:

- Clearly label these as missed-opportunity candidates, not trades.
- Include worst return beside best return so pumps with ugly drawdown are not overvalued.

Acceptance tests:

- High-scoring SKIPs appear even when decision is not `BUY`.
- Sorting by best return and score is deterministic.

### 6. WARN Outcome Analysis

Group candidates by WARN-related evidence:

```text
riskResult = WARN
MISSING_AUTHORITY_EVIDENCE
MISSING_QUOTE
MISSING_PRICE_IMPACT
authority unknown
quote missing
quote cache/cooldown context if available
```

Report:

```text
WARN count
unique mints
average score
average best return
average worst return
hit rates
drawdown-first rates
top example winners
top example losers
```

Purpose:

Determine whether WARN is too conservative, correctly cautious, or mixed by specific warning type.

Acceptance tests:

- Separates missing quote WARN from missing authority WARN.
- Produces outcome stats for each WARN subgroup.

### 7. Missing Quote Outcome Analysis

Use cleaned Phase 9.2B provider evidence.

Report:

```text
missing_quote vs quote_available
live Jupiter rate-limit context
cache hit context
cooldown skip context
score bucket comparison
decision comparison
best/worst return comparison
```

Rules:

- Missing quote is evidence uncertainty, not automatic token quality failure.
- Cache hits should be counted as quote confidence but labeled as cached.
- Cooldown skips should not be counted as live provider failure.

Acceptance tests:

- Missing quote candidates are grouped separately from quote-available candidates.
- Cached quote rows do not inflate live rate-limit metrics.

### 8. Market Window Analysis

Implement run/window grouping:

```text
run label
hour-of-day UTC/local if available
configurable window size, default 60 minutes
```

Report:

```text
observed decisions per window
unique mints per window
target-first wins per window
best/worst return per window
dominant run/window share
profile-readiness implications
```

Purpose:

Identify whether the results came from repeatable strategy signal or one favorable market window.

Acceptance tests:

- Computes dominant market-window share.
- Handles runs with zero observed decisions.
- Does not promote based on one bullish window.

### 9. Per-Token Missed Opportunity Breakdown

Aggregate by mint:

```text
all decisions for mint
first decision
latest decision
highest score
best return
worst return
repeated attention strength
decision sequence
primary blockers seen
```

Report top tokens by:

```text
best return
target-before-stop wins
repeated attention strength
high score but skipped
```

Acceptance tests:

- Multiple decisions for the same mint collapse into one token summary.
- The report preserves decision-level detail in JSON.

### 10. Provider Interpretation

Summarize provider data from TerminalRunner and ProviderHealth:

```text
live provider rows
router rows
live rate-limited percent
combined rate-limited percent
cache hits
cooldown skips
operation breakdown
candidate outcome split by quote evidence
```

Phase 9.25 should answer:

```text
Did provider availability explain skipped winners?
Did quote cache improve useful coverage?
Is Raydium likely to help next?
Or are blockers mostly strategy/risk/timing?
```

Rules:

- Provider recommendations are advisory only.
- Do not add Raydium in this phase.

Acceptance tests:

- Jupiter metadata pressure remains absent from Phase 9.2B interpretation.
- Live-vs-router metrics render in text and JSON.

### 11. Report Formatting

Text output should be concise enough to read in terminal.

JSON output should be complete enough for later dashboard work.

Recommended text report limits:

```text
top blockers = 20
top missed opportunities = 25
top token summaries = 25
top market windows = 10
```

JSON should include full arrays unless a limit is explicitly configured.

Acceptance tests:

- Text formatter includes all major sections.
- JSON formatter emits stable keys.
- Report is deterministic for identical input.

### 12. Phase 9.25 Recommendation Matrix

The report should end with one explicit primary recommendation plus supporting evidence.

```text
A. Proceed to Phase 9.26 counterfactual analysis
B. Proceed to Phase 9.3 Raydium fallback
C. Tune shadow-entry profiles
D. Collect more data
E. Prepare separate controlled paper pilot review
```

Each recommendation row should include:

```text
recommendationCode
label
selected = yes/no
evidenceFor
evidenceAgainst
requiredNextAction
safetyCaveat
```

Rules:

- Recommendation text must not imply paper BUY automation is enabled.
- Exactly one primary recommendation must be selected.
- If a profile looks promising, recommend a separate promotion review.
- If provider quote uncertainty dominates, recommend provider work.
- If blockers are mostly risk/timing/drawdown, recommend interpretation or profile work before
  providers.
- If evidence is mixed or sample size is weak, recommend more data rather than provider or strategy
  changes.

Acceptance tests:

- Controlled paper pilot recommendation remains false unless future promotion criteria are met.
- Report explicitly says paper BUY automation is disabled.
- Report emits all five recommendation options in text and JSON.
- Report selects exactly one primary recommendation.

## Safety Acceptance Criteria

Phase 9.25 passes safety if:

```text
database access is read-only for archives
orders = 0
fills = 0
positions = 0
paper BUY automation = disabled
wallet loaded = no
transaction signing = disabled
transaction submission = disabled
no strategy defaults changed
no provider adapters added
```

## Verification Commands

Required:

```bash
corepack pnpm verify
```

Focused checks:

```bash
corepack pnpm --filter @nexustrade/backend test -- research-interpretation
corepack pnpm --filter @nexustrade/backend typecheck
```

Manual smoke:

```powershell
corepack pnpm research:interpret --once `
  --label-run=T1:data/archive/phase9.2B/test1-phase9.2B-test1-20260713-1856 `
  --label-run=T2:data/archive/phase9.2B/test2-phase9.2B-test2-20260714-0950 `
  --label-run=T3:data/archive/phase9.2B/test3-phase9.2B-test3-20260714-1421
```

Optional artifact output:

```powershell
corepack pnpm research:interpret --once `
  --label-run=T1:data/archive/phase9.2B/test1-phase9.2B-test1-20260713-1856 `
  --label-run=T2:data/archive/phase9.2B/test2-phase9.2B-test2-20260714-0950 `
  --label-run=T3:data/archive/phase9.2B/test3-phase9.2B-test3-20260714-1421 `
  --output-dir=data/phase9.25-interpretation
```

## Post-Implementation Validation

Use the existing three Phase 9.2B full runs first.

Validation success means:

```text
Report explains top high-scoring SKIPs.
Report identifies primary blocker clusters.
Report separates WARN/missing quote/missing authority outcomes.
Report identifies whether market-window concentration remains the primary blocker.
Report explains whether Raydium is likely to help before Phase 9.3.
Report remains read-only and safe.
```

Validated against the three archived Phase 9.2B full runs:

```powershell
corepack pnpm --filter @nexustrade/backend research:interpret --once `
  --label-run=T1:data/archive/phase9.2B/test1-phase9.2B-test1-20260713-1856 `
  --label-run=T2:data/archive/phase9.2B/test2-phase9.2B-test2-20260714-0950 `
  --label-run=T3:data/archive/phase9.2B/test3-phase9.2B-test3-20260714-1421
```

Smoke result:

```text
candidates = 468
observed decisions = 468
unique mints = 35
orders/fills/positions = 0
oneSession = yes for all three runs
paper BUY automation = disabled
selected recommendation = Phase 9.3 Raydium fallback, based on missing quote share/provider evidence
```

No new long TerminalRunner runs are required to validate the implementation. New runs may be useful
after the first interpretation report reveals which hypothesis needs more evidence.

## Handoff To Later Phases

Possible next phases after Phase 9.25:

```text
Phase 9.26 - Counterfactual Decision Analysis
Phase 9.3  - Raydium direct quote fallback
Phase 9.31 - Provider-aware quote confidence experiments
Phase 9.4  - Birdeye selective enrichment
Phase 10   - Dashboard consuming interpretation JSON
```

Phase 9.25 should recommend the next phase based on evidence, not roadmap inertia.
