# Phase 9 Planning Inputs

TerminalRunner Handoff After Phase 8.92 / 8.92B / 8.93 Review

Last updated: 2026-09-09

Current handoff: Phase 10.6A.2 V3 collection remains frozen through its final September 18 noon PDT
anchor. Phase 10.6B.3 is implemented with an initial passing synthetic suite; H1 verification gaps,
final-state review, identity binding, and separate stdout-only run approval remain open. Phase 10.6H is
planned engineering hardening, with physical isolation required for implementation while V3 runs.
No candidate, 10.6C study, or PAPER pilot exists. Read the
[Post-V3 Development Plan](./Post-V3-Development-Plan.md) and
[10.6H checklist](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md) for the next work packages and gates.

Historical foundation status: Phase 8.91 diagnostics, Phase 8.92 shadow entry-gate experimentation,
Phase 8.92B report refinement, Phase 8.93 strategy promotion review, Phase 9 TerminalRunner, Phase 9.1 cross-run
research aggregation, Phase 9.2 quote resilience, Phase 9.2B provider truthing, and Phase 9.25
research interpretation are complete. Phase 9.3 Raydium quote fallback implementation is complete,
Phase 9.3B Raydium/Helius diagnostics validation is complete, Phase 9.3C Helius fallback / RPC
authority evidence is complete, Phase 9.4 Birdeye selective enrichment is complete, and Phase 9.4A.1
archive/reporting truthing is implemented and smoke-validated.
Four fresh Phase 8.92 validation runs found useful WATCH, duplicate-attention, and score 65-69
signals. Three fresh Phase 8.92B validation runs confirmed the research framework is working, but
Phase 8.93 promoted no profile into paper strategy defaults. Phase 9 automated the shadow loop.
Phase 9.1 confirmed the first Phase 9 batch is promising research, not controlled paper pilot
evidence yet. Phase 9.2B cleaned the provider metrics so Phase 9.25 could interpret skipped
opportunities using live-vs-router provider pressure. Phase 9.25 selected Phase 9.3 Raydium quote
fallback as the next provider step. Phase 9.3 has now implemented the quote-only adapter and
provenance reporting. Phase 9.3B showed that Raydium diagnostics work, but discovered-candidate
Raydium quotes are not healthy enough yet and Helius free-plan credits can be exhausted by long
validation.
Phase 9.4A.1 added `research:truth`; its closeout patch makes generated archives compact by default,
reports only live Birdeye CU estimates, and distinguishes direct from correlated missing-quote
evidence. Phase 9.4A.2 adapter correctness/diagnostics is next before quote-pressure runtime
changes or provider expansion. Phase 9.4A.3 is conditional only if A.2 proves existing bounded
diagnostics cannot retain the required evidence; otherwise Phase 9.4B follows with venue-aware
routing considered when no-route outcomes dominate.

Phase 9.4B is runtime-validated: its Raydium controls avoided thousands of futile fallback
requests, but Jupiter live rate limiting stayed around 23% in each full run. Phase 9.4C then
implemented one shared adaptive Jupiter price/quote budget. Phase 9.4D is now fully
runtime-validated across three 120-minute PAPER/shadow-only runs: 195 planner-enabled risk cycles
selected 3,900 quote candidates, explicitly deferred 1,814 local quote requests, retained 96.44%
selected-candidate quote coverage, and recorded zero Jupiter upstream 429s. Helius remains
excluded from this quote-only experiment because Solana RPC and QuickNode DAS provide
authority/metadata evidence.

The remaining constraint is strategy evidence, not quote-provider capacity. The three-run research
aggregate contains 850 observed decisions across 30 unique mints and has `PROMISING_RESEARCH` /
`MEDIUM` confidence, but no profile clears the promotion workbench. Phase 9.26 counterfactual
analysis is now implemented and archive-smoke validated. Its 65/60 threshold sensitivity promoted
27 historical rows, but 74.07% came from one mint and 81.48% from one run. Phase 9.27 is now
implemented as a read-only `T65N@v1` validator for a fresh, pre-registered 65-69 threshold-only
cohort from completed archives. Its initial Phase 9.4D smoke selected only 3 candidates from 27
eligible rows and returned `COLLECT_MORE_INDEPENDENT_DATA`. Six fresh Phase 9.27 runs added 19
unique selected candidates and passed the minimum-count and concentration requirements, but failed
both leave-one-out requirements. Every selected row scored 65, leaving 66-69 unobserved. Normal
strategy collection remains at BUY=90 / WATCH=70; do not tune production
thresholds, add providers, buy a Jupiter plan, or enable paper BUY from that result alone.

Phase 9.27 is now complete. Its final valid eight-run cohort selected 24 unique mints and passed
concentration plus leave-one-out sample checks, but the primary 10/10/60 outcome was 13 target-first,
9 stop-first, and 2 neither with median MAE `-11.44%`. The outcome is
`REJECT_NARROW_THRESHOLD`. The original QuickNode-expiry Test 8 is excluded and was replaced by a
valid Alchemy-backed Test8R. Keep normal BUY=90 / WATCH=70 strategy collection unchanged.

Phase 9.28 is complete and closed without promotion. `F65E@v1` used stored 65-69 candidate facts,
fresh 3/5/15-minute observation coverage, and one primary +10% target / -15% stop / 15-minute
scenario. Its three valid fresh 120-minute archives selected seven exact-coverage candidates:
Test1=0, Test2=1, Test3=6. The primary result was 3 target-first, 3 stop-first, and 1 maximum-hold.
It failed the pre-registered sample, concentration, stability, and primary outcome gates.
`shadow:fast-observe` wrote only ordinary PAPER watchlist rows and
`shadow:fast-exit-validate` read completed archives only. Do not collect more unchanged F65E runs
or revisit a broad lower entry threshold from this result. One- and two-minute sampling needs a
later dedicated low-latency design; paper BUY, provider expansion, and wallet behavior remain
disabled.

## Phase 9.29 Handoff - Fast-Entry Feature Attribution And Hypothesis Selection

Phase 9.29 is the recommended next planning and implementation step. It is read-only research,
not a new live-data validation batch. Its question is:

```text
What distinguished F65E@v1 target-first candidates from stop-first and maximum-hold candidates
before their original strategy decision?
```

Inputs are the completed Phase 9.28 Test1-Test3 archives and their combined report. Compare only
facts available at decision time, including score attribution, risk facts, age, liquidity, volume,
momentum, quote and price-impact evidence, provider provenance, and repeated-attention evidence
when stored. The later 3/5/15-minute outcome is an analysis label only; no future data may become a
selection feature.

Required output:

```text
either
  one named, versioned, materially different successor hypothesis with fixed entry facts,
  collection protocol, and promotion gates
or
  an explicit no-defensible-hypothesis finding
```

Phase 9.29 must make no provider calls, database writes, sessions, orders, fills, positions,
wallet actions, signing, submission, strategy-default changes, or one/two-minute monitoring work.
It is not permitted to create a new profile merely to continue testing.

Implementation and archive smoke are complete. The archive-only command is
`pnpm shadow:fast-feature-attribute --once --label-run=<label>:<archive-path>`. Its combined
three-run report is `data/archive/phase9.29/combined-valid-three-20260818-1539` and concludes
`NO_DEFENSIBLE_HYPOTHESIS`. The source facts showed no score/factor variation across the seven
selected rows, and label/run concentration failed the fixed independence gates. Retain normal
BUY=90 / WATCH=70, PAPER execution disabled, and do not start a successor collection from this
finding.

Detailed implementation checklist:

- [NeXusTrade-Phase-9.29-Detailed-Checklist.md](./NeXusTrade-Phase-9.29-Detailed-Checklist.md)

## Phase 10 Handoff - Local Research Dashboard And Archive Explorer

Phase 10 is implemented. It is an evidence-inspection phase, not a new strategy experiment. The
local dashboard browses completed canonical archives, cohorts, candidates, structured reports, and
provider pressure; compares `TARGET_FIRST`, `STOP_FIRST`, and `MAX_HOLD`; and shows candidate-level
decision-time score attribution and research facts with provenance and missingness.

Use known structured reports first, then only whitelisted read-only archive-database fields where a
report does not contain a required fact. Do not parse terminal transcripts. Keep decision-time facts
separate from later outcome labels in both exported data and UI. The known Phase 9.28 / 9.29 cohort
remains descriptive only: seven exact-coverage candidates, 3 target-first, 3 stop-first, 1
maximum-hold, and `NO_DEFENSIBLE_HYPOTHESIS`.

The locked first-pass shape is a one-way read-only archive exporter plus static local Vite/React
dashboard. It has no provider calls, database writes, active database reads, session creation,
runtime command, wallet action, signing, transaction submission, order/fill/position, or paper
execution control. Keep normal BUY=90 / WATCH=70 and PAPER execution disabled.

Archive hygiene completed during this handoff: the 16 completed Phase 9.27/9.28 root run snapshots
and 66 loose root reports now live under the matching
`data/archive/phase9.27|phase9.28/legacy-root-artifacts-20260818/` folders. These recoverable
cleanup copies must be excluded from the canonical dashboard catalog. The active
`data/nexus_paper.db*` files remain at `data/` root and are excluded from dashboard input.

Phase 10 implementation result: `shared/src/research-dashboard.ts` supplies the versioned browser
contracts; `backend/src/research-dashboard/` and `backend/src/scripts/dashboard-export.ts` export
only explicit archived structured evidence; and `frontend/` is the local Vite/React viewer. The
initial approved export selected `phase9.28`, `phase9.29`, and
`phase9.29/combined-valid-three-20260818-1539`, yielding 5 runs / 1 cohort / 7 candidates with
content fingerprint `b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`. Generated JSON
is ignored under `frontend/public/research-dashboard-data/` and must be refreshed manually.

Phase 10.1 closes only presentation/evidence-traceability gaps: the static viewer now exposes
archived report kinds; run membership, recorded concentration, and gates; provider-pressure
categories including optional quote-budget/controller/venue-guard facts; and original decision,
score, and threshold context before later outcomes. Its phase/run/report-kind/provider-evidence
filters are local display state only. Missing optional facts are `NOT_REPORTED`; later labels remain
descriptive and are never selection inputs.

