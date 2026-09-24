# NeXusTrade Structure Phase 9+

Active file inventory for Phase 9 and later.

Last updated: 2026-09-18

## Historical References

Use [Structure.md](./Structure.md) for the full historical file inventory through Phase 8.93.

Use these related historical docs for project context:

- [ROADMAP.md](./ROADMAP.md)
- [DECISIONS.md](./DECISIONS.md)
- [Phase-9-Planning-Inputs.md](./Phase-9-Planning-Inputs.md)
- [Provider-Strategy-Phase9Plus.md](./Provider-Strategy-Phase9Plus.md)

## H4 implementation files

- `scripts/architecture-check.mjs`, `architecture-policy.json`: scoped TypeScript dependency enforcement; checker mutation fixtures live alongside them.
- `scripts/verify-isolated.mjs`, `check-isolation.mjs`, `isolated-paths.mjs`: guarded command composition, dependency/native checks and contained output directories.
- `.github/workflows/isolated-verification.yml`: pinned Windows/Linux synthetic verification; hosted results still required.
- `backend/src/analytics/AnalyticsReadRepositories.ts`, `AnalyticsReportTypes.ts`, `AnalyticsJsonReaders.ts`, `AnalyticsQuoteBudget.ts`: read facade, compatible exported report types, legacy v0 readers and pure aggregation.
- `backend/vitest.h4.config.ts`, `backend/src/analytics/h4/`, analytics snapshots: explicit H4 harness, runtime/type negative fixtures and original-output characterization.
- [H4 verification](./Phase-10.6H-H4-Verification.md), [boundary audit](./Phase-10.6H-H4-Boundary-Audit.md), [inventory](./Phase-10.6H-H4-Inventory.json) and [main handoff](./Phase-10.6H-Main-Developer-Handoff.md): evidence, scoped debt, exact test admission and main resumption.

## Documentation Files

#### docs/NeXusTrade-Phase-10.6H-H4-Detailed-Checklist.md

- Purpose: Reviewable H4 scope for executable dependency boundaries, read-only analytics interfaces, versioned legacy JSON projections, targeted decomposition and guarded CI.
- Usage: Follow approved D1-D9 and checked H4 batches; see closed T13/T16 acceptance and its screenshot/Git evidence.
- Status: Approved from `3b7b229`, locally implemented and verified 2026-09-18; hosted Windows/Linux acceptance is recorded and H4 is merged at `88921e9`.
- Exclusions: No operational archive/database/provider actions, frozen collector changes, B.4 research or automatic deployment.

#### docs/Phase-10.6H-Main-Isolation-Integration.md

- Purpose: PR #3 main-into-isolation conflict decisions, synthetic combined-source verification, exact parent revisions, historical B.3 provenance and integration handoff.
- Scope: Prepared local integration only; no real archive rerun, operational deployment, H4 implementation or B.4 research.

#### docs/NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md

- Purpose: Reviewable H3 plan for concurrent provider admission, cancellation/deadlines, budget ownership and legacy measurement semantics.
- Usage: Follow the approved D1-D9 contract and completed H3-00 through H3-06 evidence; preserve separate operational integration gates.
- Status: Approved at `f46eb26`; isolated engineering acceptance complete on 2026-09-17. H3 is committed as `f8f8d4c`, integrated into main at `63f5378`. Future timing-envelope rollout is excluded.

#### docs/Phase-10.6H-H3-Verification.md

- Purpose: Approval, isolation, failure probes, exact test matrix, compatibility results, source fingerprint and closeout checklist.
- Status: 98 H3, 245 unchanged H1 and 194 unchanged H2 tests pass; source checks pass in isolation.
- Related files: `backend/vitest.h3.config.ts`, `backend/src/providers/h3/` deterministic fixtures/import and network/environment guards. Health tests reuse the owned H2 SQLite fixture boundary.

#### docs/Phase-10.6H-H3-Provider-Time-And-Budget-Contract.md

- Purpose: Instance-local FIFO admission, cancellation/deadline/retry controls, constructor/budget ownership, legacy timing/consumer inventory and deferred versioned envelope.
- Related source: `backend/src/providers/http/providerRateLimiter.ts`, `ProviderHttpClient.ts`, `providerRetry.ts`, `providerAbort.ts`.
- Limitations: No distributed quota, end-to-end router cancellation, billing-policy change, timing-schema rollout or frozen-cohort change.

#### docs/NeXusTrade-Phase-10.6H-H2-Detailed-Checklist.md

- Purpose: Reviewable implementation contract for atomic accounting, durable request identity,
  schema constraints, migration readiness, and read-only reconciliation of existing PAPER code.
- Usage: Follow H2-00 through H2-07 after user approval; map INV-01 through INV-09 and T01 through
  T15 to named implementation evidence. Preserve V3 isolation and separate operational gates.
- Status: Approved 2026-09-10; isolated engineering acceptance completed September 16, with evidence recorded in
  [H2 verification](./Phase-10.6H-H2-Verification.md). Migration is fixture-tested only.

#### docs/Phase-10.6H-H1-Verification.md

- Purpose: Record isolated worktree/dependency checks, H1 fixes, named evidence for every 10.6B.3
  Section 8 requirement, source identity, and verification limitations.
- Status: H1 engineering acceptance complete on 2026-09-10; 245 tests and required source checks pass.
  Closeout was subsequently committed and pushed as `a0bfdf9`; operational integration and real-run gates remain separate.
- Related source: `backend/vitest.measurement-analysis.config.ts` disables environment-file loading
  and selects only the bounded analyzer suite. `.gitattributes` preserves the frozen V3 protocol's
  committed bytes; analyzer path checks reject symlink/junction redirection along the entire path.

#### docs/ROADMAP_Phase9Plus.md

- Purpose: Active roadmap for Phase 9 through Phase 13+.
- Usage: Read before planning or implementing Phase 9+ work.
- Important parameters: Links back to historical roadmap and handoff docs; keeps Phase 9
  shadow-first; lists future Phase 9.x, dashboard, live-readiness, and provider-expansion phases.
- Status: Started.
- Tests: Manual documentation review.

#### docs/DECISIONS_Phase9Plus.md

- Purpose: Active decision log for Phase 9 and later.
- Usage: Add new decisions here instead of appending to the large historical `DECISIONS.md`.
- Important parameters: Records the Phase 9+ doc split, shadow-first TerminalRunner boundary, and
  pending Phase 9 implementation decisions.
- Status: Started.
- Tests: Manual documentation review.

#### docs/Structure_Phase9Plus.md

- Purpose: Active file inventory for Phase 9 and later.
- Usage: Add new Phase 9+ files here. Do not duplicate historical entries from `Structure.md`
  unless a file is materially changed in Phase 9+.
- Important parameters: Links back to historical structure; keeps this file focused on new or
  changed Phase 9+ artifacts.
- Status: Started.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for shadow-first TerminalRunner.
- Usage: Read before implementing Phase 9.
- Important parameters: No-paper-execution boundary, default cycle order, proposed runtime
  surfaces, test plan, run artifact expectations, and acceptance criteria.
- Status: Implemented.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.1-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for cross-run research aggregation and promotion-gate
  reporting.
- Usage: Read before implementing Phase 9.1.
- Important parameters: Loads Phase 9 TerminalRunner archives, compares decision-level and
  unique-mint outcomes, score buckets, quote impact, target-before-stop behavior, scenario
  portfolios, provider pressure, and controlled paper pilot readiness without enabling paper BUY.
- Status: Implemented.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.2-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for quote cache, Jupiter backoff, quote priority, and
  provider fallback framework.
- Usage: Read before implementing Phase 9.2 provider-resilience work.
- Important parameters: Jupiter remains the only live quote provider in Phase 9.2; new provider
  adapters are deferred; quote provenance must distinguish live, cached, cooldown-skipped,
  unavailable, and future fallback quotes; paper BUY automation remains disabled.
- Status: Implemented.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.2B-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for provider truthing and Jupiter metadata pressure
  cleanup after Phase 9.2 validation.
- Usage: Read before implementing Phase 9.2B.
- Important parameters: Separates live provider pressure from router cooldown/cache rows, reduces
  Jupiter token metadata pressure, adjusts research quote cache TTL, and keeps paper BUY automation
  disabled.
- Status: Implemented.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.25-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for read-only research interpretation, skipped
  opportunity diagnostics, decision attribution, blocker clustering, market-window analysis, and
  provider interpretation.
- Usage: Read for Phase 9.25 implementation and validation context.
- Important parameters: Adds `research:interpret`; consumes Phase 9.2B archives;
  keeps paper BUY automation disabled; defers counterfactual analysis to Phase 9.26 or later.
- Status: Implemented.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.26-Detailed-Checklist.md

- Purpose: Implementation and validation record for archive-only counterfactual decision analysis.
- Usage: Read before reviewing a single-factor strategy sensitivity or proposing later research.
- Important parameters: Adds `research:counterfactual`; requires labeled archived runs; never calls
  providers or writes databases; distinguishes direct policy changes from diagnostic gate overrides;
  marks missing quote/authority facts `NOT_EVALUABLE` rather than inventing a pass.
- Status: Implemented; archive-smoke validated.
- Tests: Focused replay/config tests, backend typecheck, and archive-only smoke against Phase 9.4D.

#### docs/NeXusTrade-Phase-9.27-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for narrow, fresh, archive-only shadow validation of the
  score 65-69 threshold-only cohort surfaced by Phase 9.26.
- Usage: Read before running or reviewing a lower-threshold research experiment.
- Important parameters: Defines T65N@v1, preserves normal 90/70 collection, uses only persisted
  time-of-decision facts and later observed returns, selects first-per-mint-per-run, and requires
  concentration-aware sample gates. It cannot enable paper BUY.
- Status: Implemented; archive smoke and six fresh 120-minute runs returned
  `COLLECT_MORE_INDEPENDENT_DATA`.
- Tests: Configuration, selection, outcome, concentration, formatter, backend typecheck, and
  read-only archive-smoke coverage.

#### docs/NeXusTrade-Phase-9.28-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for a separate F65E@v1 fast-horizon shadow exit-profile
  experiment after Phase 9.27 rejected a broad lower-threshold interpretation.
- Usage: Read before implementing or validating Phase 9.28 fast observation and archive analysis.
- Important parameters: Retains normal 90/70 strategy collection; selects stored 65-69 candidates
  only; uses 3/5/15-minute observations; primary scenario is +10% target, -15% stop, 15-minute
  maximum hold; defers one- and two-minute low-latency sampling.
- Status: Implemented and closed without promotion. Three valid fresh 120-minute runs selected
  seven exact-coverage candidates (Test1=0, Test2=1, Test3=6); the fixed primary result was three
  target-first, three stop-first, and one maximum-hold. No additional unchanged F65E batch is
  authorized.
- Tests: Focused config, stored-fact selection, watchlist scheduling, TerminalRunner-stage, and
  archive-analysis coverage. Full verification passes with 98 backend test files / 322 tests.

#### docs/NeXusTrade-Phase-9.29-Detailed-Checklist.md

- Purpose: Implementation-ready contract for read-only F65E feature attribution and selection of at
  most one defensible, pre-registered fast-entry successor hypothesis.
