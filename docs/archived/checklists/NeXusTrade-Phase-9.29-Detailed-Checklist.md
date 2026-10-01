# NeXusTrade Phase 9.29 Detailed Checklist

## Purpose

Phase 9.29 is an archive-only, read-only fast-entry attribution and hypothesis-selection phase.
It must answer one constrained question:

```text
What distinguished F65E@v1 target-first candidates from stop-first and maximum-hold candidates
using only facts that existed at the original strategy decision time?
```

The completed Phase 9.28 combined report is discovery evidence, not a reason to alter the normal
strategy, collect another unchanged F65E batch, or create a profile by post-hoc threshold search.
Phase 9.29 either emits one defensible, fully pre-registered successor entry hypothesis or records
`NO_DEFENSIBLE_HYPOTHESIS`. It does not implement or collect the successor.

## Current Evidence And Input Contract

The only Phase 9.29 source cohort is the three valid Phase 9.28 PAPER/shadow-only archives used by
the final combined report:

```text
data/archive/phase9.28/combined-valid-three-20260818-1418
```

The immutable source runs are Test1, Test2, and Test3. Their Phase 9.28 F65E result is:

```text
Test1 selected = 0
Test2 selected = 1
Test3 selected = 6
combined exact 3/5/15-minute coverage = 7 candidates
primary 10% target / 15% stop / 15-minute outcome =
  TARGET_FIRST = 3
  STOP_FIRST = 3
  MAX_HOLD = 1
```

All source databases must be archive copies under `data/archive/`, must contain a mechanically
valid PAPER session, and must retain the stored strategy decisions, decision snapshots, and
watchlist-return rows needed to reproduce F65E@v1 selection and primary labels. Missing,
ambiguous, late, or non-exact 3/5/15-minute coverage is reported, never silently repaired.

## Locked Decisions

- Production remains BUY=90 / WATCH=70. PAPER execution remains disabled.
- Phase 9.28 F65E@v1 is closed without promotion. Do not collect more unchanged F65E@v1 runs.
- Phase 9.29 reads completed archives only. It makes no provider calls, active or archive database
  writes, session creation, orders, fills, positions, wallet actions, signing, or submission.
- No strategy-default, provider configuration, quote-demand, observation-cadence, or one/two-minute
  monitoring change is in scope.
- The existing F65E@v1 stored-fact selector remains the sole membership rule for the source cohort:
  normal 90/70 snapshot; `SKIP`; integer score 65-69; recorded `buyEligible`; passing hard risk,
  liquidity, volume, age, quote, and price-impact facts; first eligible mint per run; cap 10.
- The immutable primary label remains the 10% target / 15% stop / 15-minute scenario, calculated
  from exact on-time 3/5/15-minute observations. `TARGET_FIRST`, `STOP_FIRST`, and `MAX_HOLD` are
  labels only. `NO_OBSERVATION` and `AMBIGUOUS` are reported but are not evidence for a successor.
- Later observations, later TokenRadar rows, later risk rows, later provider rows, later strategy
  decisions, or any derived return/MFE/MAE value must never become a candidate feature.
- Do not widen a threshold, add a score band, relax a hard gate, or create a compound rule merely to
  obtain more candidates. A permitted successor may only be a narrower, decision-time entry rule
  with a material factual distinction from F65E@v1.
- No automated classifier, feature ranking, p-value fishing, quantile search, or multi-feature
  optimization is permitted. The report must evaluate the fixed feature catalog below and at most
  one simple successor rule.

## Decision-Time Feature Catalog

Each reported feature must carry its source record, source timestamp, and availability result. If a
value cannot be proved to predate or equal `StrategyDecision.decidedAtMs`, classify it
`UNAVAILABLE_AT_DECISION_TIME`; do not backfill it from a later row.

| Family              | Permitted archived facts                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score attribution   | Stored score; factor name, points, pass state, warnings; raw decision; original 90/70 thresholds; `buyEligible`; duplicate/cap blockers; recorded blocking factors.                                                                       |
| Risk                | Stored risk result, score, flags, authority/freeze state, token program, top-holder evidence, and only the risk assessment explicitly referenced by the decision snapshot.                                                                |
| Market snapshot     | Decision snapshot token source, pair, age, first-seen/discovered timestamps, liquidity, 5-minute and 1-hour volume, baseline price, and the snapshot's decision timestamp.                                                                |
| Momentum            | Decision-time 5-minute versus 1-hour volume evidence and any persisted, decision-time momentum fact. Do not infer momentum from later prices or returns.                                                                                  |
| Quote / impact      | Stored missing-quote and missing-impact flags; buy, sell, and maximum price impact; quote source/provenance only when it is bound to the decision snapshot or referenced risk evidence.                                                   |
| Provider provenance | Token source and provider-health/risk provenance only when a record is deterministically tied to the decision or has a timestamp no later than it. Provider-wide aggregate health is context, not a candidate feature.                    |
| Repeated attention  | Count of same-mint TokenRadar/strategy facts strictly earlier than the decision in the same archived PAPER session; elapsed time from the earliest qualifying pre-decision first-seen fact; and any persisted duplicate-attention marker. |

