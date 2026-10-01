# NeXusTrade Phase 9.26 Detailed Checklist

Counterfactual decision analysis

Last updated: August 2026

## Status

Implemented and archive-smoke validated on the three Phase 9.4D archives.

Implementation closeout:

- Added `pnpm research:counterfactual --once` as an archive-only command.
- Replays persisted score, threshold, factor, eligibility, duplicate, and cap facts without reading
  live providers or an active paper database.
- Reports exact/partial/mismatch/not-replayable baseline fidelity before any scenario finding.
- Applies one named scenario at a time, including explicit `NOT_EVALUABLE` handling for missing
  quote/price-impact or authority evidence.
- Emits bounded text/JSON artifacts only when `--output-dir` is supplied.
- Archive smoke: 844/844 baseline rows exactly reproduced; orders/fills/positions and provider
  calls remained zero. The 65/60 threshold sensitivity promoted 27 rows but was highly
  concentrated (74.07% one mint; 81.48% one run), so it does not authorize a strategy change.

Implementation note: historical snapshots persist the final score inputs and decision controls, but
not every complete strategy-runtime object. Phase 9.26 therefore replays those persisted facts with
the same deterministic score-threshold and eligibility sequence rather than reconstructing market
state or invoking live scoring dependencies.

For this phase, `best_per_mint` is input-safe: it selects the highest stored score for a mint, then
the earliest decision as a tie-breaker. It never uses later forward returns to select replay input.

Phase 9.26 is a read-only research phase. It will replay recorded strategy decisions from completed
PAPER/shadow-only archives, apply one declared hypothetical change at a time, and show whether the
recorded decision would have remained the same, changed to `WATCH`, changed to `BUY`, or could not
be evaluated safely.

It does not change a strategy default, a shadow-entry profile, a provider, a quote budget, a
database row, or a paper-trading action.

## Why This Phase Exists

Phase 9.4D completed three valid, independent 120-minute PAPER/shadow-only runs:

```text
valid runs:                         3 / 3
TerminalRunner cycles:              195
orders/fills/positions:             0 / 0 / 0
quote candidates selected:          3,900
quote candidates not selected:      1,814
selected quote coverage:            96.44%
Jupiter upstream live 429:          0.00%
observed decisions:                 850
unique mints:                       30
promotion gate:                     PROMISING_RESEARCH / MEDIUM confidence
controlled paper pilot:             no
```

Provider capacity is no longer the dominant research constraint. The remaining question is why
otherwise observable candidates did not advance under the recorded strategy settings. In the
three-run interpretation report, 27 SKIP rows were classified as `UNRESOLVED_STRATEGY_GATE`, and
25 high-scoring SKIP examples merit a more precise explanation.

Phase 9.26 answers a bounded research question:

```text
Recorded decision at time T
-> reproduce the decision from its stored facts and stored configuration
-> change one named gate or threshold policy only
-> recompute the decision from the same time-T facts
-> attach later observed returns as evaluation data, never as decision input
```

## Objective

Build a deterministic, archive-only counterfactual report that can distinguish:

```text
no change
decision changed because of a recorded threshold
decision changed because one explicit eligibility gate was hypothetically lifted
decision changed because duplicate/max-buy policy was isolated
not evaluable because the original evidence is incomplete
```

The report must make it obvious which results are direct replays and which are sensitivity
experiments. It must never present a hypothetical BUY as a completed or profitable trade.

## Safety Boundary

Phase 9.26 may:

- Read completed archive directories and their database snapshots in read-only mode.
- Reuse recorded `StrategyDecision`, `RiskAssessment`, `TokenRadar`, score-attribution, and
  watchlist-return evidence.
- Recompute a deterministic strategy decision in memory from time-of-decision facts.
- Write optional text and JSON reports to a user-supplied output directory.
- Add pure services, parsers, formatters, tests, scripts, and documentation.

Phase 9.26 must not:

- Call any live provider, including DexScreener, Jupiter, Raydium, Birdeye, RPC, DAS, or Helius.
- Open or write to an active paper database or write to an archived database.
- Create or update sessions, TokenRadar rows, risk assessments, strategy decisions, orders, fills,
  positions, snapshots, provider-health rows, or system logs.
- Enable `paper:execute`, `paper:sell`, `exits:manage`, wallet loading, signing, transaction
  construction, or transaction submission.