- Usage: Read before reviewing the completed archive-only attribution result or proposing any later
  research after the closed F65E@v1 profile.
- Important parameters: Reuses F65E stored-fact membership and the fixed 10/15/15 primary label;
  admits only decision-time score, risk, market, quote/impact, provenance, and repeated-attention
  facts; prohibits future-label leakage, threshold search, and profile fabrication.
- Status: Implemented and closed with `NO_DEFENSIBLE_HYPOTHESIS`; the three-run archive smoke
  reconstructed seven exact-coverage rows but failed label independence and concentration gates.
  No successor profile or fresh collection is authorized.
- Tests: Archive-only argument safety, decision-time provenance, label separation, concentration,
  leave-one-out gates, no-hypothesis output, and the synthetic successor pre-registration contract.

#### docs/NeXusTrade-Phase-10-Detailed-Checklist.md

- Purpose: Implementation-ready contract for the local read-only Research Dashboard and Archive
  Explorer.
- Usage: Read before adding dashboard workspace code, archive export code, or moving completed data
  artifacts.
- Important parameters: Uses canonical structured reports before whitelisted read-only archive data;
  defines normalized manifest/run/cohort/candidate/provider-pressure contracts; separates later
  outcome labels from decision-time facts; excludes active databases, transcripts, and legacy root
  cleanup copies; forbids every provider, execution, wallet, strategy, and monitoring action.
- Status: Implemented 2026-08-18; Phase 10.1 evidence-fidelity closeout completed the same day. The
  bounded export has five runs, one cohort, seven candidates, and deterministic content fingerprint
  `b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`.
- Tests: Backend exporter/catalog suite, frontend loader/component suite, production build,
  loopback-only static-server smoke, repository verification, and no-side-effect coverage.

#### docs/NeXusTrade-Phase-10.4-Detailed-Checklist.md

- Purpose: Implementation-ready contract for a deterministic, archive-only research brief and
  reviewer/Codex analysis protocol.
- Usage: Read before running `research:brief` or reviewing its Markdown/JSON output.
- Important parameters: Requires explicit completed archive scope; reads known structured JSON only;
  writes to standard output only; preserves decision-time facts separately from later labels; carries
  recorded concentration/gates/conclusion; and forbids database, provider, runtime, execution,
  wallet, strategy, threshold, monitoring, hypothesis, and study-authorization behavior.
- Status: Implemented 2026-08-19. The first six-source scope has deterministic content fingerprint
  `5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7` and retains the recorded
  `NO_DEFENSIBLE_HYPOTHESIS` conclusion.
- Tests: Config/catalog, data-quality/conclusion, deterministic-output, no-side-effect, CLI, and
  end-to-end fixture coverage. `corepack pnpm verify` passed: 107 backend test files / 351 tests, 4
  shared test files / 13 tests, and 2 frontend test files / 4 tests.

#### docs/NeXusTrade-Phase-10.5-Detailed-Checklist.md

- Purpose: Implementation-ready contract for a source-traceable human-review and pre-registration
  gate over completed Phase 10.4 evidence.
- Usage: Read and approve before implementing `research:review-gate` or recording the initial
  review decision.
- Important parameters: Explicit Phase 9.28/9.29 archive scope, a human-authored source-controlled
  review record, stdout-only output, required initial `NO_STUDY_AUTHORIZED` result, and an optional
  later pre-registration contract that must use decision-time facts only. It forbids provider, HTTP,
  database, runtime, collection, execution, wallet, strategy/default, threshold, monitoring, and
  automatic-study-authorization behavior.
- Status: Implemented 2026-08-19. The source-controlled initial record has hash
  `07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f`; the first gate has fingerprint
  `2846a8509f523104417e460d0bc0a6812d161f393ade666b73faea5caa19828b` and preserves
  `NO_DEFENSIBLE_HYPOTHESIS` as `NO_STUDY_AUTHORIZED`. It rejects candidates and non-default-deny
  results; generic candidate validation is deliberately deferred.
- Tests: Config/catalog, strict-record/assertion, evidence-fingerprint, deterministic-output,
  fail-closed error, no-side-effect, CLI, and end-to-end default-deny fixture coverage. Repository
  verification passed: 110 backend test files / 360 tests, 4 shared test files / 13 tests, and 2
  frontend test files / 4 tests.

#### Proposed Phase 10.5A Research Restart Criteria And Exploratory Cohort Design

- Purpose: Future planning/local-validation research restart gate that defines an outcome-blind
  observational cohort capable of producing independent evidence without reusing the closed F65E@v1
  study.
- Usage: Create and approve a dedicated detailed checklist before any Phase 10.6A collection work.
- Important parameters: Freezes the population, exclusions, mint/window deduplication,
  decision-time fields/provenance/missingness, provider-budget limits, observation horizons,
  discovery/validation split, and data-quality stop conditions. It distinguishes exploratory
  measurement from strategy validation and contains no collection or execution action. The approved
  checklist must also lock the V1 values and use a strict local stdout-only protocol validator.
- Status: Implemented 2026-08-19 after Phase 10.5's `NO_STUDY_AUTHORIZED` result. No live-market
  collection is authorized. The static local stdout-only protocol validator returned only the
  non-authorizing `PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL` result.

#### docs/NeXusTrade-Phase-10.5A-Detailed-Checklist.md

- Purpose: Implementation-ready contract for planning an outcome-blind exploratory cohort without
  collecting any market data or defining a successor strategy.
- Usage: Read and approve before creating a Phase 10.5A protocol document or any future Phase 10.6A
  collection checklist.
- Important parameters: Requires a strict `ExploratoryCohortProtocolV1` with fixed broad population,
  deterministic outcome-blind sampling, independence/deduplication, decision-time evidence and
  missingness, provider budgets, later-label boundary, discovery/validation split, data-quality
  stops, `NOT_AUTHORIZED_FOR_COLLECTION` authority status, and a deterministic stdout-only
  `research:protocol:validate` result that cannot authorize collection.
- Status: Implemented 2026-08-19. The frozen protocol SHA-256 is
  `748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`. No provider call, database
  access, market-runtime command, data write, strategy change, collection, or execution behavior is
  authorized.
- Tests: Implemented config/scope, strict-record/content, deterministic-fingerprint,
  no-side-effect/archive-preservation, CLI, and bounded-error coverage.

#### docs/research-protocols/phase10.6a-exploratory-cohort.v1.json

- Purpose: Frozen, source-controlled `ExploratoryCohortProtocolV1` design record for a future
  observational cohort.
- Usage: Validate only with `pnpm research:protocol:validate --
--protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v1.json`; it is never generated
  or changed by the command.
- Important parameters: Locks broad outcome-blind population and sampling, 96 planned / 72 minimum
  units, decision-time fields/types/missingness, provider limits, 3/5/15/60-minute labels-only
  horizons, deterministic split, archive contract, data-quality stops, and all downstream authority
  remains denied.
- Status: Implemented 2026-08-19; SHA-256
  `748a159464ddfae3d7821e5e18bc690d87c2ac82cf2d89b596a11f4612fce152`.

#### docs/NeXusTrade-Phase-10.6A-Detailed-Checklist.md

- Purpose: Proposed implementation contract for a separately authorized, bounded real-market
  exploratory cohort collection.
- Usage: Read and approve before implementing any Phase 10.6A collector or making a provider call.
- Important parameters: Requires a new archive-only collector rather than scanner/watchlist runtime,
  frozen 2-hour sampling, direct narrow provider capabilities, no fallback/retry, decision-time and
  later-label separation, fixed archive lifecycle, provider/data-quality stops, and separate launch
  authorization for one root.
- Status: Implemented 2026-08-19. No provider/RPC/HTTP call, archive creation, database access,
  session, strategy, PAPER action, wallet action, signing, or submission occurred. A live run still
  requires separate user authorization for one named root.

#### docs/NeXusTrade-Phase-10.6A.1-Detailed-Checklist.md

- Purpose: Launch-blocking reliability contract for the implemented Phase 10.6A V2 collector.
- Usage: Read and approve before modifying the collector or arming the authorized external scheduler.
- Important parameters: Keeps the V2 protocol bytes and ordinary 168-slot schedule unchanged;
  requires canonical zero-request `PAUSE_WINDOW` ledger rows for elapsed uninvoked slots, terminal
  index-based finalization, strict state validation, and an existing-root-only provider-free
  post-window incomplete closeout.
- Status: Implemented 2026-08-19 with fake-clock/fake-gateway verification only. It creates no
  archive, starts no scheduler, and makes no provider call during implementation.

#### docs/NeXusTrade-Phase-10.6B-Detailed-Checklist.md

- Purpose: Implemented contract for one single-archive Phase 10.6A V2 analysis and non-authorizing
  hypothesis decision.
- Usage: The strict analyzer is available only through the named archive command, but an execution
  still requires separate user approval for that immutable root.
- Important parameters: One archive only; zero provider/database/runtime/filesystem writes; fixed
  60-minute label; finite seven-field/two-direction catalog; outcome-blind discovery quantiles;
  held validation; date stability; exact Fisher; and a default-deny candidate descriptor.
- Status: Implemented 2026-08-30 with synthetic-fixture, static format/lint/type, and secret-scan
  verification before one separately authorized real-archive stdout run on 2026-09-03 PDT. That report
  verified `archiveIdentity: MATCHED` and returned `NO_DEFENSIBLE_HYPOTHESIS`; it authorizes no
  candidate record, Phase 10.6C, collection, PAPER execution, or promotion.

#### backend/src/research-exploratory-analysis/

- Purpose: Isolated read-only Phase 10.6B archive verifier, fixed-gate hypothesis analyzer,
  deterministic Markdown/JSON formatter, strict CLI, and temporary-fixture tests.
- Usage: Reached only by `pnpm research:exploratory-cohort:analyze --` with the one approved
  repository-relative root, after separate explicit run authorization.
- Important parameters: Pinned V2 protocol bytes; exact four-artifact schema/hash/provenance checks;
  hard-pinned approved raw-artifact identity after internal consistency checks; zero safety counters;
  seven-field/two-direction catalog; discovery/validation split; fixed Fisher and leave-one-date-out
  gates; stdout-only output; and no collector/gateway/provider/database/runtime imports.
- Status: Implemented 2026-08-30. Focused tests use synthetic temporary archives only; the one later
  separately authorized real-archive stdout run verified the hard-pinned identity and returned
  `NO_DEFENSIBLE_HYPOTHESIS`. Neither activity made a provider, database, runtime, or archive-write
  action.

#### Implemented Phase 10.6B.1 Decision-Time Measurement And Missingness Audit

- Purpose: Next archive-only research review of the completed V2 cohort's decision-time field
  availability, bounded missingness classes, sanitized provenance/capability evidence, and
  date/partition distribution.
- Usage: The separately approved named-archive audit has completed. Its result supports only a
  separate human-reviewed measurement-protocol draft; it did not use later labels or candidate effects.
- Important parameters: No provider/RPC/HTTP, database, runtime, archive write, strategy, PAPER,
  wallet, signing, submission, order, fill, or position surface; any measurement-only revision remains
  a separate protocol-design decision, never an automatic collection or Phase 10.6C authorization.