The implementation must preserve missingness as its own result. It may not turn absent provenance,
quote detail, or repeated-attention evidence into a pass, zero, or inferred value.

## Label Separation And Attribution Rules

1. Reproduce F65E@v1 candidate selection from archived `StrategyDecision` snapshots before loading
   any watchlist-return rows.
2. Attach the fixed primary outcome after selection. Features are immutable once extracted; label
   attachment may not mutate the feature record or selection result.
3. Report `TARGET_FIRST`, `STOP_FIRST`, and `MAX_HOLD` separately. For any binary diagnostic,
   `STOP_FIRST` plus `MAX_HOLD` may be shown as `NON_TARGET`, but the two source labels remain
   visible and no claim may rely only on that pooled presentation.
4. For every catalog feature, show group count, available/missing count, exact observed values or
   fixed descriptive summaries, and group differences. All output is descriptive and must include
   the run label for every candidate-level row.
5. Score and factor ties must be stated. The report must not imply discrimination where the stored
   feature has no variation in the selected cohort.
6. Outcome return, MFE, MAE, observation timestamps after decision, outcome run labels, and all
   outcome-derived quantities are prohibited from the feature table, threshold construction, and
   successor predicate. They may appear only in the explicitly labeled outcome section.

## Defensibility Gate And Allowed Outcomes

Before a successor can be proposed, the report must apply all of these fixed gates:

- all three source archives are mechanically valid, read-only, and reproduce the Phase 9.28 F65E
  selection/counts;
- each compared label has at least three exact-coverage candidates;
- both target-first and non-target evidence occur in at least two independent source runs;
- no source run supplies more than 40% of either compared label or more than 40% of the selected
  attribution cohort;
- leaving out any one source run retains the same directional distinction for the proposed feature;
- leaving out any one selected mint retains the same directional distinction for the proposed
  feature;
- the proposed predicate is one named decision-time fact or one already-persisted categorical
  state, has no threshold search, does not relax an F65E hard gate, and excludes rather than admits
  additional F65E candidates;
- the report explains why the predicate is materially different from F65E@v1 and why it could be
  evaluated prospectively from stored facts alone.

If any gate fails, the only permitted recommendation is `NO_DEFENSIBLE_HYPOTHESIS`. The report must
list every failed gate, including label/run concentration. It must not return `collect more data`,
recommend an unchanged continuation, or manufacture a successor.

If every gate passes, the only alternative is `PRE_REGISTER_SUCCESSOR_HYPOTHESIS`. Its report must
contain exactly one profile identifier and version; a plain-language rationale; the complete,
deterministic decision-time predicate; all exclusion codes; immutable 90/70 source baseline; the
unchanged 3/5/15-minute observation schedule and two-minute lateness rule; the 10%/15%/15-minute
primary label; and the fixed future collection/promotion gates below. The report is planning output
only and cannot authorize implementation, monitoring, or PAPER BUY.

## Future Collection And Promotion Contract (Only If A Successor Is Emitted)

The report must pre-register these requirements verbatim for a later separately approved phase:

- collect exactly three new, independent 120-minute PAPER/shadow-only runs from reset PAPER
  databases, with normal BUY=90 / WATCH=70 collection and unchanged provider configuration;
- select only the successor's fixed, narrower decision-time predicate; retain F65E's first eligible
  mint per run and cap of 10; do not widen any score or hard-factor threshold to fill the cohort;
- use only exact on-time 3/5/15-minute watchlist observations, with the existing two-minute
  lateness boundary; do not add one- or two-minute monitoring;
- require at least 20 selected candidates with exact 15-minute coverage, 15 unique mints, no
  selected mint or run above 40% of the cohort, and stable leave-one-run-out and leave-one-mint-out
  direction;
- require primary target-first at least 55%, stop-first at most 25%, target-first minus stop-first
  at least 20 percentage points, median MFE at least +10%, and median MAE above -15%; and
- a passing result can authorize only a separate promotion review. It never enables orders, fills,
  positions, wallet loading, signing, submission, or paper BUY.

## Implementation Chunks

### Chunk 1 - Archive-Only Command Contract

- [ ] Add a dedicated Phase 9.29 config and typed runtime contract under a new attribution-only
      module (for example `backend/src/shadow-fast-attribution/`).
- [ ] Accept only repeated `--label-run=<label>:<archive-path>`, `--once`, `--json`, and explicit
      `--output-dir` options. Require archive paths under `data/archive/` and unique labels.