- Change strategy scoring weights, production thresholds, shadow-entry profiles, exit rules,
  provider order, provider quotas, or quote-budget settings.
- Use observed future returns, future price points, or later decisions as an input to a replay.
- Create multi-factor "make everything pass" scenarios in the first pass.
- Claim expected profit, realized P/L, tradability, or promotion readiness from a counterfactual
  result alone.
- Add a database migration or a persistent counterfactual-results table.

All terminal text and JSON must state:

```text
MODE: PAPER research
archive access: read-only
database writes: disabled
provider calls: disabled
paper execution: disabled
wallet loaded: no
transaction signing: disabled
transaction submission: disabled
```

## Locked Design Decisions

```text
Command:                    pnpm research:counterfactual --once
Data source:                one or more completed archive directories only
Default decisions:          SKIP,WATCH
Default dedupe mode:        decision
Replay basis:               time-of-decision snapshot and recorded configuration
Baseline requirement:       reproduce first, hypothesize second
Intervention scope:         exactly one named intervention per result row
Forward returns:            outcome-only; never replay input
Default output:             text report; optional JSON and output directory
Archive writes:             none
Active database writes:     none
Provider calls:             none
Paper execution:            disabled
```

The first release deliberately does not support arbitrary free-form threshold overrides or
combinatorial scenario generation. Every scenario must have a named, versioned policy and a
machine-readable explanation.

## Counterfactual Vocabulary

### Replay Fidelity

`baseline replay` means evaluating the decision again using the archived decision-time facts and
the recorded strategy configuration. It is not a new strategy simulation.

```text
REPRODUCED
  Replayed decision equals the stored decision and the replayed score matches the stored score
  when both are available.

PARTIALLY_REPRODUCED
  The decision matches, but a score or an optional input is absent or cannot be verified exactly.

MISMATCH
  The replay result differs from the stored decision or score for a documented reason.

NOT_REPLAYABLE
  The archive does not preserve enough time-T evidence to run a safe replay.
```

`MISMATCH` and `NOT_REPLAYABLE` rows are reportable coverage results. They must not receive a
counterfactual promotion result by default.

### Evidence Quality

Every counterfactual row must carry one of these labels:

```text
DIRECT
  The scenario changes only a recorded policy value, such as a named score threshold or duplicate
  policy, while retaining all observed time-T facts.

GATE_OVERRIDE
  The scenario treats one named eligibility gate as passing. It is a sensitivity result, not proof
  that absent or failed market evidence would have become favorable.

NOT_EVALUABLE
  The required decision-time fact or snapshot is absent, malformed, or ambiguous. No alternate
  decision is produced.
```

### Outcome Status

```text
UNCHANGED
PROMOTED_TO_WATCH
PROMOTED_TO_BUY
DEMOTED_TO_SKIP
BLOCKED_BY_ANOTHER_GATE
NOT_EVALUABLE
```

The `PROMOTED_TO_BUY` label means only that the in-memory strategy replay would have yielded BUY
under that single declared scenario. It is not an order, a fill, a position, or a profitable trade.

## Scenario Catalog

Implement a compact, explicitly named initial catalog. Each candidate receives only scenarios that
are relevant to an identified recorded blocker.

```text
SCORE_THRESHOLD_75_70
  Use BUY=75 and WATCH=70 with all recorded time-T facts and eligibility gates unchanged.

SCORE_THRESHOLD_65_60
  Use BUY=65 and WATCH=60 with all recorded time-T facts and eligibility gates unchanged.

DUPLICATE_BUY_DISABLED
  Remove only duplicate-BUY prevention while preserving all other facts, gates, and the recorded
  max-buy-cap state.

MAX_BUY_CAP_DISABLED
  Remove only the max-BUY-per-run cap while preserving all other facts, gates, and duplicate state.

RISK_ELIGIBILITY_OVERRIDE
  Treat the recorded risk-eligibility gate as passing. This is `GATE_OVERRIDE` evidence.

LIQUIDITY_GATE_OVERRIDE
  Treat the recorded liquidity gate as passing. This is `GATE_OVERRIDE` evidence.

VOLUME_GATE_OVERRIDE
  Treat the recorded volume gate as passing. This is `GATE_OVERRIDE` evidence.

PAIR_AGE_GATE_OVERRIDE
  Treat the recorded pair-age gate as passing. This is `GATE_OVERRIDE` evidence.

PRICE_IMPACT_GATE_OVERRIDE
  Treat the recorded price-impact gate as passing. This is `GATE_OVERRIDE` evidence.
```

