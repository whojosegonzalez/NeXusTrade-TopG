# NeXusTrade - Phase 9.28 Detailed Implementation Checklist

## Goal

Validate one pre-registered fast-horizon, shadow-only entry/exit profile on fresh data before any strategy-default or paper-execution change.

Phase 9.27 rejected T65N@v1 as a 60-minute 10% target / 10% stop lower-threshold policy. That does not prove its stored, time-safe candidates lack value at a shorter horizon. Phase 9.28 tests F65E@v1:

```
id/version/key: F65E / v1 / F65E@v1
source: stored SKIP decision, score 65-69 inclusive
snapshot baseline: BUY=90, WATCH=70, decision=SKIP
eligibility: buyEligible plus existing hard-factor passes
selection: first eligible decision per mint per PAPER session
primary exit: target +10%, stop -15%, maximum hold 15 minutes
observation horizons: 3, 5, 15 minutes
```

The runtime observer may write normal PAPER watchlist-return rows. Archive analysis is read-only. No surface may alter strategy defaults or create an order, fill, position, wallet, signing, or transaction action.

## Implementation Status

Implemented on 2026-08-17. `shadow:fast-observe` and the `fast_shadow_observe` TerminalRunner
stage use the fixed F65E@v1 contract. `shadow:fast-exit-validate` is archive-only and was
smoke-validated against an existing Phase 9.27 archive with zero provider calls, active-database
writes, sessions, orders, fills, positions, wallet loading, signing, or transaction submission.

The fresh runtime smoke completed on 2026-08-17 in archive
`data/archive/phase9.28/smoke-phase9.28-smoke-20260817-1714`. It ran one PAPER/shadow-only
session for about 29.4 minutes across 34 cycles, with no orders, fills, positions, wallet loading,
signing, or submission. F65E@v1 selected one mint with exact on-time 3/5/15-minute coverage; its
primary 10/15/15 scenario stopped first. That single outcome validates runtime wiring only, not
the profile. The three independent 120-minute validation runs remain the next evidence step.

## Rationale

The final valid Phase 9.27 cohort had 24 selected mints. Its primary 10/10/60 outcome was 13 TARGET_FIRST, 9 STOP_FIRST, and 2 NEITHER, with median MFE +18.06% and median MAE -11.44%. The report therefore returned REJECT_NARROW_THRESHOLD.

The pre-existing scenario grid showed 10/15/15 at 13 TARGET_FIRST, 2 STOP_FIRST, and 9 NEITHER. That is exploratory evidence only. It is a reason to pre-register F65E@v1 for fresh data, not a reason to lower production thresholds.

## Locked Decisions

- Production remains BUY=90, WATCH=70, PAPER execution disabled.
- Scores 60-64 are out of scope. There is no BUY >= 60 or BUY >= 65 change.
- Candidate membership is decided solely from persisted decision-time facts. Later price, return, score, provider, or TokenRadar changes cannot affect inclusion.
- Cap F65E observation to 10 selected mints per PAPER session. Record cap suppression.
- Use only 3/5/15-minute observations and a two-minute maximum lateness.
- One- and two-minute observations are deferred; the current full TerminalRunner cycle does not guarantee a reliable one-minute completion cadence.
- Alchemy-backed SOLANA_RPC is the research baseline. QuickNode DAS remains disabled and optional.
- No provider additions, reprioritization, direct price endpoint, wallet activity, paper execution, or broad score tuning.

## Scenario Contract

```
Primary:   target=10%, stop=15%, maximum hold=15 minutes
Secondary: target=10%, stop=10%, maximum hold=15 minutes
Secondary: target=10%, stop=15%, maximum hold=5 minutes
Secondary: target=10%, stop=10%, maximum hold=5 minutes
```

Only the primary scenario can determine the Phase 9.28 recommendation. Secondary scenarios are diagnostics and cannot be selected after viewing fresh returns.

## Implementation Chunks

### Chunk 1 - Stored-Fact Eligibility

- [x] Review Phase 9.27 classification and extract a small pure helper only if it prevents drift. Do not refactor unrelated archive/research behavior.
- [x] Add F65E profile constants and types under backend/src/shadow-fast/.
- [x] Require all persisted facts: SKIP; integer score 65..69; original 90/70 snapshot; buyEligible=true; PASS risk, liquidity, volume, pair age, quote availability, and price impact; usable baseline price.
- [x] Return one deterministic exclusion/inclusion code: baseline mismatch, score-band mismatch, invalid snapshot, hard-gate failure, missing price/quote evidence, duplicate mint, or session-cap suppression.
- [x] Order decisions by decision time, then decision ID.

Complete when F65E eligibility makes no provider call and cannot read future returns.

### Chunk 2 - Fast Shadow Observation Service