Verification: 103 backend test files / 339 tests, 2 frontend test files / 4 tests, the Vite
production build, and a `127.0.0.1` static-asset smoke passed. The export tests retained zero
provider calls and no database mutation; no sessions, orders, fills, positions, wallet behavior,
signing, submission, strategy defaults, thresholds, or monitoring cadence changed. The next work is
a human evidence review, not an authorized Phase 9.30 or successor profile.

## Phase 10.4 Implemented Handoff - Local Research Brief Generator And Review Protocol

Phase 10.4 implementation result: `research:brief` is a deterministic local CLI that reads one
explicit completed archive scope and prints a source-traceable Markdown or JSON brief for direct
reviewer/Codex analysis. The initial Phase 9.28/9.29 fixture reads five TerminalRunner summary JSON
reports and the named Phase 9.29 attribution JSON report. It produced fingerprint
`5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7`, reproducing the recorded
3/3/1 labels, Test3 concentration, failed gates, and `NO_DEFENSIBLE_HYPOTHESIS` conclusion.

The command reads known structured archive JSON only and writes to standard output only. It has no
provider/RPC/HTTP calls, database read or write, archive write, runtime/session command, execution,
wallet, strategy, threshold, provider, or monitoring behavior. A brief can report only
`NO_DEFENSIBLE_HYPOTHESIS`, `DATA_INSUFFICIENT`, or `HUMAN_REVIEW_REQUIRED`; it cannot create a
successor hypothesis, authorize collection, or enable PAPER execution. The full verification passed:
107 backend test files / 351 tests, 4 shared test files / 13 tests, 2 frontend test files / 4 tests,
format, lint, typecheck, and secret scan.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.4-Detailed-Checklist.md](./NeXusTrade-Phase-10.4-Detailed-Checklist.md)

## Phase 10.5 Implemented Handoff - Human Review And Pre-Registration Gate

Phase 10.5 implementation result: `research:review-gate` is a bounded local human-review gate over
the completed Phase 10.4 archive brief. It accepts only the explicit Phase 9.28/9.29 archive scope
and `docs/research-reviews/phase10.5-initial.v1.json`. It recomputes the brief in memory and prints
one source-traceable Markdown or JSON result to standard output. The initial record hash is
`07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f`, and its gate fingerprint is
`2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b`. The command pins that record
hash at runtime; a changed record requires a new approved versioned path.

The six-source evidence records the required `NO_STUDY_AUTHORIZED` outcome: Phase 9.29 remains
`NO_DEFENSIBLE_HYPOTHESIS`, with seven candidates concentrated in Test3. Review assertions use only
known fact-key/assertion-code enums and optional bounded sanitized notes. The implementation rejects
candidate data and every non-default-deny status; generic candidate validation remains documented
but deferred. It has no providers/RPC/HTTP calls, database access, runtime services, wallets,
execution, strategy/defaults, thresholds, providers, monitoring, sessions, orders, fills, or
positions. It does not authorize Phase 10.6.

Verification: `corepack pnpm verify` passed: format, lint, typecheck, 110 backend test files / 360
tests, 4 shared test files / 13 tests, 2 frontend test files / 4 tests, and the secret scan.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.5-Detailed-Checklist.md](./NeXusTrade-Phase-10.5-Detailed-Checklist.md)

## Proposed Phase 10.5A Handoff - Research Restart Criteria And Exploratory Cohort Design

Phase 10.5A is planned only. It is the safe research-restart step after the completed
`NO_STUDY_AUTHORIZED` review: it designs an outcome-blind exploratory cohort but does not collect
it. It cannot revive F65E@v1, lower/widen a score threshold, create a successor profile, or enable
PAPER execution.

The future protocol must fix the following before a collection phase can be proposed:

- broad population and explicit exclusions using decision-time facts only;
- mint and market-window deduplication, independent-window targets, and provider-budget limits;
- timestamped decision-time fields, source/provenance, missingness, and quote-freshness rules;
- later observation horizons and labels that are evaluation-only;
- discovery/validation partitioning that prevents outcome-selected predicates;
- bounded data-quality and safety stop conditions; and
- the distinction between an observational exploratory cohort and a strategy-validation cohort.

Phase 10.5A is implemented as a conservative V1 protocol: 2-hour UTC enrollment
slots, 96 planned / 72 minimum units, no repeat mint, at least 8 UTC dates, 20% maximum date share,
four descriptive horizons, fixed missingness/freshness rules, a 50/50 deterministic
discovery/validation split, bounded provider categories, immutable archive retention, and fail-closed
data-quality stops. It also requires a strict local stdout-only `research:protocol:validate` command;
a validation-ready result remains non-authorizing and still requires separate Phase 10.6A approval.
The frozen protocol is `docs/research-protocols/phase10.6a-exploratory-cohort.v1.json`, SHA-256
`748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`; its local validator returned
`PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` with fingerprint
`2a21ec935618ebf7f7fed628c7f276474a104fb55dcb9f45f4a721bf4e9833e5`.

Proposed downstream gates:

```text
Phase 10.6A  Collect the frozen exploratory cohort with real market data, shadow-only
Phase 10.6B  Analyze completed cohort archives; its only positive result is non-authorizing
            PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL for a separate candidate draft
Phase 10.6B.1 Audit decision-time measurement availability and missingness without later labels
Phase 10.6B.2 Design and statically review one measurement-only successor protocol, if supported
Phase 10.6B.3 Analyze the final V3 archive's frozen measurement-capability gates after separate
            identity binding and exact-root approval; no active-archive analysis during implementation
Phase 10.6H  Parallel engineering hardening; H1 verification precedes final binding, H2-H4 precede
            future dependent operations; no candidate or promotion authority
Future research-design gate: confirmed V3 capability -> separate design/collection/analysis decisions
            -> actual defensible candidate evidence; no successor protocol selected now
Phase 10.6C  Blocked unless a future separately approved candidate exists
Phase 10.7   Blocked unless a future Phase 10.6C validation succeeds
Phase 10.7A Blocked unless Phase 10.7 promotes a frozen profile; pre-registers, but never enables,
            a bounded Paper-Pilot Experiment Protocol
```

Phase 10.6A now has an implemented collection checklist and isolated collector. It requires a new
archive-only collector rather than the existing scanner/watchlist runtimes, which create PAPER
sessions and database rows. Its live-observation allowlist, deterministic 2-hour-slot process,
archive contract, and data-quality stops are all fixed before implementation. The checklist itself
does not authorize a provider call or collection run.

For proposed Phase 10.6A collection only, immutable V2 supersedes the historical V1 protocol. V2
keeps the 168-slot, 96-planned/72-minimum outcome-blind design but gives each required provider
category one cap per attempted slot and later observations four caps per attempted slot. It fixes the
exact `discoverTokens(100)` capability call, a non-overlapping slot-end-minus-60-second invocation
schedule, and an exclusive archive-root lock. The lock must precede initial artifacts; stale
new-root locks close as incomplete without a provider call. Source inventory and final summaries
retain only the canonical sanitized and aggregate evidence contract. V1 remains preserved for
historical validation; neither record authorizes collection.

The implemented collector is invoked only through
`pnpm research:exploratory-cohort:collect --`. It requires a pinned V2 protocol, a separately
created source-controlled launch record, one `YYYYMMDD-0000Z` root, and `--once`. No launch record
or archive was created during implementation; local fake-clock tests include stale-lock closeout,
which finalizes an interrupted root as incomplete before another provider call, including before
initial artifacts. `corepack pnpm verify` passed locally on 2026-08-19: backend 114 files / 379
tests, frontend 2 / 4, shared 4 / 13.

The Phase 10.5A checklist and its sole permitted implementation command,
`research:protocol:validate`, must remain local/read-only: no providers, RPC, database, market
runtime, sessions, filesystem data writes, strategy changes, paper orders, wallet, signing, or
submission.

The first separately authorized Phase 10.6A launch is
`data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z`, beginning
`2026-08-21T00:00:00.000Z`. Its matching source-controlled launch record passed local
config/launch/protocol validation while the archive root was absent; the validation made zero
provider calls, database reads, or filesystem writes. The separately authorized external schedule
then reached the frozen 96-valid-unit completion target after 100 attempted slots and finalized
`COHORT_COMPLETE` on 2026-08-29. The final archive contains 382 `OBSERVED_ON_TIME` and 2 `MISSING`
later labels, no active lock, and zero database/execution safety counters. Its file hashes are
recorded in the Phase 10.6B checklist. The collector task is disabled; the scheduled provider-free
confirmation completed successfully at 6:01 PM PDT on 2026-09-03 with exit code zero. The archive
remains observational evidence only and does not authorize an execution action.

Phase 10.6A.1 is implemented and launch-blocking before scheduler arming. It preserves the frozen
V2 protocol and normal schedule, makes missed external invocations auditable as canonical
zero-request availability rows, authenticates active manifest/unit/source evidence, and provides
only a strict provider-free post-window archive closeout. The normal 168 starts are unchanged; the
one additional `2026-09-04T01:01:00.000Z` closeout is not a market-observation slot. It neither
starts the named collection nor authorizes a provider call, strategy change, Phase 10.6B analysis,
PAPER action, wallet, signing, submission, order, fill, or position.

Detailed implementation checklist:

- [NeXusTrade-Phase-10.5A-Detailed-Checklist.md](./NeXusTrade-Phase-10.5A-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6A-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md](./NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md](./NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md)

Phase 10.6B's pre-collection checklist is reconciled to the one completed V2 archive, and its strict
archive-only/stdout-only analyzer was implemented on 2026-08-30 using temporary synthetic fixtures
only. It hard-pins the approved four-file archive identity. After the provider-free closeout, the user
separately authorized and ran it once against that immutable archive; the report verified
`archiveIdentity: MATCHED`, passed all fixed quality gates, and returned
`NO_DEFENSIBLE_HYPOTHESIS` with content fingerprint
`5b57410a3fa9164ba2671f7fb118fdda65985802b56411f67e4835f1fdde39b6`. No discovery rule advanced to
held validation, so no candidate, Phase 10.6C pre-registration, collection, PAPER execution, or
promotion is authorized.

