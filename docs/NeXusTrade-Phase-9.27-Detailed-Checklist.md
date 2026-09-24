# NeXusTrade Phase 9.27 Detailed Checklist

Narrow shadow threshold validation

Last updated: August 2026

## Status

Implemented and archive-smoke validated on August 14, 2026. The validator is a read-only
`T65N@v1` report command; normal strategy collection remains `BUY=90` / `WATCH=70`.

The initial smoke used the three Phase 9.4D full-validation archives. It found 27 threshold-only
eligible decision rows, which reduced to 3 first-per-mint-per-run candidates. All three had
60-minute observations, but the sample failed the pre-registered independence and concentration
gates.

Six fresh independent 120-minute runs completed on August 14-15, 2026. All were mechanically
valid PAPER/shadow-only archives with zero orders, fills, and positions. The combined report found
311 eligible decision rows, 19 first-per-mint candidates, 19 unique mints, and 19 60-minute
observations. Its primary 10/10 at 60-minute scenario was `9 TARGET_FIRST`, `8 STOP_FIRST`, and
`2 NEITHER`; median MFE was `+18.26%` and median MAE was `-10.92%`. Count, mint-diversity, and
single-run concentration gates passed, but both leave-one-out checks were unstable: the one-vote
target-first margin reverses or ties when a favorable run or mint is omitted.

All 19 selected candidates had a stored score of exactly `65`; no selected candidate fell in the
66-69 portion of the registered band. The current evidence therefore describes the score-65 edge,
not the complete 65-69 range. The correct result remains `COLLECT_MORE_INDEPENDENT_DATA`; this
phase made no strategy, provider, database, or execution change.

## Why This Phase Exists

Phase 9.4D removed quote-provider capacity as the immediate research bottleneck. Across three
independent 120-minute PAPER/shadow-only runs, selected-candidate quote coverage was `96.44%` and
Jupiter upstream `429` was `0%`.

Phase 9.26 then exactly reproduced `844 / 844` archived decision rows without provider calls or
database writes. Its direct `SCORE_THRESHOLD_65_60` sensitivity promoted 27 historical rows, but
the result was concentrated:

```text
largest promoted-mint share:  74.07%
largest promoted-run share:   81.48%
```

That result is a useful hypothesis, not a strategy change. It says a small cohort deserves a
fresh, pre-registered shadow validation. It does not prove that a 65/60 production threshold is
safe, profitable, tradable, or ready for paper BUY execution.

Phase 9.27 deliberately tests only the narrow delta cohort:

```text
persisted baseline decision:  SKIP
stored score:                 65 through 69 inclusive
decision-time hard gates:     all passed
selection time:               persisted strategy decision time
outcomes:                     later watchlist returns only
```

Scores of 70 or more, score bands below 65, gate overrides, provider changes, confirmation
variants, entry-timing variants, and exit-rule tuning are outside this phase. This is not a full
65/60 strategy simulation; it is a narrow validation of the score band that the counterfactual
evidence surfaced.

## Objective

Create a versioned, archive-only narrow-threshold validator that can answer:

```text
When a normal 90/70 strategy run recorded a 65-69 SKIP solely because of its score threshold,
and all decision-time buy eligibility gates passed, how did that pre-registered cohort behave
over the later 3, 5, 15, 30, 60, and 120 minute observations?
```

The report must quantify sample quality, entry concentration, target-before-stop ordering,
favorable/adverse excursion, and hard-gate exclusion outcomes before recommending another phase.

## Safety Boundary

Phase 9.27 may:

- Read completed PAPER/shadow-only run archives in read-only mode.
- Read persisted `StrategyDecision`, score attribution, `RiskAssessment`, `TokenRadar`, and
  `WatchlistReturnObservation` facts.
- Apply a pre-registered in-memory candidate filter to time-of-decision facts.
- Compute outcome-only return, target/stop, MFE, MAE, concentration, and sample-quality metrics.
- Write optional text and JSON research reports only beneath a user-supplied ignored `data/` path.
- Add pure configuration, loader, report, formatter, CLI, tests, and documentation.

Phase 9.27 must not:

- Call DexScreener, Jupiter, Raydium, Birdeye, Solana RPC, DAS, Helius, or any other live provider.
- Alter the normal strategy configuration, including the production `BUY=90` / `WATCH=70`
  thresholds.
- Run `strategy:evaluate` with `--buy-score-threshold=65` or otherwise persist a
  lower-threshold decision during collection.
- Write to active or archived databases, including sessions, TokenRadar, risk assessments,
  strategy decisions, provider health, system logs, orders, fills, positions, or snapshots.
- Enable or invoke `paper:execute`, `paper:sell`, `exits:manage`, wallet loading,
  transaction construction, signing, or submission.
- Use future prices, returns, target hits, drawdowns, later decisions, or observed winners to
  select a candidate at decision time.
- Change scoring weights, hard eligibility gates, quote-policy behavior, provider order, quote
  budget allocation, or exit behavior.
- Claim simulated outcome as a fill, executable price, realized P/L, expected profit, or evidence
  that paper BUY is ready.
- Add a database migration or a persistent narrow-validation table.

Every text and JSON result must disclose:

```text
MODE: PAPER research
archive access: read-only
database writes: disabled
provider calls: disabled
strategy defaults changed: no
paper execution: disabled
wallet loaded: no
transaction signing: disabled
transaction submission: disabled
```

## Locked Research Contract

```text
Command:                       pnpm shadow:threshold-validate --once
Data source:                   one or more completed archive directories only
Baseline collection strategy:  unchanged BUY=90 / WATCH=70
Candidate profile:             T65N@v1 (narrow threshold-only cohort)
Original decision:             SKIP
Score band:                    65 through 69 inclusive
Hard-gate policy:              all recorded buy eligibility gates must pass
Quote policy:                  recorded quote and price-impact gates must pass
Entry time:                    earliest eligible decision per mint per run
Outcome evidence:              later watchlist returns only
Default hold horizons:         15,30,60 minutes
Default target/stop grid:      10,15,25 percent paired targets/stops
Archive writes:                none
Active database writes:        none
Provider calls:                none
Paper execution:               disabled
```

`T65N@v1` is a research profile identifier, not a production strategy name and not an execution
permission. `P001@v1` remains immutable and is retained only as the historical Phase 8.91
baseline; it is not silently rewritten to create a convenient comparison.

## Candidate Definition

### Included Candidate

A row becomes a `T65N@v1` candidate only when all of the following are present in its persisted
time-of-decision snapshot:

```text
stored StrategyDecision.decision = SKIP
stored score is an integer in [65, 69]
stored original thresholds are BUY=90 and WATCH=70
stored raw decision is SKIP when present
stored buyEligible = true
all required hard factors passed:
  risk_eligibility
  liquidity_attractiveness
  volume_1h_attractiveness
  pair_age_attractiveness
  price_impact_attractiveness
recorded quote and price-impact evidence is present and passing
decision snapshot is replayable and internally consistent
```

The 65-69 score band is the only changed policy. The candidate did not pass because an authority,
liquidity, volume, age, or price-impact gate was imagined to be favorable.

### Selection Rules

1. Sort valid candidates by `decidedAtMs` within each archived run.
2. Group valid candidates by `runLabel + mintAddress`.
3. Select the earliest eligible decision for each mint in each run.
4. Mark later eligible decisions for that mint `DUPLICATE_ATTENTION_SUPPRESSED`; retain them in
   diagnostics but exclude them from the primary outcome denominator.
5. Do not select across different runs by later return, highest future price, or any other outcome.
   The same mint may appear in independent run windows and must remain visible for concentration
   analysis.
6. Do not impose a virtual order cap in Phase 9.27. This phase measures an entry cohort, not a
   portfolio or order simulation. Position-concurrency and max-buy-cap research stay separate.

### Exclusion Categories

Every source row in scope must be counted exactly once in a primary category:

```text
SELECTED
NOT_SCORE_BAND
NOT_BASELINE_SKIP
THRESHOLD_SNAPSHOT_MISMATCH
MISSING_OR_INVALID_SCORE_SNAPSHOT
HARD_GATE_BLOCKED
MISSING_QUOTE_OR_PRICE_IMPACT
DUPLICATE_ATTENTION_SUPPRESSED
NO_FORWARD_OBSERVATION
```