- Status: Closed 2026-09-04 after synthetic fixtures and one separately approved stdout-only named-
  archive audit. Identity matched and audit side-effect counters stayed zero; the bounded result was
  `MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW`.

#### docs/NeXusTrade-Phase-10.6B.1-Detailed-Checklist.md

- Purpose: Record the implemented Phase 10.6B.1 archive-only measurement-audit contract and
  synthetic-only verification boundary.
- Usage: Records implementation and real-run closeout. Any measurement protocol draft remains a
  separate human-reviewed decision.
- Important parameters: One hard-pinned V2 root and four-file identity; decision-time availability,
  provenance, source-inventory, date, and partition aggregates only; opaque later-label quarantine;
  fixed 90% coverage, 80% dominant-signature, and 8-date support qualification rules; stdout only.
- Status: Closed 2026-09-04 with seven temporary-fixture tests and one separately approved real audit.
  The real audit made no provider call, database/runtime action, archive write, scheduler action,
  strategy change, PAPER action, wallet action, signing, submission, order, fill, or position.

#### backend/src/research-exploratory-measurement-audit/

- Purpose: Isolated Phase 10.6B.1 reader, fixed measurement-gate service, deterministic formatter,
  strict CLI parser, hard-pinned identity, and synthetic-fixture tests.
- Usage: Reached only by `pnpm research:exploratory-cohort:measurement-audit --` after separate
  approval for the exact immutable root; output is Markdown or JSON on stdout only.
- Important parameters: Opaque later-label quarantine; four hard-pinned raw artifact hashes; zero
  provider/RPC/HTTP, database, runtime, filesystem-write, scheduler, strategy, PAPER, wallet,
  signing, submission, order, fill, and position actions.
- Tests: `backend/src/research-exploratory-measurement-audit/ExploratoryMeasurementAudit.test.ts`.

#### Implemented Phase 10.6B.2 Measurement-Only Protocol Design And Static Review

- Purpose: Documentation-first successor to the closed Phase 10.6B.1 audit. It may specify one
  concrete, outcome-blind V3 measurement protocol and an isolated static validator, or document why
  no defensible draft is possible.
- Usage: The source-controlled V3 document and its isolated static validator are implemented. Any real
  static validation, collector implementation, collection authorization, or scheduler action remains
  a separate decision.
- Important parameters: Fixed 10.6B.1 evidence fingerprint and three aggregate field signatures;
  strict direct-provider/no-expansion/no-retry/no-fallback boundary; no archive access, provider call,
  database/runtime action, strategy/PAPER/execution surface, candidate, or Phase 10.6C authority.
- Status: Closed on 2026-09-04 after its one separately approved real-source static validation returned
  `MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW`. No collector, provider
  call, archive action, scheduler, collection, or execution behavior is authorized by this inventory
  entry.

#### docs/NeXusTrade-Phase-10.6B.2-Detailed-Checklist.md

- Purpose: Detailed completion contract for the pinned V3 measurement-only protocol, local static
  validator, synthetic-only tests, and all separate downstream approval gates.
- Usage: The implementation is complete and documented. It does not authorize real static validation,
  provider call, archive read, collector, scheduler, or collection.
- Important parameters: Exact V2/B.1 evidence identity, strict V3 schema/semantics, frozen safety and
  availability rules, fixed static-validator CLI, and default-deny result meanings.

#### docs/research-protocols/phase10.6a-exploratory-cohort.v3.json

- Purpose: Pinned `EXPLORATORY_COHORT_MEASUREMENT@v3` measurement-only design record.
- Usage: It is the sole accepted source path for the future stdout-only static validator. That command
  requires separate explicit approval and remains non-authorizing if it succeeds.
- Important parameters: Only the Phase 10.6B.1 fingerprint, V2 root/protocol identity, and three
  aggregate signatures; anchor liquidity, -15/-10/-5/0 direct price observations, exact 168/672
  DEXSCREENER caps, no retry/fallback/provider expansion, 90% per-objective/per-partition gates, and
  absent later observations/labels.
- Status: Source SHA-256 was pinned and matched by one separately approved static validation. It does
  not authorize collection.

#### backend/src/research-measurement-protocol/

- Purpose: Isolated static parser, fixed-path CLI configuration, content-identity checks, deterministic
  stdout formatters, and synthetic-only validation tests for the V3 measurement design.
- Usage: Reached only through `pnpm research:measurement-protocol:validate -- --protocol=...` after
  separate approval. It can read only that V3 source and fixed local constants, then emits stdout.
- Important parameters: Strict V3 schema, exact B.1/V2 evidence pins, explicit no-network/no-write
  safety counters, three public fail-closed errors, and a non-authorizing ready status.
- Status: Implemented and verified with five synthetic tests, then run once against the pinned V3 source
  after separate approval. It imports no collector, gateway, provider, database, runtime, strategy,
  PAPER, wallet, or execution module.

#### backend/src/scripts/research-measurement-protocol-validate.ts

- Purpose: Minimal stdout/stderr wrapper for the isolated V3 static validator.
- Usage: Invoked only through the named package script after a separate explicit approval.
- Status: Added and run once against the real V3 source after separate approval; its output was
  stdout-only and non-authorizing.

#### Implemented Phase 10.6A.2 V3 Measurement-Only Cohort Collector

- Purpose: Isolated collector for decision-time measurement availability only, not a strategy or
  shadow-validation study.
- Usage: Its source is implemented and synthetically verified. The one named root, launch record, and
  operator-owned scheduler are active under separate approval; archive-only analysis remains a later
  independent decision.
- Important parameters: One direct DEXSCREENER discovery at anchor−16 and `BEST_PAIR` snapshots at
  −15/−10/−5/0; V3 liquidity/5-minute/15-minute semantics; fixed 168/672 caps; no retry/fallback,
  raw payload, later label, V2 reuse, or execution surface; fail-closed archive lifecycle fidelity.
- Status: Implemented and synthetically verified on 2026-09-04. The source-controlled
  `measurement-v3-20260904-2100Z` launch record was approved and locally validated. The user then
  registered and armed its operator-owned scheduler on 2026-09-04; that exact frozen
  measurement-only collection is active. No archive analysis, Phase 10.6C, strategy, PAPER, or
  execution action is authorized by this inventory entry.

#### docs/NeXusTrade-Phase-10.6A.2-Detailed-Checklist.md

- Purpose: Detailed V3 collector implementation, synthetic verification, archive/lock, launch, and
  downstream authorization contract.
- Usage: Completed implementation/verification record. It retains the separate named-root, scheduler,
  and archive-analysis authorization gates.
- Important parameters: Pinned V3 source/static result, strict source-derived lifecycle mapping,
  direct DEXSCREENER-only timing and caps, eight-code missingness, immutable archive rules, and the
  staged implementation/named-root/scheduler/archive-analysis gates.
- Status: Implementation, synthetic verification, named-launch, and scheduler-arming items are
  complete. Post-collection archive-analysis authority deliberately remains open.

#### Implemented Phase 10.6B.3 V3 Final Measurement Capability Analysis

- Purpose: Future final-archive-only assessment of whether the frozen V3 measurement design met its
  declared availability, freshness, provenance, independence, and zero-safety gates.
- Usage: Implemented after separate approval with temporary synthetic fixtures. The production
  command rejects before opening an archive until a later source-reviewed final-identity binding is
  committed; one real stdout-only exact-root run then needs separate approval.
- Important parameters: Exactly the active V3 root/protocol, four final artifact hashes to be bound
  only after collection finality, three objective fields, frozen 90%/60-second/partition/date gates,
  deterministic bounded output, and no numerical measurement-value or row-level disclosure.
- Status: Implemented with an initial passing synthetic suite on 2026-09-09. Phase 10.6H H1 completed
  its required-test coverage on 2026-09-10 with 245 tests and passing source checks. The isolated analyzer module and
  `research:measurement-cohort:analyze` command exist, but production identity binding remains
  intentionally unset. No real V3 archive analysis is authorized or has occurred.

#### docs/NeXusTrade-Phase-10.6B.3-Detailed-Checklist.md

- Purpose: Detailed contract for a synthetic-first V3 final measurement-capability analyzer and its
  separately gated final identity binding/run.
- Usage: Implementation and synthetic-verification record. It leaves the active V3 root, protocol,
  scheduler, and archive data untouched.
- Important parameters: Default-deny identity-unregistered production behavior; no provider,
  database/runtime, archive-write, scheduler, strategy, PAPER, wallet, or execution behavior.

#### docs/NeXusTrade-Phase-10.6H-Detailed-Checklist.md

- Purpose: Bounded existing-code engineering improvement phase, parallel to research evidence gates.
- Usage: Scope H1 analyzer verification, H2 accounting/schema/migration integrity and reconciliation,
  H3 provider concurrency, and H4 enforced dependencies/runtime validation/development checks.
- Important parameters: Preserve the active V3 operational checkout, dependency graph, protocol,
  launch, archive, and scheduler. Parallel implementation requires physical checkout/dependency/data
  isolation. No operational database migration, provider run, PAPER action, or new study is implied.
- Status: H1 complete and committed as `a0bfdf9`. H2 isolated engineering acceptance is complete (194 tests);
  H2 is committed as `ff6d586`; H3 is implemented and integrated into main; H4 is complete and integrated into main at `88921e9`. H1 precedes final identity binding; applicable H2-H4 acceptance precedes
  future PAPER operations. H1 implementation and synthetic evidence are recorded in its verification document.

#### docs/Post-V3-Development-Plan.md

- Purpose: Near-term V3 closeout sequence and requirements for engineering and research successors.
- Usage: Read before scoping parallel work, final review, or future phase checklists.
- Important parameters: September 18 11:44 AM PDT final invocation/noon PDT anchor, separate finality/
  binding/run gates, all three non-authorizing measurement outcomes, missing candidate-producing
  research-design gate, and future 10.6C/10.7/10.7A/10.8A/B/10.9/11-14 acceptance requirements.
- Status: Documentation plan recorded 2026-09-09. No new protocol, candidate, collection, detailed
  pilot pre-registration, migration, or execution authorization.

#### docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z.json

- Purpose: The one approved source-controlled V3 measurement-only launch identity.
- Usage: Pins the `2026-09-04T21:00:00.000Z` anchor and the matching
  `data/archive/phase10.6a/measurement-v3-20260904-2100Z/` root. It was locally schema/identity
  validated without constructing a gateway or making a provider call.
- Important parameters: Exact V3 protocol SHA/static-validation fingerprint; non-secret authorization
  reference and operator metadata only; no provider configuration, URL, command, or scheduler content.
- Status: Approved named-launch record. It was used only after separate scheduler authorization for
  the matching active root; it does not authorize another root, schedule change, archive analysis, or
  execution action.

#### docs/research-launches/phase10.6a-measurement-v3-20260904-2100Z-operator-runbook.md

- Purpose: Operator-owned Windows Task Scheduler instructions for the one approved V3 launch record.
- Usage: Create the task disabled, inspect its fixed local-PDT trigger and action, then enable it only
  before the 1:44 PM PDT start. It contains no credential, provider configuration, output redirect,
  retry, catch-up, or wrapper loop.