Phase 10.6B.1 is closed as an archive-only decision-time measurement and missingness audit. It assessed
only the V2 archive's field availability, bounded missingness
classes, sanitized provenance/capability evidence, and date/partition distributions. It must not read
or use later labels, select a rule, infer a candidate, alter the archive, call a provider, access the
database/runtime, or enable a PAPER or execution path. Its only possible forward-looking conclusion
is that a specific measurement-only protocol revision may be drafted for separate review; that is not
a protocol, collection, Phase 10.6C, strategy, or promotion authorization. Its separately approved
real-archive run returned `MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW` from replicated
decision-time availability facts only: `LIQUIDITY` was unavailable at anchor across both partitions,
and `MOMENTUM_5M` / `MOMENTUM_15M` were unsupported across both partitions. A pinned V3
measurement-only protocol source and isolated static validator now exist. Its one separately approved
stdout-only real-source validation returned
`MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW`; that static result
itself grants no collection or execution authority.

Phase 10.6A.2 is now implemented and synthetically verified as the isolated V3 measurement-only
collector. It fixes no additional provider and no fallback: one direct liquidity observation at anchor
and four fixed price snapshots through the anchor for the two local momentum calculations. Its named launch
record for `measurement-v3-20260904-2100Z` is approved and locally validated. The operator-owned
scheduler was then registered and armed for that exact root on 2026-09-04, so the frozen V3
measurement-only collection is active. Do not alter its protocol, root, or schedule and do not infer
an interim strategy result from it. The later archive-only analysis gate remains separate and Phase
10.6C remains blocked.

Phase 10.6B.3 was implemented and synthetically verified in parallel on 2026-09-09 without reading
the active V3 archive. Review of its initial 11-test suite identified missing required cases; Phase
10.6H H1 must complete the requirement-to-test evidence before final identity binding. Its production
command must refuse to open an archive until a separately reviewed source-only identity binding
registers the final four artifact hashes. Its final report will
use only frozen V3 availability, freshness, provenance, independence, and safety gates; it cannot
select a V4 remedy, authorize collection, advance Phase 10.6C, alter strategy/PAPER behavior, or
access an execution surface.

## Engineering Improvement And Post-V3 Handoff

Phase 10.6H addresses existing-code integrity through H1 analyzer verification, H2 accounting/schema/
migrations/reconciliation, H3 provider concurrency, and H4 dependency boundaries/validation/workflow.
Its implementation is planned, not completed or started by this documentation update. Later parallel
work must use a physically isolated checkout, dependencies, and synthetic/temporary data; do not
change the operational checkout or machine-wide settings used by V3. Follow the detailed isolation
and integration rules in [10.6H](./NeXusTrade-Phase-10.6H-Detailed-Checklist.md).

The final invocation starts September 18 at 11:44 AM PDT and anchors at noon PDT. After its exit,
follow the existing operator runbook and separately review finality before hashing/binding and the
one approved analysis. A missed slot, lock, nonfinal archive, or integrity error does not authorize
an extra collector invocation or repair. See the exact closeout sequence and outcome branches in the
[Post-V3 Development Plan](./Post-V3-Development-Plan.md).

That plan also records the missing evidence-producing research-design gate before 10.6C and assigns
prospective acceptance requirements to 10.6C through 10.9 and 11-14. It selects no new hypothesis,
protocol, sample size, provider, pilot rule, or strategy threshold. Engineering completion and
measurement capability remain separate from candidate evidence and operational permission.

## Proposed Paper Operations Dashboard And Pilot Pathway

This pathway is planned only; it does not override the current Phase 9.29
`NO_DEFENSIBLE_HYPOTHESIS` conclusion or authorize shadow collection, paper execution, or wallet
behavior today.

```text
Phase 10.4  Deterministic archive brief
Phase 10.5  Human review and one materially distinct study pre-registration, if evidence supports it
Phase 10.5A Research restart criteria and exploratory cohort design
Phase 10.6A Exploratory cohort collection
Phase 10.6B Exploratory cohort analysis and hypothesis decision
Phase 10.6B.1 Archive-only decision-time measurement and missingness audit (closed; separate protocol drafting may be proposed)
Phase 10.6B.2 Measurement-only protocol design and static review (closed; static result supports only a separate V3 collection checklist)
Phase 10.6A.2 V3 measurement-only cohort collector (implemented, synthetically verified; named root is actively collecting under the frozen operator schedule)
Phase 10.6B.3 V3 final measurement capability analysis and remediation decision (implemented; initial suite passes, H1 verification gaps open; final archive, identity binding, and run approval required)
Phase 10.6H Engineering integrity and development hardening (planned parallel track; H1 analyzer verification before binding; H2-H4 before dependent future operations)
Future research-design gate: separately approved outcome-aware study and actual candidate evidence after confirmed V3 capability; no successor protocol selected now
Phase 10.6C Independent real-market shadow validation (blocked: no candidate)
Phase 10.7  Promotion review (blocked upstream)
Phase 10.7A Paper-Pilot Experiment Protocol (proposed, blocked upstream; documentation/pre-registration only)
Phase 10.8A Separate read-only Paper Operations Dashboard (blocked pending Phase 10.7 and 10.7A)
Phase 10.8B Controlled paper pilot with a frozen promoted version, 10.7A protocol, applicable H2-H4 acceptance, and named-pilot approval (blocked upstream)
Phase 10.9  Pilot assessment and versioned revision decision (blocked upstream)
Phase 11    Live-readiness hardening
Phase 12    Tiny guarded live-trade experiments
Phase 13    Provider/infrastructure/strategy expansion only when measured needs justify it
Phase 14    Low-cap autonomous live-wallet pilot, only after all prior gates
```

Phase 10.8A is intentionally separate from the Phase 10 archive viewer. It will be a local,
read-only operational view over active PAPER state and must show sessions, orders, fills,
open/closed positions, realized P/L, unrealized P/L, daily/cumulative P/L, equity/drawdown,
exposure, quote provenance, mark time, and stale-mark status. The UI itself has no execution,
provider, wallet, signing, or submission control.

P/L semantics must remain auditable:

- realized P/L = closed-position/fill accounting including recorded fees;
- unrealized P/L = current stored position mark minus recorded cost basis, with mark source and
  `asOf` timestamp shown; and
- daily P/L = a documented session/calendar boundary using recorded equity and fill events, never a
  silently inferred balance change.

Any strategy adjustment inspired by a paper pilot is a new versioned hypothesis. Freeze each pilot
batch, evaluate it afterward, then return a changed version to independent shadow validation before
another controlled pilot.

Before Phase 10.8A/10.8B, proposed Phase 10.7A will define the Paper-Pilot Experiment Protocol.
It will pre-register a small fixed set of promoted versioned profiles, a common timestamped market
universe, isolated simulated portfolios, the fee/slippage/latency/fill assumptions, risk and session
limits, primary operational and P/L measures, and the profile comparison/retirement rule. A 4-6-hour
session and 5-7-day batch are future protocol choices, not a permission to shorten or alter the active
V3 measurement cohort. No strategy revision may occur within a session or batch; each revision needs
fresh independent shadow validation. Phase 10.7A is documentation-only: it makes no provider call,
database/runtime write, session, simulated order/fill/position/P/L, PAPER setting, wallet, signing,
or submission action.

Detailed implementation checklist:

- [NeXusTrade-Phase-10-Detailed-Checklist.md](./NeXusTrade-Phase-10-Detailed-Checklist.md)

Active Phase 9+ planning continues in:

- [ROADMAP_Phase9Plus.md](./ROADMAP_Phase9Plus.md)
- [DECISIONS_Phase9Plus.md](./DECISIONS_Phase9Plus.md)
- [Structure_Phase9Plus.md](./Structure_Phase9Plus.md)
- [NeXusTrade-Phase-9-Detailed-Checklist.md](./NeXusTrade-Phase-9-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.1-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.2-Detailed-Checklist.md](./NeXusTrade-Phase-9.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.2B-Detailed-Checklist.md](./NeXusTrade-Phase-9.2B-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.25-Detailed-Checklist.md](./NeXusTrade-Phase-9.25-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.3-Detailed-Checklist.md](./NeXusTrade-Phase-9.3-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.3B-Detailed-Checklist.md](./NeXusTrade-Phase-9.3B-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.3C-Detailed-Checklist.md](./NeXusTrade-Phase-9.3C-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4-Detailed-Checklist.md](./NeXusTrade-Phase-9.4-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4B-Detailed-Checklist.md](./NeXusTrade-Phase-9.4B-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4C-Detailed-Checklist.md](./NeXusTrade-Phase-9.4C-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.4D-Detailed-Checklist.md](./NeXusTrade-Phase-9.4D-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.26-Detailed-Checklist.md](./NeXusTrade-Phase-9.26-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.27-Detailed-Checklist.md](./NeXusTrade-Phase-9.27-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.28-Detailed-Checklist.md](./NeXusTrade-Phase-9.28-Detailed-Checklist.md)
- [NeXusTrade-Phase-9.29-Detailed-Checklist.md](./NeXusTrade-Phase-9.29-Detailed-Checklist.md)
- [Provider-Strategy-Phase9Plus.md](./Provider-Strategy-Phase9Plus.md)

## Current Command Surface

Phase 9 should orchestrate the existing command/service surfaces instead of adding new trading
logic. The default TerminalRunner loop should use the research and reporting surfaces only.

```bash
pnpm scanner:discover --once
pnpm risk:evaluate --once
pnpm strategy:evaluate --once
pnpm strategy:evaluate --once --buy-score-threshold=75
pnpm shadow:observe --once
pnpm shadow:observe --once --include-shadow-scores --shadow-score-min=50
pnpm shadow:exits --once
pnpm shadow:exits --once --target-pcts=10,15,25 --stop-pcts=10,15,25
pnpm shadow:calibrate --once
pnpm shadow:entries --once
pnpm watchlist:returns --once
pnpm analytics:report --once
pnpm calibration:report --once
pnpm terminal:run --once
pnpm terminal:run --cycles=6 --interval-ms=60000
pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000 --output-dir=data/phase9-runs
pnpm research:aggregate --once --label-run=T1:data/archive/phase9/test1
pnpm research:interpret --once --label-run=T1:data/archive/phase9.2B/test1
pnpm research:truth --once --label-run=T1:data/archive/phase9.4/test1
pnpm research:counterfactual --once --label-run=T1:data/archive/phase9.4D/full1
pnpm shadow:threshold-validate --once --label-run=T1:data/archive/phase9.27/test1
```

Manual paper execution surfaces still exist, but they are excluded from the Phase 9 default loop:

```bash
pnpm paper:execute --once
pnpm paper:sell --once --sell-all
pnpm session:manage --once
pnpm exits:manage --once --dry-run
```