- [x] Add FastShadowConfig.ts, FastShadowTypes.ts, FastShadowCandidateSelector.ts, and FastShadowObservationRunner.ts.
- [x] Select first eligible decision per mint, up to ten candidates for the PAPER session.
- [x] Reuse WatchlistReturnObservation and its repository. No database migration.
- [x] Extend the watchlist scheduling seam so selected decision IDs reuse baseline resolution, persistence, and existing decision/horizon idempotency.
- [x] Schedule exactly 3, 5, and 15-minute observations.
- [x] Mark observations more than two minutes late as MISSED; never represent them as on-time.
- [x] Use MarketDataService.enrichToken() only for due observations and retain normal ProviderHealth/SystemLog behavior.
- [x] Return eligible, selected, cap-suppressed, duplicate-mint-suppressed, already-scheduled, due, observed, missed, and failed counts.

Complete when the service writes only normal PAPER watchlist-return rows and never writes strategy, order, fill, or position data.

### Chunk 3 - TerminalRunner And Command Surface

- [x] Add fast_shadow_observe immediately after strategy and before generic shadow observation/reporting in the TerminalRunner stage contract.
- [x] Add stage summary/counts to TerminalRunSummary without changing scanner, risk, strategy, quote, or execution behavior.
- [x] Add backend/src/scripts/shadow-fast-observe.ts.
- [x] Add backend and root package scripts named shadow:fast-observe.
- [x] Require explicit PAPER --session-id for direct use. Support --once and bounded --max-runtime-minutes / --interval-ms tail mode.
- [x] Reject LIVE, wallet, signing, submission, paper-execution, and unbounded-loop options.
- [x] Do not create a session in the direct command.

Complete when normal TerminalRunner cycles schedule F65E observations and the tail command can finish due rows after TerminalRunner stops.

### Chunk 4 - Archive-Only Fast Exit Validator

- [x] Add archive analysis and formatting services under backend/src/shadow-fast/, using ResearchRunArchiveLoader and completed archives only.
- [x] Add backend/src/scripts/shadow-fast-exit-validate.ts.
- [x] Add backend and root package scripts named shadow:fast-exit-validate.
- [x] Accept repeated --label-run=<label>:<archivePath>, --once, --json, and explicit --output-dir only.
- [x] Reject active-database, provider, threshold-override, and paper-execution options.
- [x] Reconstruct F65E selection from stored facts before attaching later observations.
- [x] Report exact, missing, and late coverage separately for 3, 5, and 15 minutes.
- [x] Evaluate exactly the four registered scenarios: target-first, stop-first, maximum hold, no observation, MFE, MAE, median/average return, and modeled exit return.
- [x] Include controls for out-of-band scores, baseline mismatch, hard-gate failure, missing evidence, duplicate suppression, and cap suppression.
- [x] Include mint/run concentration, leave-one-mint-out, leave-one-run-out, and primary-scenario coverage.
- [x] Emit bounded text/JSON without raw provider payloads, URLs, or secrets.

Complete when the validator cannot read or mutate the active database and makes zero provider calls.

### Chunk 5 - Recommendation Gate

- [x] Support only REJECT_FAST_EXIT_PROFILE, COLLECT_MORE_INDEPENDENT_DATA, CONTINUE_SHADOW_RESEARCH, and PREPARE_SEPARATE_PROMOTION_REVIEW.
- [x] Require all sample checks for a possible promotion review:
  - at least 3 valid fresh runs;
  - at least 20 selected candidates with 15-minute coverage;
  - at least 15 unique mints;
  - no selected mint or run above 40% of the cohort;
  - stable leave-one-run-out and leave-one-mint-out direction.
- [x] Require all primary-profile checks:
  - target-first rate at least 55%;
  - stop-first rate at most 25%;
  - target-first minus stop-first at least 20 percentage points;
  - median MFE at least +10%;
  - median MAE remains above -15%.
- [x] List every unmet requirement and never turn a near miss into a favorable recommendation.
- [x] Treat PREPARE_SEPARATE_PROMOTION_REVIEW as a review authorization only, never paper BUY permission.

### Chunk 6 - Tests

- [x] Test config defaults, invalid session/horizon/cap/lateness values, profile identity, and forbidden flags.
- [x] Test every stored-fact inclusion/exclusion category.
- [x] Prove returns cannot alter eligibility; selection is deterministic; cap suppression is deterministic.
- [x] Test scheduling reuse, 3/5/15 scheduling, baseline-price failure, late/missed behavior, and no duplicate decision/horizon rows.
- [x] Test the TerminalRunner stage summary and PAPER/shadow-only boundary.
- [x] Test archive-only active-DB rejection, zero provider calls/writes, output requirement, coverage accounting, four scenarios, concentration, and recommendation gates.
- [x] Add regression coverage proving F65E cannot change 90/70 defaults, orders, fills, positions, wallet loading, signing, or submission.
- [x] Run corepack pnpm verify.

### Chunk 7 - Documentation

- [x] Update roadmap, decision log, structure, and Phase 9 planning inputs after implementation.
- [x] Document T65N@v1 as rejected for 10/10/60 and F65E@v1 as a separate fast-exit hypothesis.
- [x] Record archive labels, provider-budget caveats, invalid-run exclusions, and the final recommendation.