`HARD_GATE_BLOCKED` is not a failed experiment. It is a control cohort demonstrating that Phase
9.27 did not relax safety gates to create more candidates.

## Report Contract

Add a dedicated report contract under `backend/src/shadow-threshold/`. The report must keep
candidate selection facts separate from outcome facts.

### Configuration And Safety Section

Report:

- profile ID/version/key: `T65N@v1`.
- archive labels and resolved read-only database paths.
- original threshold contract, target/stop grid, and hold horizons.
- configured candidate filter and selection policy.
- source run safety counts: sessions, orders, fills, and positions.
- `providerCalls = 0`, `databaseWrites = 0`, and all wallet/transaction flags.

### Cohort Accounting

Report both decision-level and selected-mint-level counts:

```text
source SKIP rows
65-69 rows
threshold-only eligible rows
selected first-per-mint rows
duplicate-attention suppressed rows
hard-gate excluded rows by rule
rows with no observed returns
selected rows with 3/5/15/30/60/120 minute observations
unique selected mints
selected runs with at least one candidate
```

For each selected candidate, output a compact audit row containing:

```text
run label
decision ID
mint address and symbol when recorded
decision timestamp
stored score
original BUY/WATCH thresholds
all hard-factor pass/fail facts
quote source/provenance when recorded
selection status and exclusion reason
repeated-attention count
observed return horizons
MFE and MAE through each configured hold horizon
```

### Outcome Metrics

For selected rows only, calculate by hold window (15, 30, 60 minutes):

- candidate count and unique-mint count.
- observed coverage and unobserved count.
- average and median return at each observed horizon.
- maximum favorable excursion (MFE) and maximum adverse excursion (MAE).
- average and median MFE/MAE.
- paired target-before-stop, stop-before-target, ambiguous, and neither counts for 10/10, 15/15,
  and 25/25 scenarios.
- target-first and stop-first rates using only rows with sufficient observed evidence.
- candidate-level top/bottom outcomes, clearly labelled as observed returns rather than trades.

Use the existing discrete watchlist observation ordering rules. If the data cannot establish which
threshold happened first, report `AMBIGUOUS`; never invent intraminute ordering or executable
fill behavior.

### Controls And Concentration

Report the following beside the selected cohort:

- hard-gate-excluded score-band control cohort, with outcome-only metrics where observations exist.
- selected rows by score (`65` through `69`), source decision reason, and risk result.
- selected rows by run window and mint.
- maximum selected-candidate share for a single mint and single run.
- maximum target-first-win share for a single mint and single run.
- repeated-attention distribution (`NONE`, `LOW`, `MEDIUM`, `HIGH`).
- leave-one-run-out and leave-one-mint-out summary for the primary 10/10 at 60-minute scenario.
- a `DATA_INSUFFICIENT` reason whenever a denominator is zero or coverage is incomplete.

The report must not calculate a simulated portfolio balance, P/L, buy size, fill price, or exit
transaction in this phase.

### Recommendation Matrix

The final text and JSON report must select exactly one primary outcome:

```text
REJECT_NARROW_THRESHOLD
  Fresh selected cohort has unfavorable target/stop or adverse-excursion evidence.

COLLECT_MORE_INDEPENDENT_DATA
  Safety holds, but the sample is too small, insufficiently observed, or concentrated.

CONTINUE_SHADOW_RESEARCH
  The cohort is measurable but does not justify a threshold-promotion review.

PREPARE_SEPARATE_PROMOTION_REVIEW
  Only a review is authorized. Strategy defaults and paper BUY remain unchanged.
```

`PREPARE_SEPARATE_PROMOTION_REVIEW` is not a paper-trading authorization. It requires a later
phase to explicitly review risk, executable quote, sizing, portfolio-cap, and exit behavior.

## Recommended Evidence Gates

These are review gates, not automatic production thresholds:

```text
mechanically valid archives:                at least 3 independent runs
PAPER/shadow-only safety:                   100% valid; orders/fills/positions always 0
selected candidates with 60m observations:  at least 15
unique selected mints:                      at least 10
runs with selected candidates:              at least 3
largest selected-mint share:                 no more than 40%
largest target-first-win run share:          no more than 40%
leave-one-run-out stability:                 no single omitted run reverses conclusion
leave-one-mint-out stability:                no single omitted mint reverses conclusion
```

If the sample gate fails, report `COLLECT_MORE_INDEPENDENT_DATA` even when a few candidates show
large gains. Do not lower the standard after seeing outcomes.

The Phase 9.27 review should consider the 10/10 60-minute target-before-stop relationship, MFE,
and MAE together. A high raw target-hit rate paired with severe early adverse excursion is not
enough to support a threshold change.

## Implementation Chunks

### 1. Configuration And Types

- [x] Add `backend/src/shadow-threshold/ShadowThresholdConfig.ts`.
- [ ] Define immutable defaults for `T65N@v1`: source `SKIP`, score range `65-69`, original
      thresholds `90/70`, target/stop grid `10,15,25`, hold windows `15,30,60`, and first-per-mint
      selection within each run.
- [ ] Support `--once`, repeated `--label-run=<label>:<archive-dir>`, `--json`, and optional
      `--output-dir=<ignored-data-directory>`.
- [ ] Make score band, original thresholds, source decision, selection mode, and primary
      target/stop/horizon immutable in the first release. Reject override flags rather than
      creating an unregistered parameter sweep.
- [x] Add `ShadowThresholdTypes.ts` for source rows, eligibility/exclusion classifications,
      selected candidates, outcome summaries, concentration summaries, sample quality, and
      recommendation result.
- [ ] Record `profileId = T65N`, `profileVersion = v1`, and `profileKey = T65N@v1` in every row
      and artifact.
- [x] Add configuration parser and validation tests, including invalid archive labels and rejected
      mutable threshold options.

### 2. Read-Only Archive Loader And Cohort Selection

- [x] Reuse the Phase 9.26 archive resolver so callers pass an archive directory, not a fragile
      nested database path.
- [x] Open only resolved archive database snapshots in read-only/query-only mode.
- [x] Reuse persisted score-attribution parsing instead of recalculating live strategy inputs.
- [ ] Build a candidate source row for every eligible `SKIP` decision in the configured archive
      scope before applying the 65-69 filter.
- [ ] Verify original `BUY=90` / `WATCH=70` and stored raw `SKIP` facts where available.
- [ ] Require all five persisted buy-eligibility factors to be positive, plus recorded quote and
      price-impact evidence. Missing or ambiguous evidence must classify as excluded.
- [x] Apply chronological first-per-mint-per-run selection with no future-data sort key.
- [x] Keep later same-mint rows as suppressed diagnostics rather than deleting them.
- [ ] Surface archive read errors and malformed snapshots per run; do not silently treat them as
      zero candidates.
- [x] Add unit tests proving that a later high-return row cannot affect the selected input row.

### 3. Outcome And Concentration Analysis

- [x] Reuse normalized watchlist return observations only after candidate selection is complete.
- [ ] Compute MFE/MAE and target-before-stop outcomes using existing discrete observation helpers
      where practical; retain `AMBIGUOUS` and `NO_OBSERVATION` states.
- [ ] Compute score-band, hard-gate-control, run, mint, and repeated-attention breakdowns.
- [x] Add leave-one-run-out and leave-one-mint-out calculations for the primary 10/10, 60-minute
      scenario.
- [ ] Calculate selected candidate and target-first concentration independently. A balanced source
      cohort does not excuse concentrated wins.
- [x] Derive one recommendation strictly from the pre-registered sample/quality gates and outcome
      summary; no automatic strategy action is permitted.
- [ ] Unit-test zero denominators, one-run datasets, repeated-mint candidates, missing forward
      returns, ambiguous target/stop ordering, and concentration threshold boundaries.

### 4. CLI And Reporting

- [x] Add `backend/src/shadow-threshold/ShadowThresholdReportFormatter.ts` and
      `ShadowThresholdRunner.ts`.