Recommended TerminalRunner cycle order:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow exits
-> shadow calibration
-> shadow entries
-> watchlist returns
-> analytics report
-> calibration report
```

`paper:execute`, `session:manage`, and `exits:manage` stay manual or later-phase surfaces until a
future promotion review explicitly enables paper BUY orchestration.

## Runtime Defaults To Preserve

Scanner:

- `intervalMs = 60000`
- `limit = 25`
- `concurrency = 3`
- auto-create/reuse paper scanner session

Risk:

- statuses `DISCOVERED,WATCHING`
- `sinceHours = 24`
- `limit = 50`
- `concurrency = 3`
- quote probe `0.01 SOL`

Strategy:

- candidate status `WATCHING`
- risk policy `PASS_OR_ELIGIBLE_WARN`
- `sinceHours = 24`
- `limit = 50`
- `maxBuyDecisions = 5`
- `minLiquidityUsd = 10000`
- `minVolume1hUsd = 10000`
- `maxPriceImpactPct = 5`
- `minPairAgeMinutes = 30`
- `buyScoreThreshold = 90`
- `watchScoreThreshold = 70`
- explicit calibration runs may use `--buy-score-threshold=75`

Watchlist returns:

- `sinceHours = 24`
- `limit = 250`
- `horizons = 3,5,15,30,60,120,240,360,480,720`
- `sourceDecisions = WATCH,SKIP,BUY`
- `minScore = 50`
- `maxLateMinutes = 120`

Shadow observe and shadow exits:

- `sourceDecisions = BUY`
- `includeShadowScores = false`
- `shadowScoreMin = 55`
- `intervalMinutes = 1`
- `horizonsMinutes = 1,2,3,4,5,6,7,8,9,10,12,15,20,25,30,45,60`
- `targetPcts = 10,15,25`
- `stopPcts = 10,15,25`
- `maxHoldMinutes = 60`
- `maxHoldScenarioMinutes = 15,30,60,120`
- `startingBalanceSol = 1`
- `positionSizeSol = 0.01`
- `sessionGoalPct = 25`
- `maxPositions = 5`
- observations reuse `watchlist_return_observations`

Analytics:

- `sinceHours = 24`
- `limit = 250`
- `scoreBucketSize = 5`
- `nearMissMinScore = 50`
- `providerSinceHours = 24`
- `missedOpportunityLimit = 20`

Calibration:

- `sinceHours = 168`
- `limit = 500`
- `scoreBucketSize = 5`
- `targetPcts = 10,25,39`
- `drawdownPcts = 10,25,50`
- `horizonsMinutes = 3,5,15,30,60,120,240,360,480,720`
- `maxHoldMinutes = 60`
- `sourceDecisions = BUY,WATCH,SKIP`
- default threshold scenarios: `90/70`, `75/70`, `75/60`, `65/60`, `55/50`

Provider resilience:

- `QUOTE_CACHE_ENABLED = true`
- `QUOTE_CACHE_TTL_MS = 90000`
- `QUOTE_CACHE_MAX_ENTRIES = 1000`
- `QUOTE_BACKOFF_ENABLED = true`
- `QUOTE_BACKOFF_BASE_COOLDOWN_MS = 30000`
- `QUOTE_BACKOFF_MAX_COOLDOWN_MS = 120000`
- `QUOTE_BACKOFF_MULTIPLIER = 2`
- `QUOTE_BACKOFF_JITTER_PCT = 10`
- `QUOTE_SKIP_LOW_PRIORITY_DURING_COOLDOWN = true`
- `JUPITER_TOKEN_METADATA_ENABLED = false`
- Jupiter quotes remain enabled when a key is configured.
- Helius token metadata is preferred before optional Jupiter token metadata fallback.
- Provider pressure reports distinguish live rows, router rows, live rate limits, combined rate
  limits, cache hits, and cooldown skips.

Raydium quote fallback:

- Phase 9.3 command surface remains the existing TerminalRunner and provider smoke surfaces.
- Raydium is added behind the existing `QuoteProvider` interface.
- Raydium is quote-only in Phase 9.3.
- Endpoint: `GET https://transaction-v1.raydium.io/compute/swap-base-in`.
- Required request fields: `inputMint`, `outputMint`, `amount`, `slippageBps`, `txVersion`.
- Default `txVersion = V0`.
- Default `RAYDIUM_RATE_LIMIT_PER_MINUTE = 60`.
- No Raydium API key is required for the first implementation.
- Do not call Raydium transaction serialization endpoints in Phase 9.3.
- Do not enable paper BUY automation, wallet loading, signing, or submission.
- Quote provenance must separate provider identity from source type:
  `quoteProvider=JUPITER|RAYDIUM|NONE`, `quoteSourceType=LIVE|CACHE|NONE`.
- Raydium fallback reason should be recorded as one of `JUPITER_RATE_LIMITED`,
  `JUPITER_COOLDOWN`, `JUPITER_UNAVAILABLE`, `ROUTER_POLICY`, or `FORCED_PROVIDER`.
- Phase 9.3 success requires improved missing-quote coverage, measurable Raydium quote success,
  no provider/safety regression, and `orders/fills/positions = 0`.
- Phase 9.3 exits only after three validation runs plus `research:aggregate` and
  `research:interpret`; Phase 9.4 should not start automatically without reviewing that evidence.

Raydium and Helius cleanup:

- Phase 9.3B is complete.
- Raydium Route API v2 compute quote remains quote evidence.
- Raydium API v3 mint price is diagnostics only, not quote evidence.
- Raydium API v3 pools by token mint is pool/route preflight only, not quote evidence.
- Raydium transaction build endpoints remain forbidden.
- Raydium failures should be classified by category.
- Helius metadata/risk calls should use cache and backoff to reduce repeated live rate limiting.
- Unknown Helius authority evidence remains WARN, never PASS.

Phase 9.3B validation conclusion:

```text
Safety passed.
Helius free-plan credits were exhausted on July 16, 2026.
Helius-enabled runs showed 100% rate-limited behavior.
No-Helius validation reduced noise but left authority evidence broadly unavailable.
Raydium diagnostics classified failures, but full-run Raydium quote outcomes remained 0% OK.
Jupiter remained usable but pressured around 50% combined rate-limited behavior.
No strategy profile or paper BUY path was promoted.
```

Next recommended provider phase:

```text
Phase 9.3C: Helius fallback / RPC authority evidence.
Primary: raw Solana RPC mint-account parsing.
Secondary: QuickNode DAS.
Tertiary: Alchemy DAS.
Deferred provider research: Shyft or another token-info provider only if RPC + DAS are insufficient.
```

Phase 9.3C planning notes:

```text
Add SOLANA_RPC as the primary authority-evidence provider.
Use getAccountInfo on the mint address.
Parse mint authority, freeze authority, decimals, supply, token program, and initialization state.
Use QuickNode DAS and Alchemy DAS as token metadata fallbacks.
Do not treat DAS metadata as executable quote or liquidity evidence.
Do not implement Shyft in Phase 9.3C unless RPC + DAS are proven insufficient.
Keep Helius disabled during validation while credits are exhausted.
Keep unknown authority evidence as WARN/UNKNOWN, never PASS.
```

Shadow calibration:

- `targetPcts = 10,15,25`
- `stopPcts = 10,15,25`
- `maxHoldMinutes = 15,30,60`
- `confirmationHorizonsMinutes = 1,2,3`
- `confirmationMinReturnPct = 0,2,5`
- `confirmationMaxDrawdownPct = 5,10`
- `scoreBucketSize = 5`
- `minScore = 50`
- `sourceDecisions = BUY,WATCH,SKIP`
- `dedupeMode = decision`
- `portfolioStartingSol = 1`
- `portfolioPositionSizeSol = 0.01`
- `portfolioGoalPct = 25`
- `portfolioMaxPositions = 5`

Research interpretation:

- Phase 9.25 command = `pnpm research:interpret --once`
- default `dedupeMode = decision`
- supported dedupe modes = `decision`, `mint`, `first_per_mint`, `best_per_mint`
- `SKIP` with `blockers = none` should classify as `score_threshold_only` or
  `unresolved_strategy_gate`, not generic `UNKNOWN`
- output must include a Phase 9.25 recommendation matrix with exactly one primary recommendation
- recommendation options = Phase 9.26 counterfactual analysis, Phase 9.3 Raydium fallback, profile
  tuning, more data, or separate controlled paper pilot review

Shadow entries:

- current profiles = `P001,P002,P003,P004,P005,P006,P007,P008,P009,P010,P011`
- profile versions = `profileVersion`, `profileKey`, display as `P009@v1 score65_79_confirmed`
- profile presets = `baseline_raw_buy`, `score65_confirmed`, `duplicate_attention`,
  `score55_research`, `quote_control`, `recovery_after_drawdown`
- Phase 8.92B presets = `watch_first_confirmed`, `duplicate_attention_confirmed`,
  `score65_79_confirmed`, `high_score75_research`, `watch_duplicate_hybrid`
- repeated attention strength = `NONE`, `LOW`, `MEDIUM`, `HIGH`
- `targetPcts = 10,15,25`
- `stopPcts = 10,15,25`
- `maxHoldMinutes = 15,30,60`
- `confirmationHorizonsMinutes = 1,2,3`
- `confirmationMinReturnPct = 0,2,5`
- `earlyDrawdownModes = off,warn_only,reject_5,reject_10,reject_15,require_recovery`
- `entryTimings = decision,first_entry,latest_entry`
- `sourceDecisions = BUY,WATCH,SKIP`
- `positionSizeSol = 0.01`
- `startingBalanceSol = 1`
- readiness labels = `NOT_READY`, `PROMISING_RESEARCH`, `CANDIDATE_FOR_PROMOTION`
- readiness confidence = `LOW`, `MEDIUM`, `HIGH`
- signal stability = `LOW`, `MEDIUM`, `HIGH`
- report is read-only and writes no trading state

Paper BUY manual surface:

- buy size `0.01 SOL`
- `limit = 10`
- `baseFeeLamports = 5000`
- `priorityFeeLamports = 0`
- `slippageBps = 100`
- excluded from the Phase 9 default TerminalRunner loop

SessionManager manual surface:

- `--once` required
- no target/drawdown runtime override by default
- cached radar, entry price, and cost-basis valuation fallbacks enabled for snapshots
- excluded from the Phase 9 default TerminalRunner loop

ExitManager manual surface:

- observe-only default
- `targetAction = observe`
- `drawdownAction = observe`
- `completeSessionOnExit = false`
- `limit = 250`
- dry-run writes nothing
- excluded from the Phase 9 default TerminalRunner loop

## Safety Boundary

TerminalRunner must preserve:

- `PAPER` default mode
- no wallet loading
- no transaction signing
- no transaction submission
- no live DB access
- no strategy/risk threshold loosening except explicit paper calibration flags
- no treating shadow simulated P/L as realized P/L
- no paper BUY enablement after the Phase 8.93 no-promotion decision
- no new stop-loss, trailing-stop, max-hold, liquidity-collapse, or partial-exit logic

## Provider Bottleneck Strategy

Phase 9 should measure provider pressure before adding provider complexity.

Current provider issue:

```text
Jupiter rate limiting remains a real bottleneck.
Missing quotes reduce quote confidence and price-impact evidence.
Timing and drawdown instability remain separate strategy problems.
```

Phase 9 should summarize provider pressure during TerminalRunner cycles:

- provider health rows by provider and status,
- rate-limited counts,
- degraded/error counts,
- quote attempts and quote successes when available,
- missing quote evidence when available,
- candidates that moved favorably despite missing quote evidence.

Phase 9 should not add new external provider adapters by default.

Phase 9.1+ provider roadmap:

```text
9.1 cross-run research aggregation and promotion-gate reporting
9.2 quote cache, rate-limit backoff, and provider fallback framework
9.2B provider truthing and Jupiter metadata pressure cleanup
9.25 research interpretation and skipped-opportunity diagnostics
9.3 Raydium direct QuoteProvider fallback
9.3B Raydium diagnostics and Helius pressure cleanup
9.3C Helius fallback / RPC authority evidence
9.4 Birdeye selective market-data enrichment
9.4A validation truthing, quote attribution, Birdeye attribution, and adapter correctness
9.4B quote scheduling, demand reduction, evidence freshness, and venue-aware routing
9.5 Autobahn/Titan access-gated aggregate quote fallback
9.6 Meteora/Orca pool-specific quote adapters
```

Phase 9.4A.1 should be implemented first as read-only archive/reporting truthing:

```text
command = pnpm research:truth --once
inputs = existing Phase 9.4 archives
no TerminalRunner
no live provider calls
no DB mutation
no strategy default changes
no paper BUY automation
primary target = unclassifiedMissingQuote ~= 0
```

Detailed checklist:

- [NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md](./NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md)

Birdeye Standard is available, but should be used selectively:

```text
30000 CUs/month
1 RPS
no overage
no WebSocket
```

Titan and Autobahn should not block Phase 9 implementation. They remain future fallback candidates
until access credentials and quote endpoint details are available.

## Phase 8.91 / 8.92 / 8.92B / 8.93 Boundary

Phase 8.91 owns diagnostics:

```text
cross-run comparison
unique-mint analysis
scenario portfolio grids
entry confirmation simulation
candidate filter analysis
recommendations
```

Phase 8.92 owns calibrated shadow entry gates:

```text
shadow:entries command
entry profile comparison
score-band and duplicate-attention profiles
early-drawdown rejection simulation
entry confirmation simulation
first-entry versus latest-entry timing comparison
target/stop/max-hold outcomes by profile
promotion-bar recommendations
```

Phase 8.92B owns report refinement:

```text
fresh-run baseline wording
normalized profile summaries
experimental diagnostics labeling
first-class repeated attention strength
profile versioning
WATCH-first profile research
duplicate-attention profile research
score 65-79 profile research
high-score small-sample tracking
readiness criteria detail
confidence labels
signal stability labels
market-window concentration
```

Phase 8.93 owns strategy promotion:

```text
promotion decision
strategy default change proposal
rollback plan
paper-only validation criteria
explicit no-promotion decision when evidence is weak
```

TerminalRunner should not invent these gates itself. It should orchestrate the implemented
`shadow:entries` service surface, and should only orchestrate paper BUY behavior after a later
explicit promotion review approves a profile.

## Phase 8.91 Shadow Calibration Handoff

Implemented command:

```bash
pnpm shadow:calibrate --once
```

Archived Phase 8.9 comparison:

```bash
pnpm shadow:calibrate --once \
  --label-db=Test1:data/archive/phase8.9/test1-20260702-2014 \
  --label-db=Test2:data/archive/phase8.9/test2-20260703-1112 \
  --label-db=Test3:data/archive/phase8.9/test3-20260703-1633
```

Use JSON for future dashboards or machine-readable TerminalRunner readiness gates:

```bash
pnpm shadow:calibrate --once --json
```

Phase 8.91 report sections:

- run inventory and mechanical validity
- decision-level outcomes
- unique-mint outcomes
- scenario portfolio grid
- entry confirmation simulation
- candidate filter analysis
- recommendation confidence and evidence
- next test plan

Final Phase 8.91 validation:

```text
report = data/phase8.91-cross-run-final.txt
runs = 3
observed decisions = 66
unique mints = 18
orders = 0
fills = 0
positions = 0
```

Final diagnostic signal:

```text
BUY candidates hit +10% 40.00% of the time, but average worst observed return was -46.77% and
70.00% reached -10% drawdown before +10% target.
WATCH candidates had a higher +10% hit rate and much milder average worst return than BUY.
Duplicate/repeated-attention candidates deserve research, but not automatic promotion.
Jupiter rate limiting remains high enough that missing quote should stay visible but should not
automatically be interpreted as poor candidate quality.
```

## Phase 8.92 Shadow Entry-Gate Handoff

Implemented checklist:

```text
docs/NeXusTrade-Phase-8.92-Detailed-Checklist.md
```

Implemented command:

```bash
pnpm shadow:entries --once
```

Implemented outputs:

- profile comparison for baseline raw BUY, score-confirmed, duplicate-attention, score-55 research,
  and quote-control candidates
- explicit entry outcomes such as `WOULD_ENTER`, `REJECT_EARLY_DRAWDOWN`,
  `INSUFFICIENT_CONFIRMATION_DATA`, and `MISSED_FAST_MOVE`
- target/stop/max-hold grid by entry profile
- first-entry versus latest-entry timing comparison
- simulated portfolio outcome by entry profile
- recommendation on whether Phase 9 can enable paper BUY, stay shadow-only, or needs more
  strategy work

Phase 8.92 must remain read-only and paper-only. Its report is a Phase 9 readiness gate, not a
realized P/L source.

Archived Phase 8.91 baseline smoke:

```bash
pnpm shadow:entries --once \
  --label-db=Test1:data/archive/phase8.91/test1-phase8.91-test1-20260703-2155 \
  --label-db=Test2:data/archive/phase8.91/test2-phase8.91-test2-20260704-1324 \
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

Phase 9 remains shadow-first because the archived Phase 8.92 smoke did not produce a
`CANDIDATE_FOR_PROMOTION` profile. A fresh Phase 8.92 validation batch can revisit that.

Fresh Phase 8.92 validation:

```text
data/archive/phase8.92/test1-phase8.92-test1-20260707-1017
data/archive/phase8.92/test2-phase8.92-test2-20260707-1418
data/archive/phase8.92/test3-phase8.92-test3-20260707-1816
data/archive/phase8.92/test4-phase8.92-test4-20260707-2148
```

Fresh Phase 8.92 summary:

```text
runs = 4
observed decisions = 68
unique mints = 25
orders = 0
fills = 0
positions = 0

BUY +10% hit = 60.00%, avgWorst = -46.98%, drawdown-first -10% = 50.00%
WATCH +10% hit = 72.22%, avgWorst = -16.71%, drawdown-first -10% = 44.44%
duplicate_blocked +10% hit = 90.00%, avgWorst = -7.96%
score 65-69 +10% hit = 78.57%, avgWorst = -32.38%
```

Fresh Phase 8.92 conclusion:

```text
There is signal, but no profile should be promoted yet.
Phase 8.92B refined the workbench before Phase 9 consumes it.
```

## Phase 8.92B Implemented Refinement

Checklist:

```text
docs/NeXusTrade-Phase-8.92B-Detailed-Checklist.md
```

Implemented changes:

- make P001 Phase 8.91 reproduction not applicable for fresh Phase 8.92 datasets,
- keep P001 as the within-batch comparison baseline,
- add normalized profile summaries that are not scenario-inflated,
- keep experimental diagnostics as a clearly labeled secondary section,
- add first-class repeated attention strength,
- add profile versioning,
- add `PROMISING_RESEARCH`,
- add readiness confidence,
- add signal stability,
- add market-window concentration checks,
- add profiles P007-P011,
- preserve no-paper-execution wording.

Phase 9 should treat Phase 8.92B output as a shadow readiness gate, not as paper BUY permission.

Fresh Phase 8.92B validation:

```text
data/archive/phase8.92B/test1-phase8.92B-test1-20260708-1141
data/archive/phase8.92B/test2-phase8.92B-test2-20260708-1949
data/archive/phase8.92B/test3-phase8.92B-test3-20260709-0908
```

Fresh Phase 8.92B summary:

```text
runs = 3
observed decisions = 50
approximate unique mint coverage = 20
orders = 0
fills = 0
positions = 0
CANDIDATE_FOR_PROMOTION = 0
PROMISING_RESEARCH = 5, all low confidence and low stability
```

Best normalized profile signals from the fresh Phase 8.92B batch:

```text
P001@v1 / decision: considered 9, target-first 44.44%, stop-first 33.33%, avgBest 16.76%, avgWorst -39.48%
P005@v1 / decision: considered 50, target-first 36.00%, stop-first 46.00%, avgBest 15.49%, avgWorst -28.11%
P004@v1 / decision: considered 30, target-first 23.81%, stop-first 57.14%, avgBest 17.59%, avgWorst -28.43%
```

Phase 8.92B conclusion:

```text
The workbench is useful, but no profile is strong enough for strategy promotion.
Phase 8.93 completed as a no-promotion review.
```

## Phase 8.93 Strategy Promotion Review Outcome

Checklist:

```text
docs/NeXusTrade-Phase-8.93-Detailed-Checklist.md
```

Phase 8.93 reviewed the fresh Phase 8.92B outputs against the promotion bar:

```text
status = CANDIDATE_FOR_PROMOTION
confidence = MEDIUM or HIGH
signal stability = MEDIUM or HIGH
profile version = explicit and immutable
```

Outcome:

```text
no profile promoted
no strategy default changes
no paper BUY orchestration permission
Phase 9 remains shadow-first
```

Reason:

```text
No profile reached CANDIDATE_FOR_PROMOTION. Low-confidence PROMISING_RESEARCH results are useful
for future profile-version experiments, but not strong enough to change paper strategy behavior.
```

Phase 9 should automate the shadow research loop and generate larger datasets with less manual work.
Any future profile tuning should create explicit new profile versions and return to an explicit
promotion review before enabling paper BUY orchestration.

## Phase 9 TerminalRunner Outcome

Implemented command:

```bash
pnpm terminal:run --max-runtime-minutes=120 --interval-ms=60000 --output-dir=data/phase9-test1/runner-output
```

TerminalRunner creates one `PAPER` + `RUNNING` session per run and reuses that session through:

```text
scanner
-> risk
-> strategy
-> shadow observe
-> shadow exits
-> shadow calibration
-> shadow entries
-> watchlist returns
-> analytics report
-> calibration report
```

Valid Phase 9 archives:

```text
data/archive/phase9/test1-phase9-test1-20260709-2344
data/archive/phase9/test2-phase9-test2-20260710-0919
data/archive/phase9/test3-phase9-test3-20260710-1729
```

The earlier pre-patch smoke archive remains useful only as a safety note because it did not have a
single run-scoped TerminalRunner session.

## Phase 9.1 Cross-Run Research Aggregation Outcome

Implemented command:

```bash
pnpm research:aggregate --once \
  --label-run=T1:data/archive/phase9/test1-phase9-test1-20260709-2344 \
  --label-run=T2:data/archive/phase9/test2-phase9-test2-20260710-0919 \
  --label-run=T3:data/archive/phase9/test3-phase9-test3-20260710-1729