## Validation Plan

### Archive Smoke

Run the new validator against the eight valid Phase 9.27 archives after implementation. This verifies archive-only safety and output shape; it is not prospective F65E promotion evidence.

The command takes the existing Test1 through Test7 archives plus Test8R, all as repeated --label-run inputs, and writes only to data/archive/phase9.28/archive-smoke.

Expected:

```
PAPER research / read-only archives
provider calls = 0
database writes = 0
session creation = 0
orders/fills/positions = 0/0/0
F65E selection and 3/5/15 coverage accounting present
primary and secondary scenario sections present
no paper-execution authorization
```

### Fresh Runtime Smoke

- Reset the PAPER database.
- Run a 30-minute PAPER/shadow-only TerminalRunner smoke with Alchemy-backed SOLANA_RPC.
- Run a bounded 20-minute shadow:fast-observe tail using the emitted session ID.
- Archive TerminalRunner output, fast-observe transcript, database snapshot, and reports.

The smoke passes only if the fast_shadow_observe stage appears, QuickNode DAS is absent, Solana RPC has no live failure, orders/fills/positions remain zero, and fast rows are observed, pending, or explicitly missed/failed.

Completed: the August 17 smoke satisfied those mechanical and safety requirements. The validator
initially rejected a repeated Windows path separator in the runbook; this was corrected with
normalization and a regression test before the same archived dataset was successfully revalidated.

### Fresh Validation Protocol

After the smoke passes, collect exactly three independent 120-minute PAPER/shadow-only runs with unchanged 90/70 strategy collection and the same provider configuration.

For each run:

1. Reset the PAPER database.
2. Run TerminalRunner for 120 minutes.
3. Run shadow:fast-observe for a bounded 20-minute tail using the run session ID.
4. Archive the run directory, transcripts, database snapshot, fast-observe output, and normal reports under data/archive/phase9.28/.
5. Run shadow:fast-exit-validate only after archiving.

After the third run, generate one combined three-archive F65E report. Do not automatically extend the batch if the profile fails; a failure is evidence, not a reason to loosen rules or collect unlimited unchanged samples.

## Fresh Validation Closeout

Completed August 18, 2026. The three mechanically valid PAPER/shadow-only archives were:

```text
Test1: selected=0, exact15=0
Test2: selected=1, exact15=1
Test3: selected=6, exact15=6
```

The combined archive-only report found seven selected candidates with exact 3/5/15-minute coverage.
For the immutable primary 10% target / 15% stop / 15-minute scenario, 3 were target-first, 3 were
stop-first, and 1 reached maximum hold. The validator returned `COLLECT_MORE_INDEPENDENT_DATA`
because the sample gate was unmet. Under this phase's fixed-batch rule, the project conclusion is
`CLOSE_WITHOUT_PROMOTION`: F65E@v1 is not a candidate for promotion, and no further unchanged F65E
runs should be collected.

The combined report is stored under:

```text
data/archive/phase9.28/combined-valid-three-20260818-1418
```

## Acceptance Criteria

- [x] F65E@v1 is fixed, versioned, and selected only from persisted facts.
- [x] Production BUY/WATCH thresholds remain 90/70.
- [x] Fast observation reuses the watchlist-return schema; no migration is added.
- [x] TerminalRunner remains PAPER/shadow-only and reports the new stage separately.
- [x] Lateness is preserved rather than hidden.
- [x] The validator makes no provider calls, database writes, session changes, or execution actions.
- [x] Reports expose primary/secondary distinction, coverage, concentration, and unmet gates.
- [x] Automated checks, archive smoke, and runtime smoke retain zero orders, fills, positions, wallet loading, signing, and submission.
- [x] Three fresh validation runs preceded the profile recommendation.
- [x] No Phase 9.28 result enabled paper BUY.

## Known Limitations

- Discrete 3/5/15-minute observations do not show intra-interval paths, executable quotes, liquidity collapse, fees, slippage, latency, partial fills, or MEV.
- The 10/15/15 primary scenario is newly pre-registered for fresh data but was suggested by exploratory data; independent evidence is required.
- One- and two-minute monitoring requires a later dedicated low-latency sampler with measured cadence.
- Portfolio allocation, concurrency, session goals, and paper-order execution remain separate work.

## Phase Handoff

Phase 9.28 answers:

```
Can F65E@v1 produce a repeatable 15-minute target/stop balance on fresh data?
Are 3/5/15-minute observations fresh enough to support that answer?
Does the profile earn only a separate promotion review, or should it be rejected unchanged?
```

Possible next steps:

```
profile rejected             -> test a different single pre-registered entry or exit hypothesis
coverage inadequate          -> design a low-latency observation phase
profile promising/incomplete -> collect one defined independent validation batch
profile gates pass           -> separate controlled paper-pilot review
```