- [x] Add `backend/src/scripts/shadow-threshold-validate.ts`.
- [x] Add root and backend `shadow:threshold-validate` scripts.
- [ ] Print the research safety boundary before all report content.
- [x] Emit bounded text and JSON output. If `--output-dir` is omitted, write no artifact.
- [ ] Include per-run warnings, raw row counts, selected counts, coverage counts, and direct paths
      used to make the result reproducible.
- [ ] Ensure optional artifacts are ignored by Git and never contain provider credentials.
- [ ] Add CLI integration tests using small read-only fixture archives.

### 5. Documentation

- [x] Update this checklist from `Planned` to `Implemented` only after code, tests, and a
      read-only archive smoke complete.
- [x] Update `ROADMAP_Phase9Plus.md`, `DECISIONS_Phase9Plus.md`,
      `Structure_Phase9Plus.md`, and `Phase-9-Planning-Inputs.md` with the final command,
      archive-only boundary, and validation conclusion.
- [x] Document `T65N@v1` as a fresh validation profile that is separate from both production
      strategy configuration and `P001@v1`.
- [x] Record the exact archives used for Phase 9.27 reporting and any data-quality exclusions.

## Test Plan

### Automated Tests

- [ ] Config parsing, default contract, invalid labels, and forbidden threshold overrides.
- [ ] Read-only archive resolution and no-active-database guard.
- [ ] Candidate inclusion requires original threshold evidence, score band, `buyEligible`, all
      hard factors, and passing quote/price-impact evidence.
- [ ] Candidate selection is earliest eligible decision per run/mint and independent of later
      return values.
- [ ] Every source row receives exactly one exclusion/selection category.
- [ ] Return calculations preserve missing and ambiguous states.
- [ ] MFE/MAE and target-before-stop calculations for 10/10, 15/15, and 25/25 at 15/30/60 minutes.
- [ ] Concentration and leave-one-out summaries detect a dominant mint or run.
- [ ] Recommendation matrix produces one result and never signals paper execution.
- [ ] Text/JSON formatter tests include all safety flags.
- [ ] Full `corepack pnpm verify` passes.

### Archive Smoke

Run once against the three Phase 9.4D archives after implementation:

```powershell
corepack pnpm shadow:threshold-validate --once `
  --label-run=Full1:data/archive/phase9.4D/full1-phase9.4D-full1-20260812-1820 `
  --label-run=Full2:data/archive/phase9.4D/full2-phase9.4D-full2-20260813-1428 `
  --label-run=Full3:data/archive/phase9.4D/full3-phase9.4D-full3-20260813-1820 `
  --output-dir=data/phase9.27-archive-smoke
```

Expected:

```text
PAPER research / read-only archives
provider calls = 0
database writes = 0
orders/fills/positions = 0
normal strategy threshold changes = 0
candidate and exclusion accounting is present
recommendation is one of the four declared research outcomes
```

### Fresh Validation Protocol

After the archive smoke passes, collect at least three new independent market windows:

1. Start from `corepack pnpm db:reset:paper` for each run.
2. Run the unchanged 90/70 `terminal:run` in PAPER/shadow-only mode for 120 minutes.
3. Wait 60 minutes and refresh watchlist returns so 60-minute observations can mature.
4. Archive the normal run output, database snapshot, transcript, and tail reports under
   `data/archive/phase9.27/`.
5. Run `shadow:threshold-validate` only against that completed archive; never against a live
   strategy session.
6. After the third run, run one combined three-archive threshold report and review its
   recommendation matrix.

Use distinct market windows. Do not cherry-pick a run because it produced an attractive candidate.
If no candidates qualify, that is a valid result and should be reported rather than solved by
relaxing a gate during the phase.

## Acceptance Criteria

- [x] New validator reads only completed archives and does not need API keys or a provider call.
- [x] Normal collection continues with production `BUY=90` / `WATCH=70` thresholds.
- [x] A `T65N@v1` candidate is selected solely from time-of-decision stored facts.
- [x] Every in-scope source row is selected or has an auditable exclusion category.
- [x] Later return data never affects entry selection, dedupe selection, or factor eligibility.
- [x] Report distinguishes candidate count, unique mints, observed coverage, target-first behavior,
      adverse excursion, and concentration.