```

Initial aggregate result:

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
controlledPaperPilotRecommended = no
paperBuyAutomationEnabled = no
```

Threshold comparison from the first aggregate:

```text
BUY55 observedBUY = 277, +10% hit = 60.65%, avgWorst = -20.98%
BUY65 observedBUY = 85, +10% hit = 62.35%, avgWorst = -36.28%
BUY75 observedBUY = 1, +10% hit = 0.00%, avgWorst = -64.32%
P001 observedBUY = 0
```

Promotion blockers:

```text
target-first wins were too concentrated in one run: 42.54%
no shadow-entry profile cleared the Phase 8.92B promotion workbench
```

Phase 9.1 does not enable paper BUY automation. Phase 9.2 implemented quote cache, Jupiter
backoff, and provider fallback framework.

## Phase 9.2 Provider Resilience Planning Inputs

Checklist:

```text
docs/NeXusTrade-Phase-9.2-Detailed-Checklist.md
```

Phase 9.2 implemented:

```text
stable quote request identity
in-memory successful quote cache
Jupiter quote backoff after rate limits
quote request priority
provider fallback router
provider-health context for quote source/provenance
TerminalRunner/research compatibility
```

Current implementation surfaces:

```text
backend/src/providers/MarketDataService.ts
backend/src/providers/ProviderRegistry.ts
backend/src/providers/ProviderHealthService.ts
backend/src/providers/http/ProviderHttpClient.ts
backend/src/providers/http/providerRateLimiter.ts
backend/src/providers/jupiter/JupiterAdapter.ts
backend/src/providers/interfaces/QuoteProvider.ts
shared/src/market/quote.types.ts
```

Phase 9.2 default policy:

```text
Jupiter remains the only live quote provider.
Quote cache is in-memory only.
Successful live quotes may be cached briefly.
Missing quote remains explicit evidence.
Cooldown skips are recorded instead of hidden.
Fallback metadata exists even when no fallback provider is enabled.
No paper BUY automation is enabled.
No strategy defaults change.
```

Proposed default config:

```text
QUOTE_CACHE_ENABLED=true
QUOTE_CACHE_TTL_MS=15000
QUOTE_CACHE_MAX_ENTRIES=1000
QUOTE_BACKOFF_ENABLED=true
QUOTE_BACKOFF_BASE_COOLDOWN_MS=30000
QUOTE_BACKOFF_MAX_COOLDOWN_MS=120000
QUOTE_BACKOFF_MULTIPLIER=2
QUOTE_BACKOFF_JITTER_PCT=10
QUOTE_SKIP_LOW_PRIORITY_DURING_COOLDOWN=true
```

Quote priorities:

```text
CRITICAL - future open paper position exits
HIGH     - risk and strategy candidates near entry eligibility
NORMAL   - ordinary scanner/risk/strategy enrichment
LOW      - broad research enrichment or bulk refreshes
```

Phase 9.2 should not add:

```text
Raydium adapter
Birdeye adapter
Titan adapter
Autobahn adapter
Meteora adapter
Orca adapter
persistent quote-history table
paid provider dependency
paper BUY execution
profile promotion
```

Phase 9.2 success criteria:

```text
duplicate live quote pressure is reduced when repeated quote requests occur
rate-limit cooldown behavior is explicit and test-covered
ProviderHealth context shows live/cache/cooldown/unavailable provenance
TerminalRunner stays shadow-first
research:aggregate remains compatible with Phase 9 archives
no orders, fills, positions, wallet loading, signing, or submission occur
```

## Phase 9.2 Five-Run Validation Results

Five Phase 9.2 validation runs were completed:

```text
Test 1: data/archive/phase9.2/test1-phase9.2-test1-20260711-1245
Test 2: data/archive/phase9.2/test2-phase9.2-test2-20260711-1652
Test 3: data/archive/phase9.2/test3-phase9.2-test3-20260711-1958
Test 4: data/archive/phase9.2/test4-phase9.2-test4-20260712-1554
Test 5: data/archive/phase9.2/test5-phase9.2-test5-20260712-2001
```

Aggregate:

```text
validRuns = 5/5
observedDecisions = 321
uniqueMints = 14
orders = 0
fills = 0
positions = 0
readiness = PROMISING_RESEARCH
paperBuyAutomationEnabled = no
```

Important signal:

```text
BUY65 observedBUY = 146
avgBest = +78.00%
avgWorst = -12.37%
hit10 = 89.04%
hit25 = 66.44%
```

Main blocker:

```text
76.85% of target-first wins came from Test 4
```

Provider findings:

```text
quote cooldown skips worked
quote cache hits = 0
combined Jupiter rate-limit percentage was inflated by router cooldown rows
most live Jupiter pressure came from token-metadata-from-price, not quotes
```

Low-signal windows:

```text
Test 3: max score = 45, score >= 50 = 0, watchlist returns = 0
Test 5: max score = 45, score >= 50 = 0, watchlist returns = 0
```

Interpretation:

```text
Do not continue running unchanged Phase 9.2 tests.
Do not jump directly to Raydium.
Implement Phase 9.2B first, then Phase 9.25.
```

## Phase 9.2B Planning Inputs

Checklist:

```text
docs/NeXusTrade-Phase-9.2B-Detailed-Checklist.md
```

Phase 9.2B should implement:

```text
live provider vs router provider-pressure separation
Jupiter token metadata disabled/demoted by default
Helius metadata preferred
QUOTE_CACHE_TTL_MS default increased to 90000 for research cadence
research archive loader support for nested run-label output folders
provider reports that show cache hits, cooldown skips, and live rate limits separately
```

Phase 9.2B should not implement:

```text
Raydium fallback
Birdeye enrichment
strategy score changes
paper BUY automation
profile promotion
```

After implementation, run:

```text
1 short smoke run
3 full 2-hour + 60-minute-tail validation runs
```

## Phase 9.25 Research Interpretation Notes

Phase 9.25 should use the cleaned provider evidence from Phase 9.2B and explain candidate decisions
instead of changing strategy defaults.

Implementation checklist:

- [NeXusTrade-Phase-9.25-Detailed-Checklist.md](./NeXusTrade-Phase-9.25-Detailed-Checklist.md)

Core Phase 9.25 outputs:

```text
high-scoring SKIP explanation
SKIP reason clustering
WARN condition outcome analysis
missing quote outcome analysis
market-window analytics
per-token missed-opportunity breakdown
decision attribution for BUY/WATCH/SKIP
```

Decision attribution should answer:

```text
Which factors contributed?
How much did each factor contribute?
What was the first blocking factor?
What was the highest-impact blocking factor?
```

Example shape:

```text
Candidate: SUNNYS
Decision: SKIP
Score: 65
Risk: WARN
Primary blocker: missing quote confidence
Secondary blocker: authority evidence
Liquidity: PASS
Volume: PASS
Age: PASS
```

Future, not Phase 9.25:

```text
Counterfactual Decision Analysis
Original: SKIP
If Jupiter quote existed: WATCH
If risk PASS: BUY
```

Counterfactual analysis should wait until Phase 9.26 or Phase 10 because it needs careful handling
so hypothetical decisions are not confused with observed evidence.

## Session Lifecycle

Scanner can create a paper session with zero trading balance.

Risk, strategy, paper BUY, SessionManager, and ExitManager consume existing paper sessions.

SessionManager may set:

```text
Session.terminationReason = TARGET_REACHED
Session.terminationReason = MAX_DRAWDOWN
```

while keeping:

```text
Session.status = RUNNING
```

ExitManager may mark:

```text
Session.status = COMPLETED
```

only when completion is explicitly configured and all open positions are closed.

## Exit Lifecycle

ExitManager source of truth:

```text
Session.terminationReason
```

Supported Phase 8.5 triggers:

```text
TARGET_REACHED
MAX_DRAWDOWN
```

Default action:

```text
observe
```

Automated paper liquidation requires:

```bash
--target-action=sell-all
--drawdown-action=sell-all
```

TerminalRunner should keep ExitManager observe-only at first unless the user explicitly enables
sell-all.

## Logging Surfaces

- Scanner: `SystemLog.scope = SCANNER`
- Risk: `SystemLog.scope = RISK`
- Strategy: `SystemLog.scope = STRATEGY`
- Watchlist returns: writes `watchlist_return_observations`; provider health rows when refreshing
  observations
- Shadow observe: writes high-frequency `watchlist_return_observations`; provider health rows when
  refreshing observations
- Shadow exits: read-only report; no database writes
- Shadow entries: read-only report; no database writes
- Analytics: read-only report; no database writes
- Calibration: read-only report; opens archived datasets read-only when passed with `--db` or
  `--label-db`