Rules:

- Do not emit a gate override when the factor was not recorded or cannot be identified.
- A scenario may not overwrite another failed gate. Report `BLOCKED_BY_ANOTHER_GATE` instead.
- `SCORE_THRESHOLD_*` scenarios must use a named immutable threshold pair, never a hidden score
  adjustment.
- `DUPLICATE_BUY_DISABLED` and `MAX_BUY_CAP_DISABLED` are valid only when the corresponding
  recorded decision attribute is true.
- Quote or authority scenarios must not fabricate a quote, price impact, authority state, or risk
  flag. In Phase 9.26 those become `NOT_EVALUABLE` until a later evidence-backed policy is designed.
- No scenario changes entry time, buy size, fees, slippage, fill probability, exit rule, or
  position concurrency.
- No scenario may be selected because of its later forward return.

The catalog is a research policy version, for example `counterfactual-v1`. A future modification
must add a version rather than silently changing historical scenario meaning.

## Input Contract And Normalization

Reuse existing archive loaders before adding new database access:

```text
backend/src/research/ResearchRunArchiveLoader.ts
backend/src/shadow-entry/ShadowEntryCandidateLoader.ts
backend/src/research-interpretation/DecisionAttributionService.ts
backend/src/calibration/ScoreAttributionService.ts
backend/src/strategy/StrategyScoringService.ts
```

Extend the normalized research candidate only as needed to retain:

```text
runLabel
sessionId
decisionId
mintAddress
symbol
decidedAtMs
storedDecision
storedScore
storedReason
strategyName
strategyInputSnapshot
recorded strategy thresholds and eligibility policy when present
risk result and risk flags
recorded liquidity, volume, pair age, and price-impact facts
factor contributions and pass/fail state
duplicateBuyBlocked
maxBuyCapBlocked
missingQuote / missing authority / missing price-impact indicators
observed return points and target-before-stop outcomes
```

Normalization rules:

- Use only data whose effective timestamp is at or before `decidedAtMs` for replay facts.
- Prefer `StrategyDecision.inputSnapshotJson` and its recorded configuration. Fall back to linked
  archival risk/token evidence only when the fallback is documented in the row.
- Do not infer missing time-T facts from a later TokenRadar, RiskAssessment, or watchlist record.
- Preserve malformed snapshots as structured `NOT_REPLAYABLE` coverage results with a sanitized
  reason; never discard them silently.
- Preserve the existing interpretation dedupe options: `decision`, `mint`, `first_per_mint`, and
  `best_per_mint`. Default remains `decision`.
- Use a deterministic order: run label, `decidedAtMs`, mint address, decision id.

## Replay Engine

Add a pure replay service, for example:

```text
backend/src/research-counterfactual/CounterfactualReplayService.ts
backend/src/research-counterfactual/CounterfactualScenarioCatalog.ts
backend/src/research-counterfactual/CounterfactualTypes.ts
```

The service must:

1. Build a baseline `StrategyScoringService` input from the normalized time-T candidate.
2. Evaluate the baseline with the archived strategy configuration.
3. Compare baseline output with the stored decision and score to produce replay fidelity.
4. Stop scenario evaluation for `MISMATCH` or `NOT_REPLAYABLE` rows unless an explicitly safe
   diagnostic-only mode is added later.
5. For each relevant named scenario, copy the baseline input and alter exactly one scenario-policy
   field or one declared gate state.
6. Re-run the same deterministic scoring and decision-override sequence.
7. Record the alternate decision, score delta, changed factor, remaining blockers, evidence quality,
   and outcome status.
8. Attach already-stored forward-return observations only after the alternate decision is known.

The replay service must not call a repository, wall clock, random generator, provider, cache, or
filesystem API.

### Fidelity Handling

Exact score reproduction is expected when the input snapshot includes all strategy facts and
thresholds. Historical archives may predate richer snapshots, so the report must separate:

```text
exactly reproduced rows
decision-only reproduced rows
mismatched rows
not-replayable rows
```

Before drawing any promotion or threshold conclusion, report replay coverage and fidelity. A
scenario group with poor baseline fidelity is diagnostic only.

## Report Contract

Add a dedicated command and formatter rather than expanding `research:interpret` again:

```bash
pnpm research:counterfactual --once \
  --label-run=Full1:data/archive/phase9.4D/full1-phase9.4D-full1-20260812-1820 \
  --label-run=Full2:data/archive/phase9.4D/full2-phase9.4D-full2-20260813-1428 \
  --label-run=Full3:data/archive/phase9.4D/full3-phase9.4D-full3-20260813-1820
```

Recommended options:

```text
--once
--json
--label-run=<label>:<archivePath>       repeatable; required
--output-dir=<path>
--source-decisions=SKIP,WATCH
--min-score=50
--dedupe-mode=decision|mint|first_per_mint|best_per_mint
--scenario-set=default|thresholds|gates|policies
--scenario-id=<catalog-id>              repeatable, optional narrow filter
--top-results=25
--target-pcts=10,15,25
--stop-pcts=10,15,25
--max-hold-minutes=15,30,60
```

Configuration validation:

- Require at least one unique `--label-run`.
- Require a valid, readable archive directory; never fall back to the active database.
- Reject unsupported scenario ids and empty scenario selections.
- Reject invalid decision names, score ranges, result limits, target/stop lists, and hold lists.
- Treat `--scenario-set` and `--scenario-id` as an intersection when both are supplied.
- Reject an option that requests more than one intervention per result. Do not add a bypass flag.
- Default output is bounded text; JSON must be structured and free of raw provider payloads,
  secrets, raw URLs, request headers, and database connection strings.

Text and JSON reports must include:

```text
Safety Boundary
Inputs And Catalog Version
Run Validity
Baseline Replay Fidelity
Scenario Coverage
Counterfactual Outcome Summary
Scenario Impact By Decision / Score Bucket / Mint
High-Impact Promotion Candidates
Remaining-Blocker Analysis
Forward-Return Evaluation (outcome-only)
Market-Window And Mint Concentration
Not-Evaluable Coverage
Counterfactual Recommendation Matrix
Limitations
```

### Required Metrics

For each scenario and evidence-quality class, report:

```text
input candidates
baseline reproduced / partial / mismatch / not replayable
scenario evaluated
unchanged
promoted to WATCH
promoted to BUY
blocked by another gate
not evaluable
unique mints
score distribution
observed 10/15/25% target-first rates
observed drawdown-first rates
average best and worst forward return
market-window win concentration
single-mint concentration
```

Forward-return metrics must be explicitly labeled post-hoc and must include their observed sample
size. They are not an estimate of executable performance because no fill, fee, slippage, latency,
or exit behavior is replayed.

### Candidate-Level Explanation

Each top result should read like this:

```text
Candidate: CHATJIPITI
Recorded: SKIP, score 65
Baseline replay: REPRODUCED
Scenario: SCORE_THRESHOLD_65_60 (DIRECT)
Counterfactual: WATCH
Changed factor: watch score threshold 70 -> 60
Remaining blockers: none
Observed outcomes: best +X%, worst -Y%, target-first 10%=yes
Interpretation: threshold sensitivity only; not a trade recommendation
```

For a gate override:

```text
Scenario: VOLUME_GATE_OVERRIDE (GATE_OVERRIDE)
Counterfactual: BUY
Remaining blockers: none
Interpretation: sensitivity to volume policy; does not prove low-volume tokens are suitable
```

## Recommendation Matrix

The report must finish with exactly one evidence-backed primary recommendation and supporting
alternatives:

```text
A. Collect more unchanged archives
B. Plan a narrow shadow-profile experiment
C. Plan a documented strategy-threshold experiment
D. Investigate missing snapshot/replay-fidelity coverage
E. Defer action because evidence is weak or concentrated
F. Prepare a separate promotion review only after its gates pass
```

The report must not recommend paper execution directly. A promotion review remains a distinct
future decision after a documented profile experiment and enough unconcentrated evidence.

## Proposed Files

Add:

```text
backend/src/research-counterfactual/CounterfactualConfig.ts
backend/src/research-counterfactual/CounterfactualTypes.ts
backend/src/research-counterfactual/CounterfactualScenarioCatalog.ts
backend/src/research-counterfactual/CounterfactualReplayService.ts
backend/src/research-counterfactual/CounterfactualAnalysisService.ts
backend/src/research-counterfactual/CounterfactualReportFormatter.ts
backend/src/research-counterfactual/CounterfactualRunner.ts
backend/src/research-counterfactual/*.test.ts
backend/src/scripts/research-counterfactual.ts
```

Modify:

```text
package.json
backend/package.json
docs/ROADMAP_Phase9Plus.md
docs/Structure_Phase9Plus.md
docs/Phase-9-Planning-Inputs.md
docs/DECISIONS_Phase9Plus.md
docs/NeXusTrade-Phase-9.26-Detailed-Checklist.md
```

Reuse without changing their production semantics:

```text
backend/src/research/ResearchRunArchiveLoader.ts
backend/src/shadow-entry/ShadowEntryCandidateLoader.ts
backend/src/research-interpretation/DecisionAttributionService.ts
backend/src/strategy/StrategyScoringService.ts
backend/src/strategy/rules/*
backend/src/calibration/ScoreAttributionService.ts
```

No database schema, migration, repository write method, provider adapter, TerminalRunner stage, or
active-paper command should be added.

## Implementation Chunks

### Chunk 1 - Types, Config, And Command Surface

- Add the `research-counterfactual` module and strict runtime configuration parser.
- Define scenario ids, evidence quality, replay fidelity, outcome status, candidate, scenario, and
  report contracts.
- Add `research:counterfactual` scripts at backend and root levels.
- Add unit tests for every option, unique labels, scenario filters, output-dir validation, and
  rejection of unknown or multi-intervention requests.

Complete when:

```text
pnpm research:counterfactual --once --label-run=... parses only valid archive-only input
no code path opens an active database or provider registry
```

### Chunk 2 - Immutable Candidate Snapshot Loader

- Reuse archive loading and candidate loading rather than duplicating database queries.
- Parse and validate strategy input snapshots with safe fallbacks.
- Build normalized decision-time facts and record their provenance.
- Preserve incomplete rows as non-fatal coverage entries.
- Add fixtures representing current Phase 9.4D archive shape and historical partial snapshots.

Complete when:

```text
time-T fact provenance is explicit
later return observations never populate replay input
malformed or incomplete snapshots are visible as NOT_REPLAYABLE
```

### Chunk 3 - Baseline Replay Fidelity

- Construct a pure `StrategyScoringService` input from the normalized archive candidate.
- Evaluate using the archived configuration whenever available.
- Compare stored and replayed decision/score without mutating the source row.
- Categorize exact, partial, mismatch, and non-replayable outcomes.
- Add deterministic fixtures for each fidelity status.

Complete when:

```text
baseline decision reproduction is measured before any scenario is evaluated
mismatch rows are never silently treated as favorable counterfactuals
```

### Chunk 4 - Single-Intervention Scenario Engine

- Implement the immutable versioned scenario catalog.
- Apply only scenarios relevant to the recorded blocker or decision override state.
- Re-run the shared scoring service after one intervention.
- Compute outcome status, score delta, changed factor, and remaining blockers.
- Keep direct threshold/policy scenarios distinct from gate-override sensitivity scenarios.
- Add pure tests for every scenario, remaining-blocker behavior, and no-op handling.

Complete when:

```text
each result has exactly one scenario id
each scenario is reproducible and has an evidence-quality label
no scenario fabricates unavailable quote, authority, or price-impact facts
```

### Chunk 5 - Evaluation And Concentration Analysis

- Attach existing forward-return points only after replay/scenario result calculation.
- Summarize target-first and drawdown-first outcomes by scenario and evidence quality.
- Report run/window and mint concentration for promoted rows.
- Keep decision-level rows as the default; use existing dedupe modes for concentration checks.
- Mark insufficient sample sizes instead of extrapolating.

Complete when:

```text
the report can distinguish a broadly repeated sensitivity from one hot mint or one market hour
post-hoc returns are labeled evaluation-only everywhere
```

### Chunk 6 - Reporting And Documentation

- Implement bounded text and JSON report formatters.
- Add a recommendation matrix with one primary recommendation.
- Document every safety boundary, scenario version, known limitation, and archive-only constraint.
- Update the Phase 9 roadmap, structure, planning inputs, and decisions after implementation.
- Document that Phase 9.26 output is not a paper-pilot authorization.

Complete when:

```text
the command makes no provider calls and no database writes
the report explains a candidate result without raw payloads or ambiguous hypothetical claims
```

## Test Plan

Add focused Vitest coverage under `backend/src/research-counterfactual/`.

Required tests:

1. CLI accepts valid repeated archive labels and rejects invalid/missing input.
2. Archive-only loading does not resolve the active paper database.
3. Baseline replay reproduces a complete fixture's stored score and decision.
4. Partial snapshots produce `PARTIALLY_REPRODUCED`; malformed snapshots produce
   `NOT_REPLAYABLE`.