- Important parameters: 168 starts every two hours for 335 hours 59 minutes; direct DEXSCREENER-only
  one-shot command; interactive local user; one running instance; 17-minute execution limit.
- Status: Runbook provided after separate scheduler authorization. The user registered and armed the
  operator-owned task for the matching active root on 2026-09-04; NeXusTrade did not create or manage
  the operating-system task.

#### backend/src/research-measurement-cohort/

- Purpose: Isolated V3 collector types, fixed identity/launch guards, deterministic selection, injected
  clock/gateway, direct DEXSCREENER-only adapter, immutable archive/lock lifecycle, formatter, and
  synthetic tests.
- Usage: Reached only by `pnpm research:measurement-cohort:collect --`; it fails closed unless the
  pinned V3 protocol, one named source-controlled launch record, and `--once` are supplied.
- Important parameters: 100-item discovery, −16/−15/−10/−5/0 schedule, 168/672 caps, timeout 10s,
  retry 0, no fallback, no later labels, safe source aggregates, lock-before-artifacts, and literal
  zero database/runtime/session/execution facts.
- Status: Implemented and synthetically verified with fake clock/gateway and temporary roots before
  the separately approved real launch. The one active real root is limited to the frozen V3
  measurement-only protocol; no strategy/PAPER/execution behavior is present.

#### backend/src/research-exploratory-cohort/

- Purpose: Isolated Phase 10.6A V2 observational collector: strict CLI/launch checks, protocol
  pinning, direct narrow provider gateway, deterministic selection, injected clock, safe evidence
  mapping, archive lifecycle, formatter, and fake-provider tests.
- Usage: Reached only by `pnpm research:exploratory-cohort:collect --`; it requires a separately
  source-controlled launch record before it can create an archive or call a provider.
- Important parameters: `discoverTokens(100)`, 2-hour slots, end-minus-60-second start window,
  168/168/168/672 fixed caps, no retry/fallback/generic router, direct DEXSCREENER/JUPITER
  capabilities, first-root locking before artifacts, canonical sanitized source hashes, aggregate-only
  final summaries, stale-lock finalization before any new request, canonical missed-slot reconciliation,
  manifest/unit/source active hashes, and provider-free existing-root-only final closeout.
- Status: Phase 10.6A.1 implementation complete 2026-08-19 with local fake adapters only.
  `corepack pnpm verify` passed: backend 114 files / 386 tests, frontend 2 / 4, shared 4 / 13. The
  separately authorized live collection later finalized `COHORT_COMPLETE`; its repeating collector
  task is disabled and the provider-free confirmation remains separate.

#### docs/research-launches/phase10.6a-exploratory-cohort-v2.schema.json

- Purpose: Strict source-controlled launch-record schema for one separately approved first V2 root.
- Usage: A future authorized operator creates one matching record at the derived timestamp path; the
  collector does not accept a launch-record CLI override.
- Important parameters: Pins archive root/start, V2 protocol hash, validator fingerprint, literal
  authorization state, and bounded non-secret authorization reference.
- Status: Schema implemented. The one authorized launch record below was locally validated before its
  single authorized collection, which later finalized `COHORT_COMPLETE`.

#### docs/research-launches/phase10.6a-exploratory-cohort-v2-20260821-0000Z.json

- Purpose: The one source-controlled, user-authorized V2 launch identity for the first observational
  cohort.
- Usage: Resolved only by the collector from its exact approved archive root; it is not supplied by a
  separate CLI option and must not be modified after commit.
- Important parameters: Pins archive root `phase10.6a/exploratory-cohort-v2-20260821-0000Z`, UTC
  start `2026-08-21T00:00:00.000Z`, V2 protocol SHA, validation fingerprint, and a bounded
  non-secret authorization reference.
- Status: Locally validated on 2026-08-19 with zero provider/database/filesystem-write actions and
  an absent root. It was then used for the one authorized collection, which finalized
  `COHORT_COMPLETE` on 2026-08-29; the source record itself remains unchanged.

#### docs/research-launches/phase10.6a-exploratory-cohort-v2-20260821-0000Z-operator-runbook.md

- Purpose: External scheduler configuration and safety procedure used for the authorized V2
  observational cohort.
- Usage: An operator may use it to configure an external scheduler only after committing the launch
  record; it never registers a task or starts a process itself.
- Important parameters: Exactly 168 two-hour UTC normal starts, first at `2026-08-21T01:59:00.000Z`,
  no retry/catch-up/overlap/output redirect, plus one provider-free closeout at
  `2026-09-04T01:01:00.000Z`. A missed normal slot is availability evidence only, never a later
  provider backfill or additional market-observation slot.
- Status: Armed only after separate user authorization. The archive finalized `COHORT_COMPLETE` on
  2026-08-29 after 100 attempted slots and 96 valid units; the repeating collector task is now
  disabled. The one provider-free confirmation remains scheduled and cannot reopen or alter the
  finalized archive.

#### docs/research-protocols/phase10.6a-exploratory-cohort.v2.json

- Purpose: Frozen, source-controlled `ExploratoryCohortProtocolV2` for the proposed Phase 10.6A
  collection, with immutable V1 supersession evidence.
- Usage: Validate only with `pnpm research:protocol:validate --
--protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v2.json`; it is never generated
  or changed by the command.
- Important parameters: Preserves outcome-blind 2-hour slots and the 96 planned / 72 minimum cohort,
  but fixes 168/168/168/672 request caps to cover all attempted slots and labels without retry or
  fallback. Its archive grammar is `YYYYMMDD-HHmmZ`; the first approved launch is constrained to
  `00:00Z` by the Phase 10.6A checklist.
- Status: Implemented as a static non-authorizing protocol record 2026-08-19; SHA-256
  `2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed`.

#### backend/src/research-protocol/

- Purpose: Static protocol config, strict schema, SHA-256 pinning, validator service, formatters,
  bounded errors, and focused no-side-effect tests for Phase 10.5A.
- Usage: Called only through `research:protocol:validate`; it reads the approved source-controlled
  protocol and emits one Markdown or JSON validation to stdout.
- Important parameters: Accepts only the approved repository-relative protocol path, one optional
  format, and one compatibility `--once`; rejects writes, databases, providers, runtime, execution,
  URL, and traversal options. Its sole success result is non-authorizing.
- Status: Implemented 2026-08-19; no collection/runtime or execution component is present.
- Tests: `ResearchProtocolConfig.test.ts`, `ResearchProtocolService.test.ts`, and
  `ResearchProtocolCli.test.ts`. Repository verification passed: 113 backend test files / 368 tests,
  4 shared test files / 13 tests, and 2 frontend test files / 4 tests.

#### backend/src/scripts/research-protocol-validate.ts

- Purpose: Stdout-only CLI entrypoint for the Phase 10.5A static protocol validator.
- Status: Implemented 2026-08-19; it loads no environment configuration and starts no runtime.

#### package.json and backend/package.json

- Purpose: Add root and backend `research:protocol:validate` scripts.
- Status: Modified in Phase 10.5A; the scripts invoke only the static local validator.

#### Proposed Phase 10.7A Paper-Pilot Experiment Protocol

- Purpose: Documentation-only pre-registration contract between a successful Phase 10.7 promotion
  review and later paper-operations work.
- Usage: Draft only after a promoted evidence-backed profile exists. It must freeze a small set of
  versioned profiles, a common timestamped market universe, isolated simulated portfolio identities,
  a cost/fill model, session and risk limits, metrics, and between-batch-only revision rules.
- Important parameters: A future 4-6-hour session and 5-7-day batch require explicit pre-registered
  sampling, independence, and minimum-evidence values. No mid-batch tuning, cross-profile capital
  sharing, or cherry-picking is allowed.
- Status: Proposed and blocked upstream. It authorizes no provider call, database/runtime write,
  session, simulated order/fill/position/P/L, PAPER configuration, wallet, signing, or submission.

#### Proposed Phase 10.8A Paper Operations Dashboard

- Purpose: Future local, read-only operational dashboard for a promoted controlled PAPER pilot;
  distinct from the archive-only Phase 10 Research Dashboard.
- Usage: Plan only after a Phase 10.7 promotion review and Phase 10.7A Paper-Pilot Experiment
  Protocol are complete. Create a dedicated detailed checklist before implementation.
- Important parameters: Displays active PAPER sessions, orders, fills, positions, realized and
  unrealized P/L, daily/cumulative P/L, equity/drawdown, exposure, quote provenance, mark
  timestamps, and stale-mark warnings. The initial interface contains no execution, provider,
  wallet, signing, or transaction-submission controls.
- Status: Proposed but currently blocked upstream: no Phase 10.6C candidate, Phase 10.7 promotion,
  or frozen Phase 10.7A protocol exists. No implementation is authorized by this inventory entry.

#### frontend/README.md

- Purpose: Records the current frontend state and Phase 10 local-dashboard boundary.
- Usage: Read before exporting data or serving the local dashboard.
- Important parameters: Vite/React static viewer for ignored generated archive JSON only; local
  phase/run/report-kind/provider-evidence filters; archived cohort/gate/provider evidence; and no
  wallet, execution, provider, or runtime controls. The wide provider table scrolls horizontally and
  retains its full archive-relative provenance in a compact native disclosure; the Decision-time
  facts table has the same horizontal-scroll treatment.
- Status: Implemented in Phase 10; evidence-fidelity display refinements added in Phase 10.1 and
  provider-table and candidate-table presentation polish in Phases 10.2 and 10.3.
- Tests: Frontend loader/component tests and production Vite build.

#### shared/src/research-dashboard.ts

- Purpose: Defines versioned, Zod-validated browser contracts for dashboard manifest, safety, run,
  provider-pressure, cohort, candidate, decision-time feature, and outcome-label data.
- Usage: Imported by the archive exporter and local frontend only.
- Important parameters: Locks `PAPER`/shadow-only, BUY=90, WATCH=70, and all execution/provider/
  database/wallet behavior to disabled/false in the exported contract; records report kinds and
  optional archived provider-pressure distinctions with explicit missingness.
- Status: Added in Phase 10; extended read-only in Phase 10.1.
- Tests: Validated by exporter and frontend loader tests.

#### backend/src/research-dashboard/ and backend/src/scripts/dashboard-export.ts

- Purpose: Strict one-way exporter from selected completed structured archives to local static JSON.
- Usage: `pnpm dashboard:export -- --archive-root=data/archive --include-phase=phase9.28
--include-phase=phase9.29 --include-cohort=phase9.29/combined-valid-three-20260818-1539
--output-dir=frontend/public/research-dashboard-data`.
- Important parameters: Requires explicit phase allowlists; excludes active databases, transcripts,
  cleanup copies, provider/runtime options, URLs, and output escapes; writes only the generated-data
  directory and rejects credential-shaped output.
- Status: Added in Phase 10.
- Tests: `DashboardExportConfig.test.ts`, `ArchiveCatalogBuilder.test.ts`, and
  `DashboardExportService.test.ts`.

#### frontend/src/, frontend/package.json, frontend/vite.config.ts, and frontend/tsconfig\*.json