- Paper BUY/SELL: `SystemLog.scope = EXECUTION`
- SessionManager: `SystemLog.scope = SESSION`
- ExitManager: `SystemLog.scope = EXECUTION` with `contextJson.phase = PHASE_8_5_EXIT_MANAGER`
- Provider health: `ProviderHealth` rows when enabled

TerminalRunner should use provider-health evidence to produce per-cycle provider-pressure summaries
when practical.

## Failure Behavior To Treat As Normal

TerminalRunner should treat these as non-fatal cycle outcomes:

- scanner finds zero candidates
- risk has no eligible candidates
- strategy produces zero BUY decisions
- shadow observe selects zero candidates
- shadow exits has no observed returns yet
- shadow entries has no eligible candidates or no observed returns yet
- watchlist returns have no due observations yet
- analytics report has no missed opportunities yet
- calibration report has no observed watchlist returns yet
- paper BUY has no approved candidates
- SessionManager has zero open positions
- ExitManager has no gated session

TerminalRunner should treat these as hard failures:

- live mode attempted
- wallet loading attempted
- transaction signing attempted
- transaction submission attempted
- unknown/unhandled command error
- database migration/readback failure
- dry-run mutation

## Phase 8.8 Calibration Handoff

Implemented command:

```bash
pnpm calibration:report --once
```

Archived experiment comparison:

```bash
pnpm calibration:report --once `
  --label-db=Con75:data/Conservative75_nexus_paper.db `
  --label-db=Agg75:data/Aggressive75_nexus_paper.db `
  --label-db=Con65:data/Conservative65_nexus_paper.db `
  --label-db=Agg65:data/Aggressive65_nexus_paper.db `
  --max-hold-minutes=60
```

Use JSON for machine-readable dashboard or later TerminalRunner evidence:

```bash
pnpm calibration:report --once --json
```

Phase 8.8 report sections:

- score distribution
- score attribution from stored strategy factors
- observed-horizon MFE/MAE approximation
- target/drawdown simulation
- missed opportunities
- false-positive BUYs
- provider impact
- threshold comparison
- recommendations

Phase 9 should use calibration output as a readiness gate:

```text
GREEN:
  Run calibrated paper orchestration.

YELLOW:
  Run TerminalRunner in shadow-only mode.

RED:
  Delay execution orchestration and revise strategy scoring.
```

## Phase 8.9 Shadow Entry/Exit Handoff

Implemented commands:

```bash
pnpm shadow:observe --once
pnpm shadow:exits --once
```

Research mode for score-qualified WATCH/SKIP candidates:

```bash
pnpm shadow:observe --once --include-shadow-scores --shadow-score-min=50
pnpm shadow:exits --once --include-shadow-scores --shadow-score-min=50
```

Recommended Phase 9 shadow-first sequence:

```bash
pnpm scanner:discover --once
pnpm risk:evaluate --once
pnpm strategy:evaluate --once
pnpm shadow:observe --once --include-shadow-scores --shadow-score-min=50
pnpm shadow:exits --once --include-shadow-scores --shadow-score-min=50 --target-pcts=10,15,25 --stop-pcts=10,15,25
```

Repeat `shadow:observe` every 1 to 3 minutes during validation windows when monitoring fast moves.
Then run `shadow:exits` to evaluate target-before-stop behavior.

Phase 8.9 report sections:

- selected strategy decisions
- skipped candidates and reasons
- observed fast-horizon returns
- target/stop/max-hold scenario summaries
- per-candidate exit outcomes
- run-level simulated portfolio result
- recommendations

Phase 9 should treat shadow results as an execution-readiness gate:

```text
GREEN:
  Shadow exits show repeatable target-before-stop behavior at the desired hold window.

YELLOW:
  Entries move, but exit timing or provider confidence needs more observation.

RED:
  Drawdowns dominate before targets or candidate coverage is too sparse.