- [ ] Reject database/session/provider/strategy/threshold/observation/wallet/signing/submission and
      unbounded-loop options before archive loading.
- [ ] Require `MODE=PAPER` without loading a wallet or initializing an execution service.
- [ ] Declare and print the read-only safety boundary: archived SQLite opens only, provider calls
      false, database writes false, sessions false, and execution false.

Complete when the command has no dependency path to a provider adapter, runtime runner, session
manager, order/fill/position repository writer, or wallet surface.

### Chunk 2 - Reproducible Source Cohort And Labels

- [ ] Reuse `ResearchRunArchiveLoader` and the read-only archived-database loader; do not add an
      active-database mode.
- [ ] Reuse the exact `FastShadowCandidateSelector` source contract and preserve decision-time then
      decision-ID ordering, duplicate suppression, and session cap.
- [ ] Extract or reuse a small pure primary-label resolver so Phase 9.29 exactly matches the
      F65E@v1 10% target / 15% stop / 15-minute outcome semantics and exact-coverage rule.
- [ ] Assert the report's selected counts, classifications, coverage, and primary label totals
      match the supplied Phase 9.28 exit-validator report when that report is present; otherwise show
      an explicit reproducibility warning.
- [ ] Preserve `NO_OBSERVATION` and `AMBIGUOUS` records as controls and exclude them from inference.

Complete when changing a later observation can change only its outcome label and cannot change
membership, feature values, availability, or a proposed entry predicate.

### Chunk 3 - Time-Safe Feature Extraction

- [ ] Implement a fixed typed feature registry for the catalog above, including source table/JSON
      path, source timestamp, availability reason, and scalar/categorical representation.
- [ ] Parse `StrategyDecision.inputSnapshotJson` defensively and reuse `ScoreAttributionService`
      where it represents stored facts faithfully.
- [ ] Resolve risk evidence only through the snapshot's stored risk identifier; reject mismatched,
      missing, or post-decision risk rows rather than joining by mint alone.
- [ ] Build repeated-attention metrics with strict `< decidedAtMs` filters and a deterministic
      same-session ordering. Never count the selected decision itself or later rows.
- [ ] Bind provider provenance only where the archive contains a deterministic decision-time link;
      otherwise emit `UNAVAILABLE_AT_DECISION_TIME`.
- [ ] Round only formatter output. Keep stored numeric precision in analysis and never coerce
      unavailable values to zero.

Complete when each candidate feature can be traced to an archived, pre-decision source field.

### Chunk 4 - Descriptive Attribution Report

- [ ] Add immutable report types for candidate feature rows, per-label summaries, missingness,
      run/mint concentration, and failed defensibility gates.
- [ ] Produce factor-level score attribution, risk, age, liquidity, volume, momentum, quote/impact,
      provenance, and repeated-attention sections with label-separated counts and values.
- [ ] Display candidate identifiers only as bounded archive IDs/symbols already present in the
      research record; omit raw provider payloads, URLs, database paths in candidate rows, and secrets.
- [ ] State the sample size and lack of feature variation before any comparison. Never calculate or
      imply statistical significance from this seven-candidate discovery cohort.
- [ ] Emit human-readable text and deterministic JSON artifacts only to an explicit archive output
      directory.

Complete when a reviewer can see every decision-time fact used, every unavailable fact, and every
outcome label without confusing labels for inputs.

### Chunk 5 - Hypothesis Selection And Pre-Registration

- [ ] Implement the fixed defensibility gates exactly as documented above, including independent
      run support and leave-one-run/mint-out checks for the proposed feature direction.
- [ ] Permit at most one candidate successor and only after the gate passes; prohibit score-band
      widening, hard-gate relaxation, compound predicates, and automatic numeric cutpoint searches.
- [ ] Require a successor predicate to be a strictly narrower subset of reproduced F65E candidates
      and prove subset membership from stored decision-time facts.
- [ ] When every gate does not pass, emit `NO_DEFENSIBLE_HYPOTHESIS`, enumerate all failures, and
      omit any candidate collection command or profile implementation advice.
- [ ] When every gate passes, emit `PRE_REGISTER_SUCCESSOR_HYPOTHESIS` with the entire future
      collection/promotion contract, explicit profile key/version, and no execution authorization.

Complete when the combined Phase 9.28 cohort can fail cleanly without incentivizing another
unchanged data batch.

### Chunk 6 - Script, Packaging, And Isolation

- [ ] Add one archive-only script (for example `shadow:fast-feature-attribute`) in the backend and
      root package manifests.
- [ ] Keep the script outside `TerminalRunner`, `shadow:fast-observe`, and all default automation.
- [ ] Do not create a migration, modify strategy configuration, register a provider, or change a
      runtime observation service.
- [ ] Write artifacts only when an explicit output directory is supplied; otherwise print the
      bounded report to stdout.