- Purpose: Local static evidence viewer and its isolated Vite/Bundler test/build configuration.
- Usage: `pnpm dashboard:dev` after the explicit archive export, or `pnpm dashboard:build` for the
  production bundle.
- Important parameters: Fetches only the fixed local generated-data resource allowlist; displays
  decision-time facts separately from later labels and renders no execution controls.
- Status: Added in Phase 10.
- Tests: `frontend/src/dashboardData.test.ts` and `frontend/src/App.test.tsx`.

#### backend/src/shadow-fast-attribution/ and backend/src/scripts/shadow-fast-feature-attribute.ts

- Purpose: Provide the Phase 9.29 archive-only F65E feature extractor, primary-label resolver,
  concentration gates, bounded formatter, and CLI entrypoint.
- Usage: `pnpm shadow:fast-feature-attribute --once --label-run=<label>:<archive-path>`; writes
  artifacts only when `--output-dir` is explicit.
- Important parameters: Accepts archived runs only, reuses F65E selection and exact 3/5/15 primary
  labels, uses only stored/pre-decision features, rejects active/runtime/execution options, and
  cannot create a successor through threshold search.
- Status: Added in Phase 9.29; smoke-validated against the three final Phase 9.28 archives.
- Tests: `FastEntryAttributionConfig.test.ts` and `FastEntryAttributionService.test.ts`.

#### backend/src/shadow-fast/

- Purpose: Contains the fixed F65E@v1 profile contract, stored-fact selector, fast observer, and
  archive-only fast-exit validator.
- Usage: `shadow:fast-observe` uses these modules at runtime; `shadow:fast-exit-validate` reads
  completed archive databases only.
- Important parameters: F65E selects 65-69 stored SKIP decisions under the original 90/70
  baseline, caps selection at 10 per session, and uses only 3/5/15-minute observations with a
  two-minute lateness boundary.
- Status: Added in Phase 9.28; no migration and no order/fill/position path.

#### backend/src/research/ResearchRunArchiveLoader.ts

- Purpose: Resolves completed TerminalRunner archives for read-only research commands.
- Usage: Shared by aggregate, counterfactual, and narrow-threshold reports.
- Important parameters: Ignores the Phase 9.27 `threshold-validation` artifact directory when
  locating the single nested TerminalRunner JSON output.
- Status: Updated in Phase 9.27 fresh-validation closeout.
- Tests: Verifies a nested threshold report cannot make archive discovery ambiguous.

#### docs/NeXusTrade-Phase-9.3-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Raydium as the first direct quote fallback.
- Usage: Read before implementing Phase 9.3 provider expansion.
- Important parameters: Adds `RAYDIUM` behind the existing `QuoteProvider` interface; uses only
  Raydium Trade API quote computation; requires no API key for the first planned implementation;
  does not call transaction serialization endpoints; keeps paper BUY automation disabled; requires
  quote provenance, fallback reason, explicit success criteria, and a Phase 9.3 exit gate.
- Status: Implemented; validation reviewed.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.3B-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Raydium error diagnostics, optional Raydium API v3
  pool/mint diagnostics, and Helius metadata/risk pressure cleanup.
- Usage: Read for Phase 9.3B implementation and validation context.
- Important parameters: Classifies Raydium quote failures; distinguishes quote evidence from
  mint-price/pool-preflight diagnostics; adds Helius cache/backoff; keeps paper BUY automation,
  wallet loading, signing, and submission disabled.
- Status: Implemented; validation complete.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.3C-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for replacing Helius authority evidence with raw Solana
  RPC mint-account parsing and optional QuickNode/Alchemy DAS metadata fallbacks.
- Usage: Read before validating or extending Phase 9.3C.
- Important parameters: Documents implemented `SOLANA_RPC`, `QUICKNODE_DAS`, and `ALCHEMY_DAS`
  provider surfaces; defers Shyft; keeps authority evidence conservative; uses `getAccountInfo` for
  mint/freeze authority; keeps paper BUY automation, wallet loading, signing, and submission
  disabled.
- Status: Implemented; provider validation and post-fix follow-up validation complete.
- Tests: Backend typecheck, backend test suite, three Phase 9.3C TerminalRunner archives, and the
  July 19 post-fix follow-up archive.

#### docs/NeXusTrade-Phase-9.4-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Birdeye selective market-data enrichment.
- Usage: Read before implementing Birdeye provider support or running Phase 9.4 validation.
- Important parameters: Treats Birdeye Standard/free as budget-constrained; uses Birdeye only for
  high-intent candidates; maps price/overview evidence without treating Birdeye as executable quote
  evidence; keeps paper BUY automation, wallet loading, signing, and submission disabled.
- Status: Implemented; validation complete.
- Tests: Full verification, provider smoke, and three Phase 9.4 TerminalRunner validation archives.

#### docs/NeXusTrade-Phase-9.4-Conclusion-and-9.4A-Prep.md

- Purpose: Phase 9.4 validation conclusion and planning handoff for Phase 9.4A / 9.4B.
- Usage: Read before creating the Phase 9.4A detailed implementation checklist.
- Important parameters: Captures the three-run Phase 9.4 aggregate, states that Birdeye operational
  integration passed, keeps paper BUY disabled, preserves Phase 9.5 for Autobahn/Titan research,
  defines Phase 9.4A.1 archive/reporting truthing, Phase 9.4A.2 adapter diagnostics, and Phase 9.4B
  quote-pressure reduction.
- Status: Added as Phase 9.4 closeout and next-phase planning input.
- Tests: Manual documentation review.

#### docs/NeXusTrade-Phase-9.4A.1-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Phase 9.4A.1 archive and reporting truthing.
- Usage: Read before implementing `research:truth` or changing Phase 9.4 report attribution.
- Important parameters: Read-only archive processing; full-session database counts; report
  truncation disclosure; quote-evidence decomposition; Birdeye CU/budget attribution; enriched
  versus eligible-control outcomes; concentration, leave-one-run-out, leave-one-mint-out, blocker,
  and scenario-portfolio audits.
- Status: Implemented; smoke validation and closeout patch complete.
- Tests: Manual documentation review plus `research:truth` smoke against the three Phase 9.4
  archive DBs.

#### docs/NeXusTrade-Phase-9.4A.2-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Phase 9.4A.2 adapter correctness and diagnostics.
- Usage: Read before changing Raydium preflight/parsing, quote-result telemetry, or quote-router
  diagnostic state.
- Important parameters: Corrects the current Raydium API v3 pair-preflight request; parses
  top-level Raydium `msg`; treats deterministic request errors as nonretryable; adds sanitized HTTP
  attempt telemetry with derived rate hints, bounded latest-attempt/last-success quote state, and
  opt-in round-trip `quote:diagnose`.
- Status: Implemented; short runtime validation complete.
- Tests: Focused adapter/router tests, provider smoke, `quote:diagnose --once --mode=all`, and
  short shadow-only TerminalRunner validation archive
  `data/archive/phase9.4A.2/short-phase9.4A.2-short-20260806-1255`.

#### docs/NeXusTrade-Phase-9.4B-Detailed-Checklist.md

- Purpose: Implementation-ready checklist for Phase 9.4B quote-pressure reduction, demand control,
  and venue-aware Raydium probing.
- Usage: Read before changing quote scheduling, single-flight request joining, negative quote
  caches, Raydium venue guards, or provider-pressure reporting.
- Important parameters: Keeps provider order `JUPITER -> RAYDIUM`; adds local Jupiter pacing,
  duplicate-demand suppression, negative quote evidence, Raydium no-pool/no-route suppression, and
  DexScreener venue-aware Raydium probe control; forbids provider expansion, strategy changes,
  paper execution, wallet loading, signing, and transaction submission.
- Status: Implemented and runtime-validated. Raydium control is accepted; Jupiter refinement moves
  to Phase 9.4C.
- Tests: Focused quote scheduler, single-flight, negative cache, Raydium venue guard, router,
  provider-pressure classifier, provider smoke, quote diagnose, one smoke, and two full
  TerminalRunner validation archives.

#### docs/NeXusTrade-Phase-9.4C-Detailed-Checklist.md

- Purpose: Implementation and runtime-validation checklist for one shared adaptive Jupiter demand
  controller.
- Usage: Read before changing Jupiter price/quote pacing, local request budgets, adaptive backoff,
  quote priorities, or pressure-report semantics.
- Important parameters: Shared Jupiter price/quote budget, conservative free-tier headroom,
  priority-aware deferral, distinct upstream-429/local-deferral telemetry, and two full PAPER/
  shadow-only validations. Helius is intentionally excluded.
- Status: Planning complete; implementation has not started.
- Tests: Planned controller/config/router/classifier/reporting tests plus smoke and full validation
  runs.

#### docs/Provider-Strategy-Phase9Plus.md

- Purpose: Active provider bottleneck and fallback strategy for Phase 9+.
- Usage: Read before changing provider behavior or adding new providers.
- Important parameters: Phase 9 provider-pressure-only scope; Phase 9.1 research aggregation;
  Phase 9.2 quote cache/backoff/fallback framework; Raydium first direct quote fallback; Birdeye
  selective enrichment; Autobahn/Titan access-gated fallbacks; Meteora/Orca later pool-specific
  adapters.
- Status: Started.
- Tests: Manual documentation review.

## Phase 9 Runtime Files Added

#### backend/src/terminal-runner/TerminalRunnerConfig.ts

- Purpose: Parse and validate TerminalRunner runtime options.
- Status: Implemented.
- Tests: `backend/src/terminal-runner/TerminalRunnerConfig.test.ts`.

#### backend/src/terminal-runner/TerminalRunner.ts

- Purpose: Coordinate one or more shadow-safe pipeline cycles, emit compact progress logs, and
  carry the TerminalRunner session id into the final summary.
- Status: Implemented.
- Tests: `backend/src/terminal-runner/TerminalRunner.test.ts`.

#### backend/src/terminal-runner/TerminalStageRunner.ts

- Purpose: Wrap existing scanner, risk, strategy, shadow, watchlist, analytics, and calibration
  runner surfaces behind a consistent stage result contract while passing the same
  TerminalRunner-created `sessionId` through every stage in a run.
- Status: Implemented.
- Tests: Covered through TerminalRunner and existing stage/service tests.

#### backend/src/terminal-runner/TerminalRunSummary.ts

- Purpose: Build human-readable and machine-readable cycle summaries.
- Status: Implemented.
- Tests: `backend/src/terminal-runner/TerminalRunSummary.test.ts`.

#### backend/src/scripts/terminal-runner.ts

- Purpose: CLI entrypoint for Phase 9 TerminalRunner. Creates one `PAPER` + `RUNNING` session per
  run and wires progress logging unless `--json` is requested.
- Status: Implemented.

#### backend/src/terminal-runner/\*.test.ts

- Purpose: Validate config parsing, stage ordering, safety boundaries, zero-candidate cycles,
  failure handling, and summary output.
- Status: Implemented.

## Phase 9.1 Runtime Files Added

#### backend/src/research/ResearchAggregateConfig.ts

- Purpose: Parse and validate `research:aggregate` runtime options.
- Status: Implemented.
- Tests: `backend/src/research/ResearchAggregateConfig.test.ts`.

#### backend/src/research/ResearchRunArchiveLoader.ts