- [x] One report recommendation is produced without enabling paper execution.
- [x] Automated checks and archive smoke show zero provider calls, database writes, orders, fills,
      positions, wallet loading, signing, and submission.
- [x] Three fresh 120-minute validations use the exact documented normal-run protocol.
- [x] The final conclusion either rejects the narrow cohort, requests more independent data,
      continues shadow research, or authorizes only a separate promotion review.

## Current Validation Status (2026-08-16)

- Tests 1-7 are valid PAPER/shadow-only research windows with zero orders, fills, or positions.
  Their read-only combined report is archived at
  `data/archive/phase9.27/combined-valid-seven-20260816/`.
- For the primary 10% target / 10% stop / 60-minute observation scenario, the valid seven-run
  cohort contains 22 selected unique mints: 11 `TARGET_FIRST`, 9 `STOP_FIRST`, and 2 `NEITHER`.
  Leave-one-run-out direction is still unstable, so `T65N@v1` is not promotable.
- Test 8 is excluded from the cohort. Its QuickNode-backed `SOLANA_RPC` and `QUICKNODE_DAS`
  requests failed throughout the run, which caused fallback pressure and does not represent a
  comparable strategy observation.
- Before collecting a replacement market window, source `SOLANA_RPC_BASE_URL` from the configured
  Alchemy mainnet endpoint and disable `QUICKNODE_DAS`. Do not alter the normal 90/70 strategy
  thresholds or enable paper execution.
- The 30-minute Alchemy replacement provider smoke passed on 2026-08-16: 17 cycles,
  PAPER/shadow-only safety status `PASS`, zero live rate limits, zero live provider errors, and
  3,042 `SOLANA_RPC_JSON_PARSED` authority-evidence results with no RPC failures. QuickNode was
  absent from the enabled provider list. Its archive is
  `data/archive/phase9.27/replacement-smoke-phase9.27-replacement-smoke-20260816-2236/`.
- Test8R replaced the invalid Test 8 under the Alchemy-backed configuration. It is valid
  (`PAPER`, shadow-only, 62 cycles, zero `SOLANA_RPC` failures, zero orders/fills/positions), and
  QuickNode was absent. Its archive is
  `data/archive/phase9.27/test8r-phase9.27-test8r-20260817-1033/`.
- The combined valid eight-run report is archived at
  `data/archive/phase9.27/combined-valid-eight-20260817-1033/`. It contains 24 selected unique
  mints. The primary 10% target / 10% stop / 60-minute scenario produced 13 `TARGET_FIRST`,
  9 `STOP_FIRST`, and 2 `NEITHER`; both leave-one-run-out checks passed.
- Despite that sample-quality pass, the immutable report recommendation is
  `REJECT_NARROW_THRESHOLD`: the primary scenario does not show a sufficient target-first versus
  adverse-excursion balance. `T65N@v1` is rejected. Do not alter the normal 90/70 strategy
  thresholds or enable paper execution. Do not collect more unchanged Phase 9.27 samples.
- Birdeye's Phase 9.4 request-budget guardrail skipped 100 live requests during Test8R; this was
  not an Alchemy or QuickNode failure and did not affect the authority-evidence path.

## Known Limitations

- Watchlist observations are discrete checkpoints, not tick-level price paths, executable quotes,
  fills, or liquidity guarantees.
- MFE/MAE and target/stop ordering are observational and may be ambiguous between checkpoints.
- The phase validates only the 65-69 incremental cohort. It does not validate the broader 65/60
  policy, portfolio sizing, maximum concurrent positions, duplicate handling across a real order
  lifecycle, or an exit algorithm.
- First-per-mint-per-run selection reduces duplicate attention bias; it does not prove that an
  actual order could have been placed or filled at the observation price.
- A passing Phase 9.27 recommendation does not enable paper BUY. A future promotion review must
  explicitly decide whether the broader strategy, order rules, and exits warrant any controlled
  paper experiment.