```

TerminalRunner should be able to run shadow-only cycles before enabling paper BUY execution.

## Phase 8.6 Validation Results

Baseline:

- `pnpm verify`: passed.
- Shared tests: 4 files, 12 tests passed.
- Backend tests: 39 files, 137 tests passed.
- Secret check: passed.

Database hygiene:

- Archived development paper DB to `data\archive\paper-20260622-131803`.
- `pnpm db:reset:paper`: passed.
- `pnpm db:smoke:paper`: passed.
- `pnpm db:reset:paper`: passed again to remove smoke rows before clean validation.

Clean short validation:

```text
scanner: discovered=25 unique=25 enriched=25 stored=25 errors=0
risk: selected=25 evaluated=25 PASS=0 WARN=8 FAIL=17 UNKNOWN=0 written=25 statusUpdated=25 errors=0
strategy: selected=8 evaluated=8 BUY=0 WATCH=0 SKIP=8 HOLD=0 SELL=0 written=8 statusUpdated=0 errors=0
paper BUY: clear no-candidate failure; no approved BUY candidates
session:manage: openPositions=0 equitySnapshot=created terminationReason=NOT_TERMINATED
exits:manage --dry-run: clear no-gated-session failure
```

Interpretation:

- Clean provider-backed discovery and risk evaluation worked.
- Strategy correctly rejected all candidates under current conservative rules.
- No paper BUY was executed because there were zero BUY decisions.
- SessionManager handled the zero-position session safely.
- ExitManager correctly refused to act without a target/drawdown gate.

## Historical Longer Scanner Window

This was the Phase 8.6 longer scanner validation pattern. It is kept for historical context and is
not the Phase 9 default TerminalRunner loop.

For a more meaningful market-discovery attempt, run:

```bash
pnpm scanner:discover --interval-ms=60000 --limit=25 --concurrency=3
```

Let it run for 15 to 30 minutes, stop it with `Ctrl+C`, then run the shadow-safe evaluation
surfaces:

```bash
pnpm risk:evaluate --once
pnpm strategy:evaluate --once
```

Save or copy the terminal output for each command. The most useful lines are:

- scanner cycle summaries
- risk summary
- strategy summary
- shadow report summaries when available

Manual paper surfaces may still be invoked deliberately for isolated validation, but Phase 9
TerminalRunner must not include them by default after the Phase 8.93 no-promotion decision.

## Long Scanner Validation Results

User-run validation on 2026-06-22 ran the scanner for about 27 to 28 minutes before `Ctrl+C`.

The PowerShell transcript at `data\phase8.6-long-validation.txt` captured the stop event and some
command output, but it did not capture every native-process summary line. Database logs and readback
were used as the source of truth.

Observed scanner behavior:

- Scanner cycles logged: `29`.
- Each recent cycle discovered `25`, deduped `25`, enriched `25`, stored `25`, and recorded
  `errors=0`.
- Latest long-run session: `session_e3eef094-44dd-4073-9eaa-9261a3e59732`.

Current clean validation database totals after the long run:

- Sessions: `2`.
- TokenRadar rows: `59`.
- RiskAssessment rows: `62`.
- StrategyDecision rows: `18`.
- Orders: `0`.
- Fills: `0`.
- Open positions: `0`.
- Position snapshots: `0`.
- Equity snapshots: `3`.

Latest long-run session results:

```text
TokenRadar: REJECTED=27 WATCHING=7
Risk: FAIL=27 WARN=10 PASS=0 UNKNOWN=0
Strategy: SKIP=10 BUY=0 WATCH=0 HOLD=0 SELL=0
SessionManager: openPositions=0 equitySnapshot=created terminationReason=NOT_TERMINATED
ExitManager dry-run: NO_GATED_RUNNING_PAPER_SESSION
```

Provider health distribution during the validation window:

```text
DEXSCREENER OK=1651
HELIUS OK=480 DEGRADED=808
JUPITER OK=19 DEGRADED=341 RATE_LIMITED=531
```

Interpretation:

- The longer scanner window was valid and does not need to be rerun solely because of command-entry
  mistakes in the transcript.
- No BUY was expected after evaluation because all long-run candidates were either `FAIL` or
  conservative `WARN`, and strategy scored every eligible candidate below BUY threshold.
- Jupiter rate limiting and missing quote evidence were meaningful contributors to conservative
  risk/strategy outcomes.
- The safety boundary held: no orders, fills, positions, wallet loading, signing, or transaction
  submission.

## Phase 9 Three-Run Validation Results

The first valid Phase 9 TerminalRunner batch used the patched one-session-per-run behavior:

```text
Test 1: data/archive/phase9/test1-phase9-test1-20260709-2344
Test 2: data/archive/phase9/test2-phase9-test2-20260710-0919
Test 3: data/archive/phase9/test3-phase9-test3-20260710-1729
```

Runtime quality:

```text
Test 1: 55 cycles, safety PASS, one session, 601 scanner stored, 221 strategy rows
Test 2: 54 cycles, safety PASS, one session, 591 scanner stored, 185 strategy rows
Test 3: 56 cycles, safety PASS, one session, 629 scanner stored, 181 strategy rows
```

Provider pressure:

```text
Jupiter RATE_LIMITED:
Test 1: 52.89%
Test 2: 52.06%
Test 3: 53.09%
```

Research threshold summary:

```text
BUY>=65 / WATCH>=60:
Observed BUY65 decisions: 85
Weighted avg best return: +51.29%
Weighted avg worst return: -36.28%
Weighted +10% hit rate: 62.36%
Weighted +25% hit rate: 43.53%
```

Interpretation:

- Candidate stream contains real upside.
- Current production strategy still generated mostly or entirely `SKIP` decisions.
- Unique observed mints remained small per run, so decision-level outcomes can be dominated by
  repeated mints.
- Scenario portfolio results were not robust enough for paper BUY automation.
- Stop-loss logic can cap simulated/paper loss, but target-before-stop evidence must improve before
  paper execution becomes informative.
- Jupiter rate limiting remains a persistent source of missing quote/impact confidence.

Phase 9.1 should implement cross-run research aggregation and promotion-gate reporting before any
controlled paper pilot.

## Phase 9.3B Implementation Handoff

Phase 9.3B implemented Raydium diagnostics and Helius pressure cleanup after Phase 9.3 validation
showed improved missing-quote coverage but high Raydium error share and high Helius live rate
limits.

Implemented:

- Raydium quote failures are classified into normalized categories in provider-health context.
- Raydium API v3 pool preflight uses `/pools/info/mint` as route/pool diagnostics with an
  in-memory TTL cache.
- Raydium API v3 mint price uses `/mint/price` as optional diagnostics only, never as quote
  evidence.
- Helius metadata and risk evidence use in-memory `getAsset` caches by mint.
- Helius `getAsset` rate limits trigger operation backoff and optional low-priority cooldown skips.
- Provider-pressure reports now preserve Raydium failure/preflight counts and Helius
  evidence/cache counts.
- `providers:smoke` prints compact provider diagnostics from the smoke window.

Validation measured:

```text
Raydium UNKNOWN/error category distribution
Raydium RAYDIUM_UNAVAILABLE / preflight FAILED share
Helius liveRateLimited after cache/backoff
Helius account-level quota exhaustion behavior
no-Helius degraded-provider behavior
missingQuote compared with Phase 9.3
RISK_NOT_PASS blocker share after provider cleanup
orders/fills/positions remain 0
```

Phase 9.3B did not add a DB migration, change strategy defaults, promote a profile, add Birdeye,
enable paper BUY automation, load a wallet, sign, submit, or call Raydium transaction build
endpoints.

## Known Limitations

- Real-market validation can legitimately produce zero BUY decisions.
- Current Helius authority mapping still treats missing/absent authority as conservative WARN
  evidence unless it can distinguish disabled from unknown.
- DexScreener token profile discovery may not produce enough candidates in one cycle.
- Jupiter quotes may be unavailable for some discovered tokens.
- Jupiter rate limiting can reduce quote confidence and price-impact evidence.
- Current Jupiter limiting is minute-based; Phase 9.4A/9.4B planning should account for Jupiter
  Free-tier 1 RPS / 60 RPM pacing and response headers before adding another quote provider.
- Current `MISSING_QUOTE` evidence is too broad and should be split into buy quote, sell quote,
  round-trip quote, and price-impact availability.
- Current report limits can truncate strategy/provider rows unless reports disclose
  `rowsAvailable`, `rowsEvaluated`, `rowsDisplayed`, `displayLimit`, and `displayTruncated`.
- Phase 9.4 aggregate evidence is concentrated in one run and one mint; promotion decisions should
  use unique-mint, first-per-mint, best-per-mint, leave-one-run-out, and leave-one-mint-out views.
- Birdeye Standard is constrained by 1 RPS, 30,000 CUs/month, no overage, and no WebSocket access.
- Birdeye budget exhaustion should be reported as a policy skip/degraded condition, not as provider
  failure.
- Titan and Autobahn are access-gated until credentials and endpoint contracts are available.
- Raydium fallback exists, but current preflight and error parsing need Phase 9.4A correction before
  Raydium evidence is trustworthy enough for provider expansion decisions.
- Phase 9.4A.1 archive truthing and closeout patch are complete: it found
  `unclassifiedMissingQuote = 0` while labeling run-level pressure as correlated evidence,
  separated Birdeye budget guardrails from provider failures, and confirmed substantial
  Test2/WONKA concentration.
- Phase 9.4A.2 implementation and short validation are complete: Raydium API v3 preflight uses the
  documented full parameter set, Raydium top-level `msg` is parsed, documented `REQ_*` messages
  receive stable detail codes, HTTP attempts are sanitized, `QuoteAttemptJournal` separates latest
  attempt from last successful quote, and `quote:diagnose --once` is available.
- Phase 9.4A.2 short validation `phase9.4A.2-short-20260806-1255` completed 29 PAPER shadow-only
  cycles with `safetyStatus = PASS`, no orders/fills/positions, 26 TokenRadar rows, 553 risk rows,
  and 229 strategy rows. Provider evidence showed Jupiter remained pressured
  (`combinedRateLimited ~= 58.47%`), Raydium fallback was dominated by `NO_ROUTE` after `NO_POOL`
  preflight, Birdeye had no provider failures, and Solana RPC authority evidence remained healthy.
- Phase 9.4A.3 remains deferred because the existing diagnostic surfaces retained sufficient
  evidence for the next decision. Phase 9.4B is the next planned implementation phase.
- Phase 9.4B implementation and runtime validation are complete. It reduced quote pressure through
  local Jupiter scheduling, process-local single-flight joins, negative quote evidence caching,
  Raydium no-pool/no-route suppression, and DexScreener venue-aware Raydium probe control. Raydium
  controls succeeded; Jupiter live rate limiting remained approximately 23% across two full runs.
- Phase 9.4C is the implemented refinement awaiting runtime validation: one process-wide adaptive Jupiter budget shared by
  price and quote operations, explicit priority-aware deferral, and local-versus-upstream rate-limit
  reporting. Helius remains excluded from 9.4C validation; Solana RPC and QuickNode DAS continue to
  provide authority/metadata evidence.
- Meteora and Orca fallback adapters do not exist yet.
- Shadow exit results use endpoint observations, not tick-level data or executable fills.
- Shadow portfolio P/L is simulated and excludes true slippage, route failures, partial fills, and
  MEV effects.
- PaperSell still uses ordered writes rather than a transaction wrapper.
- ExitManager supports session-level sell-all only.
- TerminalRunner exists and remains shadow-first by default.
- TerminalRunner creates one run-scoped `PAPER` + `RUNNING` session and passes that `sessionId`
  through scanner, risk, strategy, shadow, watchlist, analytics, calibration, shadow calibration,
  and shadow entry stages.
- TerminalRunner normal output includes compact cycle/stage progress logs. `--json` output remains
  machine-readable.
- Phase 10 dashboard is implemented as a local static archive viewer; it has no runtime or
  execution controls and uses only manually generated, ignored archive-export JSON.

## Phase 9.4C Runtime Conclusion And Phase 9.4D Handoff

Phase 9.4C completed two valid 120-minute PAPER/shadow-only validations after a corrective smoke.

```text
safetyStatus = PASS in both runs
orders/fills/positions = 0
Jupiter upstream live 429 = 0%
Jupiter live requests allowed = 5,473
Jupiter local controller deferrals = 856
primary local cause = DEFERRED_WINDOW_BUDGET
Raydium fallback = venue-guard skipped where no Raydium venue was observed
```

The shared controller is healthy and should remain the final upstream safety authority. The next
problem is allocation: the risk refresh asks for more executable quotes than a safe free-tier
window can serve. Phase 9.4D should plan a bounded subset before router calls, use stored local
evidence only for selection, and record `QUOTE_BUDGET_NOT_SELECTED` separately from provider
errors, upstream rate limits, cache outcomes, and Raydium venue decisions.

Detailed checklist: [NeXusTrade-Phase-9.4D-Detailed-Checklist.md](./NeXusTrade-Phase-9.4D-Detailed-Checklist.md).

## Phase 9.4D Runtime Conclusion And Next Gate

Phase 9.4D completed a 30-minute smoke and two valid 120-minute PAPER/shadow-only validations.
The default planner selected at most 20 candidates per risk cycle from existing local evidence and
made no provider calls while ranking.

```text
valid full runs:                  2 / 2
PAPER/shadow-only safety:         PASS
orders/fills/positions:           0 / 0 / 0
risk cycles:                      129
planner selected / not selected:  2,580 / 1,322
selected quote coverage:          2,515 / 2,580 (97.48%)
Jupiter upstream live 429:        0.00%
Jupiter shared-window maximum:    40 / 48
```

Decision: retain the 20-candidate allocation, the `JUPITER -> RAYDIUM` router, the shared Jupiter
controller, and the Raydium venue guard. Do not add a paid Jupiter tier, Titan/Autobahn, or
Meteora/Orca based on this evidence. Birdeye's local CU guard did exhaust for some selective
enrichment requests, but it did not block the quote path and is not the next engineering priority.

The next evidence gate is one additional unchanged 120-minute validation archive in a distinct
market window. It is not required to complete Phase 9.4D; it supplies the third valid run required
by the existing strategy-promotion research gate. The aggregate loader was also corrected to find
tail reports beside nested TerminalRunner JSON artifacts, preventing false missing-report warnings.

## Phase 9.26 Conclusion And Phase 9.27 Implementation

Phase 9.26 passed its archive-only smoke against the three Phase 9.4D archives:

`text
baseline replay fidelity:          844 / 844 exact
provider calls:                    0
database writes:                   0
orders/fills/positions:            0 / 0 / 0
direct 65/60 promotions:           27
largest promoted-mint share:       74.07%
largest promoted-run share:        81.48%
`

The replay result is not sufficiently independent for a strategy threshold change. Phase 9.27
therefore validates only T65N@v1: stored normal-run SKIPs with scores 65-69, all recorded hard
eligibility gates passing, and recorded 90/70 original thresholds. It will select the first
eligible decision per mint per archived run, then attach later watchlist returns only as outcome
evidence.

Phase 9.27 collection rules:

- Keep TerminalRunner and strategy evaluation at the normal BUY=90 / WATCH=70 configuration.
- Never run a lower-threshold strategy command during collection.
- Start each fresh run from a reset PAPER database and archive it before threshold analysis.
- Require at least three independent 120-minute run windows, a 60-minute observation tail, and
  combined concentration-aware reporting.
- Treat too few candidates, too few mints, or a dominant mint/run as a data-quality outcome,
  not a reason to loosen gates.

Detailed checklist:
[NeXusTrade-Phase-9.27-Detailed-Checklist.md](./NeXusTrade-Phase-9.27-Detailed-Checklist.md).

Phase 9.27 implementation, archive smoke, and six fresh validations are complete. The fresh
combined report found 19 selected candidates with 19 unique mints and 60-minute observations. The
primary 10/10 at 60-minute result was 9 target-first, 8 stop-first, and 2 neither, with median
MFE `+18.26%` and median MAE `-10.92%`. Count and concentration gates passed, but both
leave-one-out gates failed; every selected row scored 65. The outcome remains
`COLLECT_MORE_INDEPENDENT_DATA`; retain the normal 90/70 collection configuration and do not
interpret the observed cohort as a promotion signal.

## Phase 9 Planning Questions

- Should TerminalRunner run a fixed number of cycles or continuously until interrupted?
- Should TerminalRunner use service classes directly instead of shelling out to package scripts?
- Should TerminalRunner default to observe-only exits?
- Should TerminalRunner have per-stage `--dry-run` controls or one global dry-run mode?
- How should TerminalRunner summarize zero-candidate cycles?
- Should TerminalRunner include a maximum runtime option for validation windows?
- Should provider pressure be computed from `ProviderHealth` row deltas, stage results, or both?