- Purpose: Resolve Phase 9 archive folders, locate `nexus_paper.db`, locate TerminalRunner JSON,
  and record optional tail-report paths without mutating archived data.
- Status: Implemented.

#### backend/src/research/CrossRunResearchService.ts

- Purpose: Validate one-session TerminalRunner archives, summarize provider pressure, compare
  threshold outcomes, and detect run/mint win concentration.
- Status: Implemented.
- Tests: `backend/src/research/CrossRunResearchService.test.ts`.

#### backend/src/research/PromotionGateService.ts

- Purpose: Convert cross-run evidence and shadow-entry readiness into
  `NOT_READY`, `PROMISING_RESEARCH`, or `CANDIDATE_FOR_CONTROLLED_PAPER_PILOT` labels while keeping
  paper BUY automation disabled.
- Status: Implemented.
- Tests: `backend/src/research/PromotionGateService.test.ts`.

#### backend/src/research/ResearchAggregateReportFormatter.ts

- Purpose: Format text and JSON research aggregate reports and optionally write ignored `data/`
  report artifacts. JSON output summarizes TerminalRunner archives and omits raw per-cycle payloads;
  the full runner JSON remains in each archive folder.
- Status: Implemented.

#### backend/src/research/ResearchAggregateRunner.ts

- Purpose: Compose archive loading, shadow calibration, shadow entry workbench output, cross-run
  metrics, and promotion-gate reporting.
- Status: Implemented.

#### backend/src/scripts/research-aggregate.ts

- Purpose: CLI entrypoint for Phase 9.1 cross-run research aggregation.
- Status: Implemented.

#### backend/src/research/\*.test.ts

- Purpose: Validate config parsing, one-session archive validation, cross-run threshold math, and
  promotion-gate labels.
- Status: Implemented.

## Phase 9.2 Runtime Files Added

These files implement the Phase 9.2 provider-resilience framework.

#### backend/src/providers/quotes/QuoteRequestKey.ts

- Purpose: Build deterministic quote request cache keys from provider name and normalized
  `QuoteRequest` fields.
- Status: Implemented.
- Tests: `backend/src/providers/quotes/QuoteRequestKey.test.ts`.

#### backend/src/providers/quotes/QuoteCache.ts

- Purpose: Provide process-local in-memory quote caching with TTL, max-entry eviction, and cache
  hit/miss metadata.
- Status: Implemented.
- Tests: `backend/src/providers/quotes/QuoteCache.test.ts`.

#### backend/src/providers/quotes/QuoteBackoffPolicy.ts

- Purpose: Track provider-operation cooldowns after rate limits and expose cooldown skip decisions.
- Status: Implemented.
- Tests: `backend/src/providers/quotes/QuoteBackoffPolicy.test.ts`.

#### backend/src/providers/quotes/QuotePriority.ts

- Purpose: Define quote request priorities such as `CRITICAL`, `HIGH`, `NORMAL`, and `LOW`.
- Status: Implemented.
- Tests: Covered through quote router tests.

#### backend/src/providers/quotes/QuoteProviderRouter.ts

- Purpose: Route quote requests through cache, backoff, priority, and future fallback provider
  ordering while preserving quote provenance.
- Status: Implemented.
- Tests: `backend/src/providers/quotes/QuoteProviderRouter.test.ts`.

#### backend/src/providers/quotes/index.ts

- Purpose: Export Phase 9.2 quote-resilience utilities.
- Status: Implemented.

#### backend/src/providers/quotes/\*.test.ts

- Purpose: Validate quote key stability, cache TTL/eviction behavior, backoff behavior, priority
  handling, router provenance, and Jupiter-only fallback behavior.
- Status: Implemented.

## Phase 9.2 Runtime Files Modified

#### backend/src/providers/ProviderRegistry.ts

- Purpose: Creates the Jupiter-only quote router from enabled quote providers and returns it from
  `getQuoteProviders()`.
- Status: Modified in Phase 9.2.
- Tests: Covered through provider, scanner, risk, and strategy test suites.

#### backend/src/providers/config/providerConfig.ts

- Purpose: Adds `quoteResilience` config for quote cache and quote backoff defaults/env overrides.
- Status: Modified in Phase 9.2.
- Tests: `backend/src/config/env.test.ts`.

#### backend/src/config/env.test.ts

- Purpose: Validates quote-resilience defaults, explicit overrides, and invalid values.
- Status: Modified in Phase 9.2.

## Phase 9.2B Runtime Files Added

These files implement provider truthing and Jupiter metadata pressure cleanup.

#### backend/src/providers/ProviderPressureClassifier.ts

- Purpose: Classify `ProviderHealth` rows as live provider rows, router cache rows, router cooldown
  rows, unavailable router rows, or disabled provider rows.
- Status: Implemented.
- Tests: `backend/src/providers/ProviderPressureClassifier.test.ts`.

#### backend/src/providers/ProviderRegistry.test.ts

- Purpose: Validate that Jupiter quote support remains enabled while Jupiter token metadata is
  disabled by default, and that Helius remains first when Jupiter metadata is explicitly enabled.
- Status: Implemented.

#### backend/src/research/ResearchRunArchiveLoader.test.ts

- Purpose: Validate nested TerminalRunner archive loading and clear failure for ambiguous nested
  JSON folders.
- Status: Implemented.

## Phase 9.2B Runtime Files Modified

#### backend/src/terminal-runner/TerminalRunSummary.ts

- Purpose: Updated to separate live provider pressure from router cache/cooldown metrics in
  TerminalRunner summaries.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/terminal-runner/TerminalRunSummary.test.ts`.

#### backend/src/research/CrossRunResearchService.ts

- Purpose: Updated to separate live provider pressure from router cache/cooldown metrics in
  cross-run research aggregation and promotion cautions.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/research/CrossRunResearchService.test.ts`,
  `backend/src/research/PromotionGateService.test.ts`.

#### backend/src/analytics/AnalyticsReportService.ts

- Purpose: Updated to report provider pressure with live-vs-router separation when practical.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/analytics/AnalyticsReportService.test.ts`.

#### backend/src/calibration/ProviderImpactAnalyzer.ts

- Purpose: Report live-vs-router provider pressure in calibration provider-impact output.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/calibration/CalibrationServices.test.ts`.

#### backend/src/shadow-calibration/ShadowCalibrationReportService.ts

- Purpose: Calculate Jupiter rate-limit summary from live-provider rows instead of router cooldown
  rows.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/shadow-calibration/ShadowCalibrationReportService.test.ts`.

#### backend/src/providers/jupiter/JupiterAdapter.ts

- Purpose: Updated to make Jupiter token metadata capability optional or configurable while
  preserving quote support.
- Status: Modified in Phase 9.2B.

#### backend/src/providers/ProviderRegistry.ts

- Purpose: Updated to prefer Helius token metadata and/or omit Jupiter token metadata by
  default.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/providers/ProviderRegistry.test.ts`.

#### backend/src/providers/config/providerConfig.ts

- Purpose: Updated for `JUPITER_TOKEN_METADATA_ENABLED` and revised
  `QUOTE_CACHE_TTL_MS=90000` default.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/config/env.test.ts`.

#### backend/src/research/ResearchRunArchiveLoader.ts

- Purpose: Updated to accept both `runner-output/` archives and nested run-label output
  folders.
- Status: Modified in Phase 9.2B.
- Tests: `backend/src/research/ResearchRunArchiveLoader.test.ts`.

## Package Scripts Added

#### backend/package.json

- Scripts: `terminal:run`, `research:aggregate`, `research:interpret`.

## Phase 9.25 Runtime Files Added

These files implement read-only research interpretation and skipped-opportunity diagnostics.

#### backend/src/research-interpretation/ResearchInterpretationConfig.ts

- Purpose: Parse and validate `research:interpret` runtime options.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationConfig.test.ts`.

#### backend/src/research-interpretation/ResearchInterpretationTypes.ts

- Purpose: Shared report, candidate, blocker, dedupe, provider, and recommendation matrix types.
- Status: Implemented.

#### backend/src/research-interpretation/DecisionAttributionService.ts

- Purpose: Convert strategy score attribution into first blocker, highest-impact blocker, readable
  blocker categories, and decision-level explanation rows.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/BlockerAnalysisService.ts

- Purpose: Aggregate blocker clusters by decision, score bucket, risk result, run, and outcome.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/OpportunityAnalysisService.ts

- Purpose: Identify high-scoring SKIPs, per-token missed opportunities, MFE/MAE-style best/worst
  return summaries, and target-before-stop outcomes.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/MarketWindowAnalysisService.ts

- Purpose: Measure whether observed wins are concentrated by run or time window.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/ProviderInterpretationService.ts

- Purpose: Interpret provider pressure, missing quote outcomes, cache hits, cooldown skips, and
  whether provider work appears likely to help.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/ResearchInterpretationStats.ts

- Purpose: Shared target/stop ordering and grouped outcome summary helpers.
- Status: Implemented.
- Tests: `backend/src/research-interpretation/ResearchInterpretationServices.test.ts`.

#### backend/src/research-interpretation/ResearchInterpretationRunner.ts

- Purpose: Compose archive loading, candidate normalization, attribution, blocker analysis,
  opportunity analysis, market-window analysis, provider interpretation, and recommendations.
- Status: Implemented.

#### backend/src/research-interpretation/ResearchInterpretationReportFormatter.ts

- Purpose: Format Phase 9.25 text and JSON reports.
- Status: Implemented.

#### backend/src/scripts/research-interpret.ts

- Purpose: CLI entrypoint for Phase 9.25 read-only interpretation.
- Status: Implemented.

#### package.json

- Scripts: `terminal:run`, `research:aggregate`, `research:interpret`.

## Phase 9.3 Runtime Files Added

These files implement Raydium as a quote-only provider fallback.

#### backend/src/providers/raydium/RaydiumAdapter.ts

- Purpose: Implement `QuoteProvider` for Raydium exact-input quote computation.
- Status: Implemented.
- Tests: `backend/src/providers/raydium/RaydiumAdapter.test.ts`.

#### backend/src/providers/raydium/raydium.schemas.ts

- Purpose: Validate Raydium quote response shapes before mapping.
- Status: Implemented.
- Tests: Covered through Raydium adapter and mapper tests.

#### backend/src/providers/raydium/raydium.mappers.ts

- Purpose: Map Raydium quote responses into normalized `QuoteResult` values.
- Status: Implemented.
- Tests: `backend/src/providers/raydium/raydium.mappers.test.ts`.

## Phase 9.3 Runtime Files Modified

#### shared/src/providers/provider.types.ts

- Purpose: Add `RAYDIUM` as a provider name.
- Status: Modified in Phase 9.3.
- Tests: Existing shared and provider tests.

#### shared/src/market/quote.types.ts

- Purpose: Add normalized quote provenance fields so provider identity, live/cache source type, and
  fallback reason can be reported from each quote.
- Status: Modified in Phase 9.3.
- Tests: Existing shared and quote provider tests.

#### backend/src/providers/config/providerConfig.ts

- Purpose: Add Raydium base URL, rate limit, tx version, and provider enablement config.
- Status: Modified in Phase 9.3.
- Tests: `backend/src/config/env.test.ts`.