5. A stored/replayed mismatch is reported and receives no normal scenario result.
6. Threshold scenarios alter only their configured thresholds and keep all recorded gates intact.
7. Duplicate and max-buy scenarios apply only to rows that actually recorded those conditions.
8. Each gate override changes one factor only and reports remaining failed gates.
9. Missing quote, authority, or price-impact facts never become invented PASS evidence.
10. Later return points do not affect replayed score, decision, factor state, or scenario selection.
11. `decision`, `mint`, `first_per_mint`, and `best_per_mint` dedupe modes are deterministic.
12. Scenario summaries report sample size, mint concentration, and market-window concentration.
13. Text and JSON contain the PAPER/read-only/no-execution boundary and omit secrets/raw payloads.
14. Output artifacts are written only to an explicit output directory.
15. Existing `research:aggregate`, `research:interpret`, TerminalRunner, strategy, and paper tests
    remain unchanged and pass.

## Validation Plan

Phase 9.26 requires no long provider or TerminalRunner run. Its validation is archive-only.

### Automated Validation

```powershell
cd U:\Projects\NeXusTrade-Otis
corepack pnpm verify
```

### Archive Smoke

Use a completed Phase 9.4D archive after implementation:

```powershell
corepack pnpm research:counterfactual --once `
  --label-run=Full1:data/archive/phase9.4D/full1-phase9.4D-full1-20260812-1820 `
  --label-run=Full2:data/archive/phase9.4D/full2-phase9.4D-full2-20260813-1428 `
  --label-run=Full3:data/archive/phase9.4D/full3-phase9.4D-full3-20260813-1820 `
  --output-dir=data/archive/phase9.26/smoke-YYYYMMDD-HHMM
```

Expected smoke result:

```text
MODE: PAPER research
archive access: read-only
provider calls: disabled
database writes: disabled
orders/fills/positions: 0 / 0 / 0
baseline replay fidelity section present
single-intervention scenario section present
no active DB mutation
no provider-health/system-log write
```

### Acceptance Criteria

Phase 9.26 is complete only when:

- `pnpm verify` passes.
- The counterfactual command reads the three Phase 9.4D archives without provider calls or
  database writes.
- The report exposes baseline fidelity before scenario findings.
- Every scenario is single-intervention, named, versioned, and evidence-labeled.
- Incomplete evidence remains `NOT_EVALUABLE`; it is never turned into a favorable decision.
- Forward returns are isolated to outcome evaluation and clearly labeled post-hoc.
- Reports expose sample sizes and concentration before recommending a future experiment.
- No production strategy defaults, profiles, provider configuration, or paper-execution behavior
  changes.
- The final recommendation is one of data collection, narrow research experiment, fidelity repair,
  or continued deferral; it is never direct paper BUY enablement.

## Known Limitations And Deferrals

- Counterfactuals do not recreate an executable quote, fill, slippage, fee, latency, or market
  impact at the original moment.
- A gate override is sensitivity analysis, not evidence that a failed gate should be removed.
- A lower threshold may expose more historical forward returns but cannot prove a safe entry policy.
- Repeated decisions for one mint remain correlated even in decision-level reports; mint-level and
  concentration views are mandatory checks.
- The current archive may not preserve every historical strategy configuration perfectly; replay
  fidelity will measure this rather than conceal it.
- Multi-factor optimization, automatic profile mutation, portfolio construction, and ML remain
  deferred.
- A later Phase 9.26B or Phase 10 may consider bounded two-factor analysis only after the
  single-intervention results and fidelity coverage justify it.

## Phase Handoff

Phase 9.26 should produce a decision-ready answer to:

```text
Which exact recorded policy or gate is responsible for the highest-value explainable misses?
Does changing that one condition improve observed outcomes across mints and market windows?
Is the evidence sufficiently unconcentrated and low-drawdown to justify a separate shadow-profile
experiment?
```

The next phase is selected by the report, not assumed in advance:

```text
weak or incomplete fidelity          -> repair archive/replay evidence
one direct policy sensitivity        -> narrow shadow-profile or threshold experiment
one gate-override sensitivity        -> collect more evidence before policy change
concentrated gains                   -> collect more independent runs
profile promotion gates clear later  -> separate controlled paper-pilot review
```