Complete when invoking the script cannot create or mutate an active PAPER session.

### Chunk 7 - Tests And Verification

- [ ] Test argument parsing, archive-path validation, unique labels, required output behavior, and
      rejection of every forbidden runtime/execution option.
- [ ] Test read-only archive opening and prove zero provider calls, writes, sessions, orders, fills,
      positions, wallet loading, signing, and submission.
- [ ] Test exact F65E selection/ordering/cap reproduction and the primary label resolver against
      known 3/5/15-minute rows, including late, missing, and ambiguous coverage.
- [ ] Test every feature family for correct snapshot extraction, pre-decision timestamp enforcement,
      missingness, risk-ID matching, and repeated-attention exclusion of current/later rows.
- [ ] Add regression cases where future returns, later TokenRadar rows, later risk/provider rows,
      and outcome labels are changed; selection, features, availability, and predicate eligibility must
      remain unchanged.
- [ ] Test tied score/factor output, concentration calculations, leave-one-run/mint-out gates,
      no-threshold-search enforcement, and `NO_DEFENSIBLE_HYPOTHESIS` on the current concentrated
      source shape.
- [ ] Test the sole permitted successor output with a synthetic, independently supported archived
      fixture, including full pre-registration fields and the no-paper-BUY assertion.
- [ ] Run `corepack pnpm verify` before any archive smoke.

### Chunk 8 - Archive Smoke And Documentation

- [ ] Run the command only against the three archived Phase 9.28 source runs and write output under
      `data/archive/phase9.29/` after implementation approval.
- [ ] Confirm the smoke retains zero provider calls, database writes, session creation, orders,
      fills, positions, wallet loading, signing, and submission.
- [ ] Confirm the current cohort's per-run selected/label totals, missingness, concentration, and
      failed defensibility gates are visible.
- [ ] Update the roadmap, decisions, planning inputs, and structure with the actual report path and
      either the named successor contract or the explicit no-defensible-hypothesis conclusion.
- [ ] Do not begin a successor implementation or fresh collection in the Phase 9.29 closeout.

## Acceptance Criteria

- [ ] The command reads only completed archive databases and creates no active runtime state.
- [ ] F65E membership and the primary outcome are reproduced exactly and remain separated.
- [ ] Every reported candidate feature is demonstrably available at decision time or marked
      unavailable.
- [ ] Labels and later observations cannot influence selection inputs or feature values.
- [ ] The feature catalog is fixed, missingness is explicit, and no automatic threshold or compound
      rule search exists.
- [ ] The output is exactly one of `NO_DEFENSIBLE_HYPOTHESIS` or
      `PRE_REGISTER_SUCCESSOR_HYPOTHESIS`.
- [ ] A successor, if any, is narrower, material, versioned, deterministic, and contains immutable
      collection/promotion gates; it does not change production defaults or authorize paper execution.
- [ ] The actual Phase 9.28 cohort does not trigger further unchanged F65E collection.

## Phase 9.29 Closeout

Implemented August 18, 2026. The archive-only command is:

```text
pnpm shadow:fast-feature-attribute --once --label-run=<label>:<archive-path>
```

The completed three-run smoke archive is:

```text
data/archive/phase9.29/combined-valid-three-20260818-1539
```

It reproduced 7 selected candidates with exact 3/5/15-minute coverage and the fixed primary
labels: 3 `TARGET_FIRST`, 3 `STOP_FIRST`, and 1 `MAX_HOLD`. It recorded no provider calls,
database writes, session creation, orders, fills, positions, wallet loading, signing, or submission.

The result is `NO_DEFENSIBLE_HYPOTHESIS`. Test3 supplied 85.71% of the selected cohort and all
non-target labels, so the fixed independent-label-run, concentration, leave-one-out, and
narrower-predicate gates failed. No successor profile was emitted, and no new F65E collection or
strategy change is authorized.

## Known Limitations

- The Phase 9.28 combined cohort contains only seven exact-coverage candidates; outcome labels are
  concentrated in one run. Attribution can describe this evidence but cannot establish causality.
- Discrete 3/5/15-minute observations do not model intra-interval path, executable fills, fees,
  slippage, latency, liquidity collapse, or MEV.
- Provider-wide health and unlinked provenance are not candidate facts. Treating them as such would
  create a time-alignment or attribution error.
- Phase 9.29 is not a low-latency monitoring design and cannot resolve one- or two-minute entry
  timing questions.

## Phase Handoff

Phase 9.29 may conclude only:

```text
NO_DEFENSIBLE_HYPOTHESIS
  -> retain 90/70 defaults, PAPER execution disabled, and do not collect another unchanged F65E batch

PRE_REGISTER_SUCCESSOR_HYPOTHESIS
  -> request separate approval before implementing or collecting the explicitly registered successor
```