#### backend/src/providers/ProviderRegistry.ts

- Purpose: Register Raydium quote provider after Jupiter when enabled.
- Status: Modified in Phase 9.3.
- Tests: `backend/src/providers/ProviderRegistry.test.ts`.

#### backend/src/providers/quotes/QuoteProviderRouter.ts

- Purpose: Preserve cache/backoff behavior while attempting Raydium after Jupiter failures,
  rate limits, or cooldown skips.
- Status: Modified in Phase 9.3.
- Tests: `backend/src/providers/quotes/QuoteProviderRouter.test.ts`.

#### backend/src/scripts/providers-smoke.ts

- Purpose: Include Raydium quote smoke behavior without wallet, signing, or submission.
- Status: Modified in Phase 9.3.

#### backend/src/providers/ProviderPressureClassifier.ts

- Purpose: Count quote source types and fallback reasons alongside live-vs-router provider pressure.
- Status: Modified in Phase 9.3.
- Tests: `backend/src/providers/ProviderPressureClassifier.test.ts`.

#### backend/src/terminal-runner/TerminalRunSummary.ts

- Purpose: Include quote source type and fallback reason distributions in provider-pressure summaries.
- Status: Modified in Phase 9.3.
- Tests: `backend/src/terminal-runner/TerminalRunSummary.test.ts`.

#### backend/src/analytics/AnalyticsReportService.ts

- Purpose: Carry quote source type and fallback reason counts into analytics provider-health output.
- Status: Modified in Phase 9.3.

#### backend/src/calibration/ProviderImpactAnalyzer.ts

- Purpose: Carry quote source type and fallback reason counts into calibration provider-impact output.
- Status: Modified in Phase 9.3.

#### backend/src/research/CrossRunResearchService.ts

- Purpose: Carry quote source type and fallback reason counts into cross-run research provider pressure.
- Status: Modified in Phase 9.3.

## Phase 9.3B Runtime Files Added

These files implement Raydium diagnostics and Helius pressure cleanup.

#### backend/src/providers/raydium/RaydiumErrorClassifier.ts

- Purpose: Classify Raydium quote failures into normalized reason categories for provider-health
  context and reports.
- Status: Implemented.
- Tests: `backend/src/providers/raydium/RaydiumErrorClassifier.test.ts`.

#### backend/src/providers/raydium/RaydiumPreflightCache.ts

- Purpose: Cache Raydium API v3 pool-preflight results by normalized mint pair.
- Status: Implemented.
- Tests: `backend/src/providers/raydium/RaydiumPreflightCache.test.ts`.

#### backend/src/providers/raydium/RaydiumPoolPreflightService.ts

- Purpose: Use Raydium API v3 `/pools/info/mint` as optional route/pool diagnostics before quote
  compute, without fabricating quote evidence.
- Status: Implemented.
- Tests: `backend/src/providers/raydium/RaydiumPoolPreflightService.test.ts`.

#### backend/src/providers/raydium/raydium.pool.schemas.ts

- Purpose: Validate Raydium API v3 pool-by-mint responses.
- Status: Implemented.
- Tests: Covered through `RaydiumPoolPreflightService.test.ts`.

#### backend/src/providers/raydium/raydium.pool.mappers.ts

- Purpose: Summarize Raydium pool preflight responses into pool count and product type diagnostics.
- Status: Implemented.
- Tests: Covered through `RaydiumPoolPreflightService.test.ts`.

#### backend/src/providers/raydium/raydium.mintPrice.schemas.ts

- Purpose: Validate Raydium API v3 mint-price diagnostic responses.
- Status: Implemented.
- Tests: Covered through Raydium adapter/config tests.

#### backend/src/providers/raydium/raydium.mintPrice.mappers.ts

- Purpose: Report whether Raydium API v3 recognizes a mint price without converting it into quote
  evidence.
- Status: Implemented.
- Tests: Covered through Raydium adapter/config tests.

#### backend/src/providers/helius/HeliusEvidenceCache.ts

- Purpose: Cache Helius metadata and risk-evidence `getAsset` results by mint with separate TTLs.
- Status: Implemented.
- Tests: `backend/src/providers/helius/HeliusEvidenceCache.test.ts`.

#### backend/src/providers/helius/HeliusBackoffPolicy.ts

- Purpose: Track Helius operation cooldown after rate limits and support low-priority skip behavior.
- Status: Implemented.
- Tests: `backend/src/providers/helius/HeliusBackoffPolicy.test.ts`.

#### backend/src/providers/helius/HeliusAdapter.test.ts

- Purpose: Validate adapter-level Helius evidence cache and cooldown-skip behavior.
- Status: Implemented.

## Phase 9.3B Runtime Files Modified

#### backend/src/providers/raydium/RaydiumAdapter.ts

- Purpose: Add sanitized Raydium failure context, pool preflight, optional mint-price diagnostics,
  and Raydium failure-category reporting.
- Status: Modified in Phase 9.3B.
- Tests: `backend/src/providers/raydium/RaydiumAdapter.test.ts`.

#### backend/src/providers/helius/HeliusAdapter.ts

- Purpose: Add Helius evidence cache, getAsset backoff, cooldown skips, and evidence source/cache
  provider-health context.
- Status: Modified in Phase 9.3B.
- Tests: `backend/src/providers/helius/HeliusAdapter.test.ts`.

#### backend/src/providers/config/providerConfig.ts

- Purpose: Add Raydium diagnostics and Helius cache/backoff runtime options.
- Status: Modified in Phase 9.3B.
- Tests: `backend/src/config/env.test.ts`.

#### backend/src/providers/ProviderRegistry.ts

- Purpose: Wire Raydium API v3 preflight/mint diagnostics and Helius cache/backoff helpers.
- Status: Modified in Phase 9.3B.
- Tests: Existing provider registry/config tests.

#### backend/src/providers/ProviderPressureClassifier.ts

- Purpose: Count Raydium failure/preflight categories and Helius evidence/cache sources while
  keeping live provider rate limits separate from cache/cooldown bookkeeping.
- Status: Modified in Phase 9.3B.
- Tests: `backend/src/providers/ProviderPressureClassifier.test.ts`.

#### backend/src/terminal-runner/TerminalRunSummary.ts

- Purpose: Surface Raydium and Helius diagnostic counts in TerminalRunner provider-pressure output.
- Status: Modified in Phase 9.3B.
- Tests: `backend/src/terminal-runner/TerminalRunSummary.test.ts`.

#### backend/src/analytics/AnalyticsReportService.ts

- Purpose: Carry Raydium and Helius provider diagnostic counts into analytics provider-health
  output.
- Status: Modified in Phase 9.3B.

#### backend/src/analytics/AnalyticsReportFormatter.ts

- Purpose: Format compact Raydium and Helius diagnostic suffixes.
- Status: Modified in Phase 9.3B.

#### backend/src/calibration/ProviderImpactAnalyzer.ts

- Purpose: Carry Raydium and Helius diagnostic counts into calibration provider-impact output.
- Status: Modified in Phase 9.3B.

#### backend/src/calibration/CalibrationReportFormatter.ts

- Purpose: Format compact Raydium and Helius diagnostic suffixes in calibration reports.
- Status: Modified in Phase 9.3B.

#### backend/src/research/CrossRunResearchService.ts

- Purpose: Preserve Raydium and Helius diagnostic counts in cross-run research provider pressure.
- Status: Modified in Phase 9.3B.

#### backend/src/research/ResearchAggregateReportFormatter.ts

- Purpose: Format compact Raydium and Helius diagnostic suffixes in aggregate reports.
- Status: Modified in Phase 9.3B.

#### backend/src/research-interpretation/ProviderInterpretationService.ts

- Purpose: Include Raydium failure/preflight and Helius evidence/cache notes in provider
  interpretation.
- Status: Modified in Phase 9.3B.

#### backend/src/research-interpretation/ResearchInterpretationReportFormatter.ts

- Purpose: Format Raydium and Helius diagnostic counts in interpretation reports.
- Status: Modified in Phase 9.3B.

#### backend/src/scripts/providers-smoke.ts

- Purpose: Print compact provider diagnostics from the smoke window without adding wallet,
  signing, submission, or paper BUY behavior.
- Status: Modified in Phase 9.3B.

## Phase 9.4A.1 Runtime Files Added

These files implement read-only archive and reporting truthing.

#### backend/src/research-truthing/ResearchTruthingConfig.ts

- Purpose: Parse and validate `research:truth` runtime options.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingConfig.test.ts`.

#### backend/src/research-truthing/ResearchTruthingTypes.ts

- Purpose: Define stable report, audit, provider-classification, quote-evidence, Birdeye, blocker,
  concentration, and recommendation types for Phase 9.4A.1.
- Status: Implemented.
- Tests: Covered by research-truthing service tests and backend typecheck.

#### backend/src/research-truthing/ArchiveDatabaseTruthService.ts

- Purpose: Open archived paper DBs read-only/query-only, count core tables, and verify one-session
  archive consistency.
- Status: Implemented.
- Tests: Covered by `research:truth` archive smoke.

#### backend/src/research-truthing/ReportLimitTruthService.ts

- Purpose: Produce `rowsAvailable`, `rowsEvaluated`, `rowsDisplayed`, `displayLimit`,
  `displayTruncated`, and `omittedDisplayRows` metadata for capped report sections.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/QuoteEvidenceTruthService.ts

- Purpose: Truth missing-quote and price-impact evidence without treating Birdeye market data as
  executable quote evidence.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/BirdeyeTruthService.ts

- Purpose: Attribute Birdeye live calls, cache hits, budget guardrail skips, CU estimates, endpoint
  use, enriched mints, and eligible-control outcomes.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/ProviderReclassificationService.ts

- Purpose: Reclassify provider-health rows into live, router, policy, disabled, diagnostic, and
  unknown categories for research truthing.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/ConcentrationTruthService.ts

- Purpose: Report run/mint concentration and leave-one-run/mint-out summaries from archived
  decisions.
- Status: Implemented.
- Tests: Covered through backend typecheck and `research:truth` smoke.

#### backend/src/research-truthing/BlockerAuditService.ts

- Purpose: Classify `SKIP` with `blockers=none` as score-only, unresolved strategy gate, or
  insufficient archive evidence.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/ScenarioPortfolioAuditService.ts

- Purpose: Recompute target/stop ordering per configured max-hold window from archived observed
  return points.
- Status: Implemented.
- Tests: `backend/src/research-truthing/ResearchTruthingServices.test.ts`.

#### backend/src/research-truthing/ResearchTruthingRunner.ts

- Purpose: Compose archive loading, shadow-entry candidate normalization, dedupe, truthing
  services, safety checks, findings, and recommendation output.
- Status: Implemented.
- Tests: Covered by service/config tests, backend typecheck, and `research:truth` smoke.

#### backend/src/research-truthing/ResearchTruthingReportFormatter.ts

- Purpose: Format text and JSON research truthing reports and write ignored archive artifacts.
- Status: Implemented.
- Tests: Covered by `research:truth` smoke.

#### backend/src/scripts/research-truth.ts

- Purpose: CLI entrypoint for Phase 9.4A.1 `pnpm research:truth`.
- Status: Implemented.
- Tests: Covered by `research:truth` smoke.

## Phase 9.4A.1 Runtime Files Modified

#### package.json

- Purpose: Add root `research:truth` script.
- Status: Modified in Phase 9.4A.1.

#### backend/package.json

- Purpose: Add backend `research:truth` script.
- Status: Modified in Phase 9.4A.1.

## Phase 9.4A.2 Runtime Files Added

These files implement adapter correctness and quote diagnostics.

#### backend/src/providers/quotes/QuoteAttemptJournal.ts

- Purpose: Retain bounded in-memory quote-attempt diagnostics, separating latest attempt from last
  successful quote.
- Status: Implemented in Phase 9.4A.2.
- Tests: `backend/src/providers/quotes/QuoteAttemptJournal.test.ts`.

#### backend/src/quote-diagnostics/QuoteDiagnoseConfig.ts

- Purpose: Parse and validate `quote:diagnose --once` options before any provider call.
- Status: Implemented in Phase 9.4A.2.
- Tests: `backend/src/quote-diagnostics/QuoteDiagnoseConfig.test.ts`.

#### backend/src/quote-diagnostics/QuoteDiagnoseTypes.ts

- Purpose: Define stable report and probe types for router, Raydium, preflight, and optional
  round-trip diagnostics.
- Status: Implemented in Phase 9.4A.2.

#### backend/src/quote-diagnostics/QuoteDiagnoseRunner.ts

- Purpose: Run bounded PAPER-mode quote diagnostics through the normal provider registry without
  creating sessions or trade rows.
- Status: Implemented in Phase 9.4A.2.

#### backend/src/quote-diagnostics/QuoteDiagnoseReportFormatter.ts

- Purpose: Format text/JSON quote diagnostic reports and optional ignored artifacts.
- Status: Implemented in Phase 9.4A.2.

#### backend/src/scripts/quote-diagnose.ts

- Purpose: CLI entrypoint for `pnpm quote:diagnose`.
- Status: Implemented in Phase 9.4A.2.

## Phase 9.4A.2 Runtime Files Modified

#### shared/src/providers/provider-results.ts

- Purpose: Add additive `httpAttempts` and sanitized `diagnostics` fields to provider results.
- Status: Modified in Phase 9.4A.2.
- Tests: `shared/src/providers/provider-results.test.ts` and backend provider tests.

#### backend/src/providers/http/ProviderHttpClient.ts

- Purpose: Capture sanitized per-request HTTP attempt telemetry with endpoint IDs, outcomes,
  statuses, latency, retryability, and derived rate-limit hints only.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/http/ProviderHttpClient.test.ts`.

#### backend/src/providers/http/providerRetry.ts

- Purpose: Preserve ordered HTTP attempt telemetry across bounded retries.
- Status: Modified in Phase 9.4A.2.

#### backend/src/providers/raydium/RaydiumPoolPreflightService.ts

- Purpose: Use the documented API v3 `/pools/info/mint` parameter set and classify preflight
  failure details.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/raydium/RaydiumPoolPreflightService.test.ts`.

#### backend/src/providers/raydium/RaydiumAdapter.ts

- Purpose: Parse top-level Raydium `msg`, preserve stable failure details, expose direct preflight
  diagnostics, and keep compute quote-only.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/raydium/RaydiumAdapter.test.ts`.

#### backend/src/providers/raydium/RaydiumErrorClassifier.ts

- Purpose: Classify documented `REQ_*` messages into broad categories and precise
  `raydiumFailureDetail` values.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/raydium/RaydiumErrorClassifier.test.ts`.

#### backend/src/providers/quotes/QuoteProviderRouter.ts

- Purpose: Update the quote-attempt journal on success, cache, cooldown, fallback, failure, and
  unavailable paths.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/quotes/QuoteProviderRouter.test.ts`.

#### backend/src/providers/ProviderPressureClassifier.ts

- Purpose: Aggregate Raydium detail, preflight detail, HTTP attempt, latest-attempt, last-success,
  and divergence counts.
- Status: Modified in Phase 9.4A.2.
- Tests: `backend/src/providers/ProviderPressureClassifier.test.ts`.

#### backend/src/scripts/providers-smoke.ts

- Purpose: Include compact Phase 9.4A.2 diagnostic counts in provider smoke output.
- Status: Modified in Phase 9.4A.2.

#### package.json and backend/package.json

- Purpose: Add root and backend `quote:diagnose` scripts.
- Status: Modified in Phase 9.4A.2.

## Phase 9.4B Runtime Files

These files implement quote-pressure reduction and demand control. Runtime validation is complete;
Raydium control is accepted and Jupiter refinement moves to Phase 9.4C.

#### backend/src/providers/quotes/QuoteScheduler.ts

- Purpose: Pace live quote calls per provider and expose scheduler wait diagnostics.
- Status: Added in Phase 9.4B; runtime validation complete.
- Tests: `backend/src/providers/quotes/QuoteScheduler.test.ts`.

#### backend/src/providers/quotes/QuoteSingleFlight.ts

- Purpose: Join identical in-flight quote requests inside one Node process to avoid duplicate live
  provider calls.
- Status: Added in Phase 9.4B; runtime validation complete.
- Tests: `backend/src/providers/quotes/QuoteSingleFlight.test.ts`.

#### backend/src/providers/quotes/QuoteNegativeCache.ts

- Purpose: Cache short-lived deterministic quote-unavailable evidence separately from successful
  quote results.
- Status: Added in Phase 9.4B; runtime validation complete.
- Tests: `backend/src/providers/quotes/QuoteNegativeCache.test.ts`.

#### backend/src/providers/raydium/RaydiumVenueGuard.ts

- Purpose: Use existing DexScreener pair/venue evidence to avoid implausible Raydium quote probes.
- Status: Added in Phase 9.4B; runtime validation complete.
- Tests: `backend/src/providers/raydium/RaydiumVenueGuard.test.ts`.

#### backend/src/providers/raydium/RaydiumNegativeCache.ts

- Purpose: Retain short-lived Raydium no-pool/no-route evidence so repeated futile probes can be
  skipped safely.
- Status: Added in Phase 9.4B; runtime validation complete.
- Tests: `backend/src/providers/raydium/RaydiumNegativeCache.test.ts`.

## Documentation Update Rule

For Phase 9+, update this file only for new files or meaningful changes made after Phase 8.93.
Historical files remain documented in [Structure.md](./Structure.md).

## Phase 9.4D Implemented Files

#### backend/src/providers/quotes/QuoteBudgetPlanner.ts

- Purpose: Build a deterministic, provider-free, per-risk-batch plan for scarce executable quote
  requests from existing TokenRadar and prior local evidence.
- Status: Implemented and runtime-validated in Phase 9.4D.

#### backend/src/providers/quotes/QuoteBudgetPlanner.test.ts

- Purpose: Verify bounded selection, deterministic ranking, tie-breaking, disabled behavior, and
  no-provider-call planning.
- Status: Implemented and runtime-validated in Phase 9.4D.

#### backend/src/risk/RiskEvaluationService.ts and RiskEvidenceRefreshService.ts

- Purpose: Build one plan per selected risk batch, retain the existing router path for selected
  candidates, and record explicit no-quote allocation evidence for non-selected candidates.
- Status: Modified and runtime-validated in Phase 9.4D.

#### backend/src/analytics, research, terminal-runner, and reporting surfaces

- Purpose: Report planner allocation separately from Jupiter controller deferral, router
  provenance, and provider failure without attributing local non-selection to a provider.
- Status: Modified and runtime-validated in Phase 9.4D.

#### backend/src/research/ResearchRunArchiveLoader.ts

- Purpose: Locate archived TerminalRunner and tail-report artifacts in the nested run-directory
  layout produced by the current validation runbook.
- Status: Corrected during Phase 9.4D closeout; regression test added.

## Phase 9.26 Implemented Files

#### backend/src/research-counterfactual/CounterfactualConfig.ts and CounterfactualTypes.ts

- Purpose: Parse archive-only command options and define the immutable replay, scenario, fidelity,
  outcome, and report contracts.
- Status: Implemented.
- Tests: `CounterfactualConfig.test.ts` and backend typecheck.

#### backend/src/research-counterfactual/CounterfactualScenarioCatalog.ts and CounterfactualReplayService.ts

- Purpose: Maintain the versioned single-intervention scenario catalog and replay persisted
  decision-time score, threshold, eligibility, duplicate, and cap facts without external inputs.
- Status: Implemented.
- Tests: `CounterfactualReplayService.test.ts` and archive-only smoke.

#### backend/src/research-counterfactual/CounterfactualAnalysisService.ts, CounterfactualRunner.ts, and CounterfactualReportFormatter.ts

- Purpose: Load archived PAPER snapshots in read-only mode, summarize post-hoc outcomes and
  concentration, and format bounded text/JSON reports without provider calls or database writes.
- Status: Implemented; archive-smoke validated.
- Tests: Focused unit tests, backend typecheck, and the three-archive Phase 9.4D smoke.

#### backend/src/scripts/research-counterfactual.ts

- Purpose: CLI entrypoint for `pnpm research:counterfactual`.
- Status: Implemented.
- Tests: Archive-only smoke.

#### backend/src/calibration/CalibrationTypes.ts and ScoreAttributionService.ts

- Purpose: Expose persisted historical BUY/WATCH score thresholds for deterministic replay.
- Status: Modified in Phase 9.26.
- Tests: Covered through counterfactual replay tests and backend typecheck.

#### package.json and backend/package.json

- Purpose: Add root and backend `research:counterfactual` command scripts.
- Status: Modified in Phase 9.26.

## H2 Accounting Integrity Implementation

- `backend/src/db/AccountingUnitOfWork.ts`: synchronous immediate transaction and transaction-lifetime repository guards.
- `backend/src/db/repositories/PaperOperationRepository.ts`: durable intent registration, conflict detection and validated terminal replay.
- `backend/src/paper/PaperOperationIdentity.ts` and `PaperOperationResult.ts`: versioned intent/result contracts.
- `backend/src/paper/PaperBuyAccounting.ts` and `PaperSellAccounting.ts`: complete atomic accounting paths used by existing runners and ExitManager.
- `backend/src/paper/PaperReconciliation.ts`: read-only analysis of explicitly supplied consistent scoped snapshots, with bounded discrepancy/incomplete findings.
- `backend/src/db/MigrationContract.ts`, `MigrationReadiness.ts`, and `H2MigrationPreflight.ts`: trusted migration chain, exact schema/readiness and non-repairing preflight.
- `backend/drizzle/0002_h2_accounting_integrity.sql` and metadata: additive migration; only synthetic fixtures have been migrated.
- `backend/vitest.h2.config.ts` and `backend/src/db/h2/`: restricted test harness, native fixture checks, fault injection, read-only reconciliation, independent workers and controlled recovery.
- [H2 verification record](./Phase-10.6H-H2-Verification.md): resumption state, commands, evidence mapping and limits.
- [H2 implementation contract](./Phase-10.6H-H2-Implementation-Contract.md): accepted identity, lifecycle, accounting, merge and reconciliation decisions.
